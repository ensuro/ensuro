// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ILendingPoolAddressesProvider} from "@aave/protocol-v2/contracts/interfaces/ILendingPoolAddressesProvider.sol";
import {ILendingPool} from "@aave/protocol-v2/contracts/interfaces/ILendingPool.sol";
import {IPriceOracle} from "@aave/protocol-v2/contracts/interfaces/IPriceOracle.sol";
import {IAToken} from "@aave/protocol-v2/contracts/interfaces/IAToken.sol";
import {AaveProtocolDataProvider} from "@aave/protocol-v2/contracts/misc/AaveProtocolDataProvider.sol";
import {IUniswapV2Router02} from "@uniswap/v2-periphery/contracts/interfaces/IUniswapV2Router02.sol";
import {IPolicyPool} from "../../interfaces/IPolicyPool.sol";
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

  bytes32 public constant PRICER_ROLE = keccak256("PRICER_ROLE");
  bytes32 public constant TRIGGER_ROLE = keccak256("TRIGGER_ROLE");

  uint8 public constant PRICE_SLOTS = 30;
  uint256 public constant PAYOUT_BUFFER = 2e16; // 2%

  bytes32 internal constant DATA_PROVIDER_ID =
    0x0100000000000000000000000000000000000000000000000000000000000000;

  /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
  ILendingPoolAddressesProvider internal immutable _aaveAddrProv;
  /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
  IERC20Metadata internal immutable _collateralAsset;
  /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
  IAToken internal immutable _collateralAToken;
  /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
  IAToken internal immutable _currencyAToken;
  /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
  IUniswapV2Router02 internal immutable _swapRouter; // We will use SushiSwap in Polygon

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

  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor(
    IPolicyPool policyPool_,
    ILendingPoolAddressesProvider aaveAddrProv_,
    IERC20Metadata collateralAsset_,
    IUniswapV2Router02 swapRouter_
  ) RiskModule(policyPool_) {
    _collateralAsset = collateralAsset_;
    _swapRouter = swapRouter_;
    _aaveAddrProv = aaveAddrProv_;
    _internalId = 1;

    AaveProtocolDataProvider dataProvider = AaveProtocolDataProvider(
      aaveAddrProv_.getAddress(DATA_PROVIDER_ID)
    );
    (address aToken_, , ) = dataProvider.getReserveTokensAddresses(address(policyPool_.currency()));
    _currencyAToken = IAToken(aToken_);
    (address colateralAToken, , ) = dataProvider.getReserveTokensAddresses(
      address(collateralAsset_)
    );
    _collateralAToken = IAToken(colateralAToken);
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
    // Approve transfer from this RiskModule, because it will be used to pay the premium
    currency().approve(address(policyPool()), type(uint256).max);
  }

  function lendingPool() public view returns (ILendingPool) {
    return ILendingPool(_aaveAddrProv.getLendingPool());
  }

  function priceOracle() public view returns (IPriceOracle) {
    return IPriceOracle(_aaveAddrProv.getPriceOracle());
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
    ILendingPool aave = lendingPool();
    (, , , , , uint256 currentHF) = aave.getUserAccountData(customer);
    require(currentHF > triggerHF, "Current Health Factor already under trigger value");
    uint256[PRICE_SLOTS] storage pdf = _pdf[expiration - uint40(block.timestamp)];
    require(pdf[0] != 0 || pdf[19] != 0, "Duration not supported!");
    uint256 downJump = WadRayMath.wad() - triggerHF.wadDiv(currentHF);
    // Calculate the down percentage as integer with simetric rounding
    uint8 downPerc = uint8((downJump + WadRayMath.halfWad()) / 1e16);
    if (downPerc >= PRICE_SLOTS) {
      lossProb = pdf[PRICE_SLOTS - 1];
    } else {
      for (uint8 i = downPerc; i < PRICE_SLOTS; i++) {
        lossProb += pdf[i];
      }
    }
    payout = _calculatePayout(customer, downJump, triggerHF, payoutHF);
    premium = getMinimumPremium(payout, lossProb, expiration);
    return (payout, premium, lossProb);
  }

  function _collateralToCurrency(uint256 amount) internal view returns (uint256) {
    IPriceOracle oracle = priceOracle();
    IERC20Metadata from_ = _collateralAsset;
    IERC20Metadata to_ = currency();
    uint256 exchangeRate = oracle.getAssetPrice(address(from_)).wadDiv(
      oracle.getAssetPrice(address(to_))
    );
    if (from_.decimals() > to_.decimals()) {
      exchangeRate /= 10**(from_.decimals() - to_.decimals());
    } else {
      exchangeRate *= 10**(from_.decimals() - to_.decimals());
    }
    return amount.wadMul(exchangeRate);
  }

  function _calculatePayout(
    address customer,
    uint256 downJump,
    uint256 triggerHF,
    uint256 payoutHF
  ) internal view returns (uint256) {
    uint256 collateralPayout = (payoutHF.wadDiv(triggerHF) - WadRayMath.wad()) *
      _collateralAToken.balanceOf(customer);
    return _collateralToCurrency(collateralPayout).wadMul(downJump + PAYOUT_BUFFER);
  }

  function newPolicy(
    uint40 expiration,
    address customer,
    uint256 triggerHF,
    uint256 payoutHF
  ) external onlyRole(PRICER_ROLE) returns (uint256) {
    (uint256 payout, uint256 premium, uint256 lossProb) = pricePolicy(
      customer,
      triggerHF,
      payoutHF,
      expiration
    );
    currency().safeTransferFrom(customer, address(this), premium);
    Policy.PolicyData memory policy = _newPolicy(
      payout,
      premium,
      lossProb,
      expiration,
      address(this),
      _internalId
    );
    _internalId += 1;
    PolicyData storage liqProtectionPolicy = _policies[policy.id];
    liqProtectionPolicy.ensuroPolicy = policy;
    liqProtectionPolicy.customer = customer;
    liqProtectionPolicy.triggerHF = triggerHF;
    liqProtectionPolicy.payoutHF = payoutHF;
    return policy.id;
  }

  function triggerPolicy(uint256 policyId) external onlyRole(TRIGGER_ROLE) whenNotPaused {}
}
