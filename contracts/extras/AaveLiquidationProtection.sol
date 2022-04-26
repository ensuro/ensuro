// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ILendingPoolAddressesProvider} from "@aave/protocol-v2/contracts/interfaces/ILendingPoolAddressesProvider.sol";
import {ILendingPool} from "@aave/protocol-v2/contracts/interfaces/ILendingPool.sol";
import {IPriceOracle} from "@aave/protocol-v2/contracts/interfaces/IPriceOracle.sol";
import {PercentageMath} from "@aave/protocol-v2/contracts/protocol/libraries/math/PercentageMath.sol";
import {IPriceRiskModule} from "./IPriceRiskModule.sol";
import {Policy} from "../Policy.sol";
import {WadRayMath} from "../WadRayMath.sol";

/**
 * @title Trustful Risk Module
 * @dev Risk Module without any validation, just the newPolicy and resolvePolicy need to be called by
        authorized users
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
abstract contract AaveLiquidationProtection is Initializable, OwnableUpgradeable, UUPSUpgradeable {
  using SafeERC20 for IERC20Metadata;
  using WadRayMath for uint256;
  using PercentageMath for uint256;

  uint256 private constant PAYOUT_BUFFER = 2e16; // 2%
  uint256 private constant LIQUIDATION_THRESHOLD_MASK = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0000FFFF; // prettier-ignore
  uint256 private constant LIQUIDATION_THRESHOLD_START_BIT_POSITION = 16;

  /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
  ILendingPool internal immutable _aave;
  /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
  IPriceRiskModule internal immutable _priceInsurance;
  /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
  IERC20Metadata internal immutable _collAsset;
  /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
  IERC20Metadata internal immutable _borrowAsset;

  struct Parameters {
    uint256 triggerHF;
    uint256 safeHF;
    uint256 deinvestHF;
    uint256 investHF;
    uint40 policyDuration;
  }

  Parameters internal _params;

  uint256 internal _activePolicyId;
  uint40 internal _activePolicyExpiration;

  /**
   * @dev Constructs the AaveLiquidationProtection
   * @param priceInsurance_ The Price Risk Module
   * @param aaveAddrProv_ AAVE address provider, the index to access AAVE's contracts
   */
  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor(IPriceRiskModule priceInsurance_, ILendingPoolAddressesProvider aaveAddrProv_) {
    ILendingPool aave = ILendingPool(aaveAddrProv_.getLendingPool());
    _aave = aave;
    _priceInsurance = priceInsurance_;
    _collAsset = priceInsurance_.asset();
    _borrowAsset = priceInsurance_.referenceCurrency();
  }

  /**
   * @dev Initializes the protection contract
   * @param params_ Investment / insurance parameters
   */
  // solhint-disable-next-line func-name-mixedcase
  function __AaveLiquidationProtection_init(Parameters memory params_) internal initializer {
    __Ownable_init();
    __UUPSUpgradeable_init();
    __AaveLiquidationProtection_init_unchained(params_);
  }

  // solhint-disable-next-line func-name-mixedcase
  function __AaveLiquidationProtection_init_unchained(Parameters memory params_)
    internal
    initializer
  {
    _params = params_;
    _collAsset.approve(address(_aave), type(uint256).max);
    _borrowAsset.approve(address(_aave), type(uint256).max);
    _validateParameters();
  }

  function _validateParameters() internal view virtual {
    require(_params.triggerHF < _params.safeHF, "triggerHF >= safeHF!");
    require(_params.safeHF < _params.deinvestHF, "safeHF >= deinvestHF!");
    require(_params.deinvestHF < _params.investHF, "deinvestHF >= investHF!");
  }

  // solhint-disable-next-line no-empty-blocks
  function _authorizeUpgrade(address) internal override onlyOwner {}

  function _getHealthFactor() internal view returns (uint256) {
    (, , , , , uint256 currentHF) = _aave.getUserAccountData(address(this));
    return currentHF;
  }

  /**
   * @dev Receives the collateral from sender, deposits it into AAVE and, optionally, executes the checkpoint
   * @param amount Amount to transfer from sender's address
   * @param doCheckpoint Boolean, indicates if calling checkpoint after the deposit
   */
  function depositCollateral(uint256 amount, bool doCheckpoint) external {
    _collAsset.safeTransferFrom(msg.sender, address(this), amount);
    _aave.deposit(address(_collAsset), _collAsset.balanceOf(address(this)), address(this), 0);
    if (doCheckpoint) {
      checkpoint();
    }
  }

  /**
   * @dev Withdraws the collateral
   * @param amount Amount to transfer from sender's address
   * @param doCheckpoint Boolean, indicates if calling checkpoint after the withdraw
   */
  function withdrawCollateral(uint256 amount, bool doCheckpoint)
    external
    onlyOwner
    returns (uint256)
  {
    uint256 withdrawalAmount = _aave.withdraw(address(_collAsset), amount, msg.sender);
    if (doCheckpoint) {
      checkpoint();
    }
    return withdrawalAmount;
  }

  /**
   * @dev Check actual health factor and based on the parameters acts in consequence
   */
  function checkpoint() public {
    uint256 hf = _getHealthFactor();
    if (hf > _params.investHF) {
      // Borrow stable, insure against liquidation and invest
      _borrow(_params.investHF);
      _insure();
      _invest();
    } else if (hf > _params.deinvestHF) {
      _insure();
    } else if (hf <= _params.deinvestHF) {
      _repay(_params.investHF);
      _insure();
    }
  }

  /**
   * @dev Withdraws all the funds
   */
  function withdrawAll() external onlyOwner returns (uint256, uint256) {
    _repay(type(uint256).max);
    _deinvest(type(uint256).max);
    uint256 withdrawalAmount = _aave.withdraw(address(_collAsset), type(uint256).max, msg.sender);
    uint256 borrowAssetAmount = _borrowAsset.balanceOf(address(this));
    _borrowAsset.safeTransfer(msg.sender, borrowAssetAmount);
    return (withdrawalAmount, borrowAssetAmount);
  }

  function _borrow(uint256 targetHF) internal {
    IPriceOracle oracle = IPriceOracle(_aave.getAddressesProvider().getPriceOracle());
    IERC20Metadata variableDebtToken = IERC20Metadata(
      _aave.getReserveData(address(_borrowAsset)).variableDebtTokenAddress
    );
    uint256 currentDebt = variableDebtToken.balanceOf(address(this));
    uint256 collateralInEth = (IERC20Metadata(
      _aave.getReserveData(address(_collAsset)).aTokenAddress
    ).balanceOf(address(this)) * oracle.getAssetPrice(address(_collAsset))) /
      10**_collAsset.decimals();
    uint256 targetDebt = collateralInEth.percentMul(_liqThreshold()).wadDiv(targetHF);
    if (targetDebt < currentDebt)
      _aave.borrow(address(_collAsset), targetDebt - currentDebt, 2, 0, address(this));
  }

  // solhint-disable-next-line no-empty-blocks
  function _insure() internal {}

  // solhint-disable-next-line no-empty-blocks
  function _repay(uint256 targetHF) internal {}

  function _invest() internal virtual;

  function _deinvest(uint256 amount) internal virtual;

  function _liqThreshold() internal view returns (uint256) {
    return
      (_aave.getReserveData(address(_collAsset)).configuration.data &
        ~LIQUIDATION_THRESHOLD_MASK) >> LIQUIDATION_THRESHOLD_START_BIT_POSITION;
  }

  /**
   * @dev Returns the payout, premium and lossProb of the policy
   * @param customer Address of the user that has assets in AAVE
   * @param triggerHF Health factor from which the payout can be triggered (in wad)
   * @param payoutHF Target health factor to take the account after the payout (in wad)
   * @param expiration Expiration of the policy
   * @return payout Maximum payout in USDC
   * @return premium Premium that needs to be paid
   * @return lossProb Probability of paying the maximum payout
  function pricePolicy(
    address customer,
    uint256 triggerHF,
    uint256 payoutHF,
    uint40 expiration
  )
    public
    view
    returns (
      uint256 payout,
      uint256 premium,
      uint256 lossProb
    )
  {
    uint256 currentHF = _getHealthFactor(customer);
    require(currentHF > triggerHF, "HF already under trigger value");
    uint256 downJump = WadRayMath.wad() - triggerHF.wadDiv(currentHF);
    lossProb = _computeLossProb(downJump, expiration - uint40(block.timestamp));
    payout = _collateralToCurrency(
      _priceOracle,
      _collateralAsset,
      currency(),
      _requiredCollateral(customer, triggerHF, payoutHF)
    ).wadMul(downJump + PAYOUT_BUFFER);
    premium = getMinimumPremium(payout, lossProb, expiration);
    return (payout, premium, lossProb);
  }
   */
  /*
  function _collateralToCurrency(
    IPriceOracle oracle,
    IERC20Metadata from_,
    IERC20Metadata to_,
    uint256 amount
  ) internal view returns (uint256) {
    uint256 exchangeRate = oracle.getAssetPrice(address(from_)).wadDiv(
      _priceOracle.getAssetPrice(address(to_))
    );
    if (from_.decimals() > to_.decimals()) {
      exchangeRate /= 10**(from_.decimals() - to_.decimals());
    } else {
      exchangeRate *= 10**(from_.decimals() - to_.decimals());
    }
    return amount.wadMul(exchangeRate);
  }

  function _requiredCollateral(
    address user,
    uint256 fromHF,
    uint256 toHF
  ) internal view returns (uint256) {
    return
      IERC20Metadata(_aave.getReserveData(address(_collateralAsset)).aTokenAddress)
        .balanceOf(user)
        .wadMul(toHF.wadDiv(fromHF) - WadRayMath.wad());
  }

  function triggerPolicy(uint256 policyId) external whenNotPaused {
    PolicyData storage policy = _policies[policyId];
    uint256 currentHF = _getHealthFactor(policy.customer);
    require(currentHF <= policy.triggerHF, "Trigger condition not met HF > triggerHF");

    // Compute collateral we need to acquire and amount of money required
    uint256 collateralPayout = _requiredCollateral(policy.customer, currentHF, policy.payoutHF);
    uint256 requiredMoney = _collateralToCurrency(
      _priceOracle,
      _collateralAsset,
      currency(),
      collateralPayout
    );

    // Resolve the policy with full payout - Money comes to address(this)
    // .wallet() will keep the change if less money required
    _policyPool.resolvePolicy(policy.ensuroPolicy, policy.ensuroPolicy.payout);

    // Acquire the collateral - required money might be less or more than payout
    // If MORE, the transaction will probably fail, unless some charitative soul
    // sends some money to address(this) to have a buffer for these situations
    address[] memory path = new address[](2);
    path[0] = address(currency());
    path[1] = address(_collateralAsset);
    uint256[] memory amounts = _swapRouter.swapTokensForExactTokens(
      requiredMoney.wadMul(_maxSlippage),
      collateralPayout,
      path,
      address(this),
      block.timestamp
    );
    if (amounts[0] < policy.ensuroPolicy.payout) {
      currency().safeTransfer(wallet(), policy.ensuroPolicy.payout - amounts[0]);
    }
    _aave.deposit(address(_collateralAsset), collateralPayout, policy.customer, 0);
  }
  DISABLED TEMPORARILY TO AVOID CONTRACT SIZE ERROR
*/
}
