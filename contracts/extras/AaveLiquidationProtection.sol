// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ILendingPoolAddressesProvider} from "@aave/protocol-v2/contracts/interfaces/ILendingPoolAddressesProvider.sol";
import {ILendingPool} from "@aave/protocol-v2/contracts/interfaces/ILendingPool.sol";
import {IPriceOracle} from "@aave/protocol-v2/contracts/interfaces/IPriceOracle.sol";
import {IUniswapV2Router02} from "@uniswap/v2-periphery/contracts/interfaces/IUniswapV2Router02.sol";
import {IPolicyPool} from "../../interfaces/IPolicyPool.sol";
import {IPolicyPoolConfig} from "../../interfaces/IPolicyPoolConfig.sol";
import {RiskModule} from "../RiskModule.sol";
import {Policy} from "../Policy.sol";
import {WadRayMath} from "../WadRayMath.sol";

/**
 * @title Trustful Risk Module
 * @dev Risk Module without any validation, just the newPolicy and resolvePolicy need to be called by
        authorized users
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */

contract AaveLiquidationProtection is RiskModule {
  using SafeERC20 for IERC20Metadata;
  using WadRayMath for uint256;

  bytes32 public constant CUSTOMER_ROLE = keccak256("CUSTOMER_ROLE");
  bytes32 public constant PRICER_ROLE = keccak256("PRICER_ROLE");

  uint8 public constant PRICE_SLOTS = 30;
  uint256 public constant PAYOUT_BUFFER = 2e16; // 2%

  /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
  ILendingPool internal immutable _aave;
  /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
  IPriceOracle internal immutable _priceOracle;
  /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
  IERC20Metadata internal immutable _collateralAsset;
  /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
  IUniswapV2Router02 internal immutable _swapRouter; // We will use SushiSwap in Polygon
  /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
  uint256 internal immutable _maxSlippage; // Maximum slippage in WAD

  struct PolicyData {
    Policy.PolicyData ensuroPolicy;
    address customer;
    uint256 triggerHF;
    uint256 payoutHF;
  }

  mapping(uint256 => PolicyData) internal _policies;

  // Duration of the protection => probability density function
  //   [0] = prob of ([0, -1%)
  //   [1] = prob of ([-1, -2%)
  //   ...
  //   [19] = prob of ([-19, -infinite%)
  mapping(uint40 => uint256[PRICE_SLOTS]) internal _pdf;

  uint96 internal _internalId;

  event NewProtection(
    address indexed customer,
    uint256 policyId,
    uint256 triggerHF,
    uint256 payoutHF
  );

  /**
   * @dev Constructs the LiquidationProtectionRiskModule
   * @param policyPool_ The policyPool
   * @param aaveAddrProv_ AAVE address provider, the index to access AAVE's contracts
   * @param collateralAsset_ Address of the collateral protected
   * @param swapRouter_ Address of the Uniswap or SushiSwap DEX
   * @param maxSlippage_ Max splippage when acquiring collateral
   */
  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor(
    IPolicyPool policyPool_,
    ILendingPoolAddressesProvider aaveAddrProv_,
    IERC20Metadata collateralAsset_,
    IUniswapV2Router02 swapRouter_,
    uint256 maxSlippage_
  ) RiskModule(policyPool_) {
    _collateralAsset = collateralAsset_;
    _swapRouter = swapRouter_;
    ILendingPool aave = ILendingPool(aaveAddrProv_.getLendingPool());
    _aave = aave;
    _priceOracle = IPriceOracle(aaveAddrProv_.getPriceOracle());
    require(maxSlippage_ <= 1.1e18 && maxSlippage_ > 1e18, "maxSlippage can't be more than 10%");
    _maxSlippage = maxSlippage_;
  }

  /**
   * @dev Initializes the RiskModule
   * @param name_ Name of the Risk Module
   * @param scrPercentage_ Solvency Capital Requirement percentage, to calculate
                          capital requirement as % of (payout - premium)  (in ray)
   * @param ensuroFee_ % of premium that will go for Ensuro treasury (in ray)
   * @param scrInterestRate_ cost of capital (in ray)
   * @param maxScrPerPolicy_ Max SCR to be allocated to this module (in wad)
   * @param scrLimit_ Max SCR to be allocated to this module (in wad)
   * @param wallet_ Address of the RiskModule provider
   */
  function initialize(
    string memory name_,
    uint256 scrPercentage_,
    uint256 ensuroFee_,
    uint256 scrInterestRate_,
    uint256 maxScrPerPolicy_,
    uint256 scrLimit_,
    address wallet_
  ) public initializer {
    __RiskModule_init(
      name_,
      scrPercentage_,
      ensuroFee_,
      scrInterestRate_,
      maxScrPerPolicy_,
      scrLimit_,
      wallet_
    );
    _internalId = 1;
    // Approve transfer from this RiskModule, because it will be used to pay the premium
    currency().approve(address(policyPool()), type(uint256).max);
    // Approve transfer from this RiskModule to AAVE because it will be used for collateral payouts
    _collateralAsset.approve(address(_aave), type(uint256).max);
  }

  function _getHealthFactor(address user) internal view returns (uint256) {
    (, , , , , uint256 currentHF) = _aave.getUserAccountData(user);
    return currentHF;
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
   */
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

  function _computeLossProb(uint256 downJump, uint40 duration) internal view returns (uint256) {
    uint256[PRICE_SLOTS] storage pdf = _pdf[duration];
    require(pdf[0] != 0 || pdf[19] != 0, "Duration not supported!");
    // Calculate the down percentage as integer with simetric rounding
    uint8 downPerc = uint8((downJump + WadRayMath.halfWad()) / 1e16);
    if (downPerc >= PRICE_SLOTS) {
      return pdf[PRICE_SLOTS - 1];
    } else {
      uint256 ret;
      for (uint8 i = downPerc; i < PRICE_SLOTS; i++) {
        ret += pdf[i];
      }
      return ret;
    }
  }

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

  function newPolicy(
    uint40 expiration,
    address customer,
    uint256 triggerHF,
    uint256 payoutHF
  ) external onlyRole(CUSTOMER_ROLE) returns (uint256) {
    /*
     * For now, customer needs to be whitelisted (CUSTOMER_ROLE)
     * because we can't control if after buying the policy it will do
     * operations like borrowing more or withdrawing collateral to
     * decrease the health factor. So, only whitelisted contracts
     * that can't do these operations will be allowed
     */
    (uint256 payout, uint256 premium, uint256 lossProb) = pricePolicy(
      customer,
      triggerHF,
      payoutHF,
      expiration
    );
    currency().safeTransferFrom(customer, address(this), premium);
    uint256 policyId = (uint256(uint160(address(this))) << 96) + _internalId;
    PolicyData storage liqProtectionPolicy = _policies[policyId];
    liqProtectionPolicy.ensuroPolicy = _newPolicy(
      payout,
      premium,
      lossProb,
      expiration,
      address(this),
      _internalId
    );
    _internalId += 1;
    liqProtectionPolicy.customer = customer;
    liqProtectionPolicy.triggerHF = triggerHF;
    liqProtectionPolicy.payoutHF = payoutHF;
    emit NewProtection(customer, policyId, triggerHF, payoutHF);
    return policyId;
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

  function setPDF(uint40 duration, uint256[PRICE_SLOTS] calldata pdf)
    external
    onlyRole(PRICER_ROLE)
    whenNotPaused
  {
    _pdf[duration] = pdf;
  }

  /*  function maxSlippage() external view returns (uint256) {
    return _maxSlippage;
  }

  function setMaxSlippage(uint256 newValue) external onlyPoolRole2(LEVEL2_ROLE, LEVEL3_ROLE) {
    require(newValue <= 1e17, "maxSlippage can't be more than 10%");
    bool tweak = !hasPoolRole(LEVEL2_ROLE);
    require(
      !tweak || _isTweakWad(_maxSlippage, newValue, 3e26),
      "Tweak exceeded: maxSlippage tweaks only up to 30%"
    );
    _maxSlippage = newValue;
    _parameterChanged(IPolicyPoolConfig.GovernanceActions.setMaxSlippage, newValue, tweak);
  }*/
}
