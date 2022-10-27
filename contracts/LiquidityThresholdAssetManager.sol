// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IPolicyPoolComponent} from "./interfaces/IPolicyPoolComponent.sol";
import {IAssetManager} from "./interfaces/IAssetManager.sol";
import {IAccessManager} from "./interfaces/IAccessManager.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title Base class for asset management strategies that use thresholds for cash and investment balance
 * @dev Base class for asset management strategies that use thresholds for cash and investment balance.
 *      The specific asset management strategy needs to be implemented by child contracts.
 *      Settings liquidityMin, liquidityMiddle, liquidityMax are the thresholds used to define how much liquidity
 *      to keep in the PolicyPool and when to invest/deinvest. Every invest/deinvest operation tries to leave the
 *      cash at liquidityMiddle.
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 *
 * @notice This contracts uses Diamond Storage and should not define state variables outside of that. See the diamondStorage method for more details.
 */
abstract contract LiquidityThresholdAssetManager is IAssetManager {
  using SafeCast for uint256;

  IERC20Metadata internal immutable _asset;
  event GovernanceAction(IAccessManager.GovernanceActions indexed action, uint256 value);

  struct DiamondStorage {
    uint32 liquidityMin; // stored with 0 decimals
    uint32 liquidityMiddle; // stored with 0 decimals
    uint32 liquidityMax; // stored with 0 decimals
    uint128 lastInvestmentValue;
  }

  modifier validateParamsAfterChange() {
    _;
    _validateParameters();
  }

  constructor(IERC20Metadata asset_) {
    _asset = asset_;
  }

  function diamondStorage() internal pure returns (DiamondStorage storage ds) {
    // Inspired from https://eips.ethereum.org/EIPS/eip-2535#facets-state-variables-and-diamond-storage
    // Set the position of our struct in contract storage
    bytes32 storagePosition = keccak256("co.ensuro.LiquidityThresholdAssetManager");
    // solhint-disable-next-line no-inline-assembly
    assembly {
      ds.slot := storagePosition
    }
  }

  function _validateParameters() internal view {
    DiamondStorage storage ds = diamondStorage();

    require(
      ds.liquidityMin <= ds.liquidityMiddle && ds.liquidityMiddle <= ds.liquidityMax,
      "Validation: Liquidity limits are invalid"
    );
  }

  function connect() public virtual override {
    require(
      IPolicyPoolComponent(address(this)).policyPool().currency() == _asset,
      "Asset mismatch"
    );
  }

  function recordEarnings() external virtual override returns (int256) {
    uint256 investmentValue = getInvestmentValue();
    DiamondStorage storage ds = diamondStorage();
    int256 earnings = int256(investmentValue) - int256(uint256(ds.lastInvestmentValue));
    ds.lastInvestmentValue = investmentValue.toUint128();
    emit EarningsRecorded(earnings);
    return earnings;
  }

  /**
   * @dev Returns the current value of the investment portfolio
   */
  function getInvestmentValue() public view virtual returns (uint256);

  /**
   * @dev Rebalances cash between PolicyPool wallet and
   */
  function rebalance() external virtual override {
    uint256 cash = _asset.balanceOf(address(this));
    if (cash > liquidityMax()) {
      _invest(cash - liquidityMiddle());
    } else if (cash < liquidityMin()) {
      uint256 deinvestAmount = Math.min(getInvestmentValue(), liquidityMiddle() - cash);
      if (deinvestAmount > 0) {
        _deinvest(deinvestAmount);
      }
    }
  }

  /**
   * @dev This is called from PolicyPool when doesn't have enought money for payment.
   *      After the call, there should be enought money in PolicyPool.currency().balanceOf(this) to
   *      do the payment
   * @param paymentAmount The amount of the payment
   */
  function refillWallet(uint256 paymentAmount) external override returns (uint256 deinvest) {
    uint256 cash = _asset.balanceOf(address(this));
    require(cash < paymentAmount, "No need to refill the wallet for this payment");
    uint256 investmentValue = getInvestmentValue();
    // try to leave the pool balance at liquidity_middle after the payment
    deinvest = paymentAmount + liquidityMiddle() - cash;
    if (deinvest > investmentValue) deinvest = investmentValue;
    _deinvest(deinvest);
    return deinvest;
  }

  function _invest(uint256 amount) internal virtual {
    DiamondStorage storage ds = diamondStorage();
    ds.lastInvestmentValue += amount.toUint128();
    emit MoneyInvested(amount);
    // must be reimplemented do the actual cash movement
  }

  function _deinvest(uint256 amount) internal virtual {
    DiamondStorage storage ds = diamondStorage();
    ds.lastInvestmentValue -= Math.min(uint256(ds.lastInvestmentValue), amount).toUint128();
    emit MoneyDeinvested(amount);
    // must be reimplemented do the actual cash movement
  }

  function liquidityMin() public view returns (uint256) {
    return diamondStorage().liquidityMin * 10**_asset.decimals();
  }

  function liquidityMiddle() public view returns (uint256) {
    return diamondStorage().liquidityMiddle * 10**_asset.decimals();
  }

  function liquidityMax() public view returns (uint256) {
    return diamondStorage().liquidityMax * 10**_asset.decimals();
  }

  function setLiquidityThresholds(
    uint256 min,
    uint256 middle,
    uint256 max
  ) external validateParamsAfterChange {
    DiamondStorage storage ds = diamondStorage();
    if (min != type(uint256).max) {
      ds.liquidityMin = (min / 10**_asset.decimals()).toUint32();
      emit GovernanceAction(IAccessManager.GovernanceActions.setLiquidityMin, min);
    }
    if (middle != type(uint256).max) {
      ds.liquidityMiddle = (middle / 10**_asset.decimals()).toUint32();
      emit GovernanceAction(IAccessManager.GovernanceActions.setLiquidityMiddle, middle);
    }
    if (max != type(uint256).max) {
      ds.liquidityMax = (max / 10**_asset.decimals()).toUint32();
      emit GovernanceAction(IAccessManager.GovernanceActions.setLiquidityMax, max);
    }
  }
}
