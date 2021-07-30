// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {WadRayMath} from "./WadRayMath.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPolicyPool} from "../interfaces/IPolicyPool.sol";
import {IPolicyPoolComponent} from "../interfaces/IPolicyPoolComponent.sol";
import {IAssetManager} from "../interfaces/IAssetManager.sol";
import {IEToken} from "../interfaces/IEToken.sol";
import {Policy} from "./Policy.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title Ensuro Asset Manager base contract
 * @dev Base class for asset managers that implement
 * @author Ensuro
 */
abstract contract BaseAssetManager is
  IAssetManager,
  UUPSUpgradeable,
  AccessControlUpgradeable,
  PausableUpgradeable,
  IPolicyPoolComponent
{
  using WadRayMath for uint256;

  // For parameters that can be changed by Ensuro
  bytes32 public constant ENSURO_DAO_ROLE = keccak256("ENSURO_DAO_ROLE");
  bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
  bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
  // This user can trigger rebalance and distibuteEarnings
  bytes32 public constant CHECKPOINT_ROLE = keccak256("CHECKPOINT_ROLE");

  IPolicyPool internal _policyPool;
  int256 internal _cashBalance;
  uint256 internal _liquidityMin;
  uint256 internal _liquidityMiddle;
  uint256 internal _liquidityMax;

  uint256 internal _lastInvestmentValue;

  event MoneyInvested(uint256 amount);
  event MoneyDeinvested(uint256 amount);
  event EarningsDistributed(bool positive, uint256 amount);

  modifier onlyPolicyPool {
    require(_msgSender() == address(_policyPool), "The caller must be the PolicyPool");
    _;
  }

  /**
   * @dev Initializes the asset manager
   * @param policyPool_ The address of the Ensuro PolicyPool where this module is plugged
   * @param liquidityMin_ Minimal liquidity to keep in pool's wallet
   * @param liquidityMiddle_ Target liquidity when doing rebalance
   * @param liquidityMax_ Maximum liquidity to keep in pool's wallet
   */
  // solhint-disable-next-line func-name-mixedcase
  function __BaseAssetManager_init(
    IPolicyPool policyPool_,
    uint256 liquidityMin_,
    uint256 liquidityMiddle_,
    uint256 liquidityMax_
  ) public initializer {
    __AccessControl_init();
    __Pausable_init();
    __UUPSUpgradeable_init();
    __BaseAssetManager_init_unchained(policyPool_, liquidityMin_, liquidityMiddle_, liquidityMax_);
  }

  // solhint-disable-next-line func-name-mixedcase
  function __BaseAssetManager_init_unchained(
    IPolicyPool policyPool_,
    uint256 liquidityMin_,
    uint256 liquidityMiddle_,
    uint256 liquidityMax_
  ) public initializer {
    _setupRole(DEFAULT_ADMIN_ROLE, msg.sender);
    _policyPool = policyPool_;
    /*
    _cashBalance = 0;
    _lastInvestmentValue = 0;
    */
    require(
      liquidityMin_ <= liquidityMiddle_ && liquidityMiddle_ <= liquidityMax_,
      "Liquidity limits are invalid"
    );
    _liquidityMin = liquidityMin_;
    _liquidityMiddle = liquidityMiddle_;
    _liquidityMax = liquidityMax_;
  }

  // solhint-disable-next-line no-empty-blocks
  function _authorizeUpgrade(address) internal override onlyRole(UPGRADER_ROLE) {}

  function policyPool() public view override returns (IPolicyPool) {
    return _policyPool;
  }

  function _currency() internal view returns (IERC20) {
    return _policyPool.currency();
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
  function distibuteEarnings() public virtual whenNotPaused onlyRole(CHECKPOINT_ROLE) {
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
  function rebalance() public virtual whenNotPaused onlyRole(CHECKPOINT_ROLE) {
    uint256 poolCash = _currency().balanceOf(address(_policyPool));
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
    uint256 poolCash = _currency().balanceOf(address(_policyPool));
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
}
