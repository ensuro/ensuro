// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {WadRayMath} from "./WadRayMath.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPolicyPool} from "../interfaces/IPolicyPool.sol";
import {PolicyPoolComponent} from "./PolicyPoolComponent.sol";
import {IAssetManager} from "../interfaces/IAssetManager.sol";
import {IEToken} from "../interfaces/IEToken.sol";
import {IPolicyPoolConfig} from "../interfaces/IPolicyPoolConfig.sol";
import {Policy} from "./Policy.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title Ensuro Asset Manager base contract
 * @dev Base class for asset managers that implement
 * @author Ensuro
 */
abstract contract BaseAssetManager is IAssetManager, PolicyPoolComponent {
  using WadRayMath for uint256;

  int256 internal _cashBalance;
  uint256 internal _liquidityMin;
  uint256 internal _liquidityMiddle;
  uint256 internal _liquidityMax;

  uint256 internal _lastInvestmentValue;

  event MoneyInvested(uint256 amount);
  event MoneyDeinvested(uint256 amount);
  event EarningsDistributed(bool positive, uint256 amount);

  modifier validateParamsAfterChange() {
    _;
    _validateParameters();
  }

  /// @custom:oz-upgrades-unsafe-allow constructor
  // solhint-disable-next-line no-empty-blocks
  constructor(IPolicyPool policyPool_) PolicyPoolComponent(policyPool_) {}

  /**
   * @dev Initializes the asset manager
   * @param liquidityMin_ Minimal liquidity to keep in pool's wallet
   * @param liquidityMiddle_ Target liquidity when doing rebalance
   * @param liquidityMax_ Maximum liquidity to keep in pool's wallet
   */
  // solhint-disable-next-line func-name-mixedcase
  function __BaseAssetManager_init(
    uint256 liquidityMin_,
    uint256 liquidityMiddle_,
    uint256 liquidityMax_
  ) public initializer {
    __PolicyPoolComponent_init();
    __BaseAssetManager_init_unchained(liquidityMin_, liquidityMiddle_, liquidityMax_);
  }

  // solhint-disable-next-line func-name-mixedcase
  function __BaseAssetManager_init_unchained(
    uint256 liquidityMin_,
    uint256 liquidityMiddle_,
    uint256 liquidityMax_
  ) public initializer {
    /*
    _cashBalance = 0;
    _lastInvestmentValue = 0;
    */
    _liquidityMin = liquidityMin_;
    _liquidityMiddle = liquidityMiddle_;
    _liquidityMax = liquidityMax_;
    _validateParameters();
  }

  function _validateParameters() internal view {
    require(
      _liquidityMin <= _liquidityMiddle && _liquidityMiddle <= _liquidityMax,
      "Validation: Liquidity limits are invalid"
    );
  }

  /**
   * @dev Returns the total amount that is available to invest by the asset manager
   */
  function totalInvestable() external view returns (uint256) {
    (uint256 poolInvestable, uint256 etksInvestable) = _totalInvestable();
    return poolInvestable + etksInvestable;
  }

  function _totalInvestable() internal view returns (uint256, uint256) {
    uint256 poolInvestable = _policyPool.getInvestable();
    uint256 etksInvestable = 0;
    for (uint256 i = 0; i < _policyPool.getETokenCount(); i++) {
      IEToken etk = _policyPool.getETokenAt(i);
      etksInvestable += etk.getInvestable();
    }
    return (poolInvestable, etksInvestable);
  }

  /**
   * @dev Calculates asset earnings and distributes them updating accounting in PolicyPool and eTokens
   */
  function distibuteEarnings() public virtual whenNotPaused {
    // TODO Check: Anyone can call this funcion. This could be a potencial surface of flash loan attack?
    uint256 investmentValue = getInvestmentValue();
    bool positive;
    uint256 earnings;
    if (investmentValue > _lastInvestmentValue) {
      earnings = investmentValue - _lastInvestmentValue;
      positive = true;
    } else if (investmentValue < _lastInvestmentValue) {
      earnings = _lastInvestmentValue - investmentValue;
      positive = false;
    } else {
      return; // No earnings
    }

    (uint256 poolInvestable, uint256 etksInvestable) = _totalInvestable();
    uint256 totalInv = poolInvestable + etksInvestable;

    _policyPool.assetEarnings(earnings.wadMul(poolInvestable).wadDiv(totalInv), positive);

    for (uint256 i = 0; i < _policyPool.getETokenCount(); i++) {
      IEToken etk = _policyPool.getETokenAt(i);
      etk.assetEarnings(earnings.wadMul(etk.getInvestable()).wadDiv(totalInv), positive);
    }
    _lastInvestmentValue = investmentValue;
    emit EarningsDistributed(positive, earnings);
  }

  /**
   * @dev Returns the current value of the investment portfolio
   */
  function getInvestmentValue() public view virtual returns (uint256);

  /**
   * @dev Rebalances cash between PolicyPool wallet and
   */
  function rebalance() public virtual whenNotPaused {
    // TODO Check: Anyone can call this funcion. This could be a potencial surface of flash loan attack?
    uint256 poolCash = currency().balanceOf(address(_policyPool));
    if (poolCash > _liquidityMax) {
      _invest(poolCash - _liquidityMiddle);
    } else if (poolCash < _liquidityMin) {
      _deinvest(_liquidityMiddle - poolCash);
    }
  }

  /**
   * @dev Function to be called automatically by a crontask - Distributes and rebalances
   */
  function checkpoint() external {
    distibuteEarnings();
    rebalance();
  }

  /**
   * @dev This is called from PolicyPool when doesn't have enought money for payment.
   *      After the call, there should be enought money in PolicyPool.currency().balanceOf(this) to
   *      do the payment
   * @param paymentAmount The amount of the payment
   */
  function refillWallet(uint256 paymentAmount) external override onlyPolicyPool {
    uint256 poolCash = currency().balanceOf(address(_policyPool));
    require(poolCash < paymentAmount, "No need to refill the wallet for this payment");
    uint256 investmentValue = getInvestmentValue();
    // try to leave the pool balance at liquidity_middle after the payment
    uint256 deinvest = paymentAmount + _liquidityMiddle - poolCash;
    if (deinvest > investmentValue) deinvest = investmentValue;
    _deinvest(deinvest);
  }

  function _invest(uint256 amount) internal virtual {
    _cashBalance += int256(amount);
    _lastInvestmentValue += amount;
    emit MoneyInvested(amount);
    // must be reimplemented do the actual cash movement
  }

  function _deinvest(uint256 amount) internal virtual {
    _cashBalance -= int256(amount);
    _lastInvestmentValue -= Math.min(_lastInvestmentValue, amount);
    emit MoneyDeinvested(amount);
    // must be reimplemented do the actual cash movement
  }

  /**
   * @dev Deinvest all the assets and return the cash back to the PolicyPool.
   *      Called from PolicyPool when new asset manager is assigned
   */
  function deinvestAll() external virtual override onlyPolicyPool {
    _deinvest(getInvestmentValue());
  }

  function liquidityMin() external view returns (uint256) {
    return _liquidityMin;
  }

  function liquidityMiddle() external view returns (uint256) {
    return _liquidityMiddle;
  }

  function liquidityMax() external view returns (uint256) {
    return _liquidityMax;
  }

  function setLiquidityMin(uint256 newValue)
    external
    onlyPoolRole2(LEVEL2_ROLE, LEVEL3_ROLE)
    validateParamsAfterChange
  {
    bool tweak = !hasPoolRole(LEVEL2_ROLE);
    require(
      !tweak || _isTweakRay(_liquidityMin, newValue, 3e26),
      "Tweak exceeded: liquidityMin tweaks only up to 30%"
    );
    _liquidityMin = newValue;
    _parameterChanged(IPolicyPoolConfig.GovernanceActions.setLiquidityMin, newValue, tweak);
  }

  function setLiquidityMiddle(uint256 newValue)
    external
    onlyPoolRole2(LEVEL2_ROLE, LEVEL3_ROLE)
    validateParamsAfterChange
  {
    bool tweak = !hasPoolRole(LEVEL2_ROLE);
    require(
      !tweak || _isTweakRay(_liquidityMiddle, newValue, 3e26),
      "Tweak exceeded: liquidityMiddle tweaks only up to 30%"
    );
    _liquidityMiddle = newValue;
    _parameterChanged(IPolicyPoolConfig.GovernanceActions.setLiquidityMiddle, newValue, tweak);
  }

  function setLiquidityMax(uint256 newValue)
    external
    onlyPoolRole2(LEVEL2_ROLE, LEVEL3_ROLE)
    validateParamsAfterChange
  {
    bool tweak = !hasPoolRole(LEVEL2_ROLE);
    require(
      !tweak || _isTweakRay(_liquidityMax, newValue, 3e26),
      "Tweak exceeded: liquidityMax tweaks only up to 30%"
    );
    _liquidityMax = newValue;
    _parameterChanged(IPolicyPoolConfig.GovernanceActions.setLiquidityMax, newValue, tweak);
  }
}
