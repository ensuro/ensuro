// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/**
 * @title TimeScaled
 * @dev Library for packed amounts that increase continuoulsly with a scale factor
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
library TimeScaled {
  using Math for uint256;
  using SafeCast for uint256;

  uint256 private constant SECONDS_PER_YEAR = 365 days;
  uint112 private constant MIN_SCALE = 1e17; // 0.0000000001 == 1e-10 in ray
  uint112 private constant MIN_SCALE_WAD = 1e8; // 0.0000000001 == 1e-10 in wad
  uint112 private constant RAY112 = 1e27;
  uint256 internal constant WAD = 1e18;
  uint256 internal constant RAY = 1e27;
  uint256 internal constant WAD_RAY_RATIO = 1e9;

  struct ScaledAmount {
    uint112 scale;
    uint112 amount;
    uint32 lastUpdate;
  }

  function _wadToRay(uint256 amountInWad) internal pure returns (uint256) {
    unchecked {
      return amountInWad * WAD_RAY_RATIO;
    }
  }

  function _rayToWad(uint256 amountInRay) internal pure returns (uint256) {
    unchecked {
      return amountInRay / WAD_RAY_RATIO;
    }
  }

  function updateScale(ScaledAmount storage scaledAmount, uint256 interestRate) internal {
    if (scaledAmount.lastUpdate >= uint32(block.timestamp)) return;
    if (scaledAmount.amount == 0) {
      scaledAmount.lastUpdate = uint32(block.timestamp);
    } else {
      scaledAmount.scale = getScale(scaledAmount, interestRate).toUint112();
      scaledAmount.lastUpdate = uint32(block.timestamp);
    }
  }

  function getScale(ScaledAmount storage scaledAmount, uint256 interestRate) internal view returns (uint256) {
    uint32 now_ = uint32(block.timestamp);
    if (scaledAmount.lastUpdate < now_) {
      return
        uint256(scaledAmount.scale).mulDiv(
          ((_wadToRay(interestRate) * uint256(now_ - scaledAmount.lastUpdate)) / SECONDS_PER_YEAR) + RAY,
          RAY
        );
    } else {
      return scaledAmount.scale;
    }
  }

  /**
   * @dev Converts a "scaled amount" (raw value, without applying interest scaling) to the current value after
   *      after applying the scale.
   * @param scaledAmount The `scaled amount` as the ones stored in `$._balances`
   * @param scale        The scale to apply.
   * @return The current amount, that results of `scaledAmount * scale`
   */
  function _scaledToCurrent(uint256 scaledAmount, uint256 scale) internal pure returns (uint256) {
    return _rayToWad(_wadToRay(scaledAmount).mulDiv(scale, RAY));
  }

  /**
   * @dev Converts a "current amount" (end user value, after applying interests) to the scaled amount (raw value)
   * @param currentAmount The `current amount` as the ones obtainted by the user in balanceOf or totalSupply()
   * @param scale        The scale to un-apply.
   * @return The scaled amount, that results of `currentAmount / scale`
   */
  function _currentToScale(uint256 currentAmount, uint256 scale) internal pure returns (uint256) {
    return _rayToWad(_wadToRay(currentAmount).mulDiv(RAY, scale));
  }

  /**
   * @dev Returns the current amount (up to now) of the timescaled value
   */
  function getCurrentAmount(ScaledAmount storage scaledAmount, uint256 interestRate) internal view returns (uint256) {
    return _scaledToCurrent(uint256(scaledAmount.amount), getScale(scaledAmount, interestRate));
  }

  function currentToScaledNow(
    ScaledAmount storage scaledAmount,
    uint256 interestRate,
    uint256 currentAmount
  ) internal view returns (uint256) {
    return _currentToScale(currentAmount, getScale(scaledAmount, interestRate));
  }

  function scaledToCurrentNow(
    ScaledAmount storage scaledAmount,
    uint256 interestRate,
    uint256 scaledAmountToConvert
  ) internal view returns (uint256) {
    return _scaledToCurrent(scaledAmountToConvert, getScale(scaledAmount, interestRate));
  }

  function init(ScaledAmount storage scaledAmount) internal {
    scaledAmount.scale = RAY112;
    scaledAmount.amount = 0;
    scaledAmount.lastUpdate = uint32(block.timestamp);
  }

  function add(ScaledAmount storage scaledAmount, uint256 amount, uint256 interestRate) internal returns (uint256) {
    updateScale(scaledAmount, interestRate);
    uint256 scaledAdd = _currentToScale(amount, uint256(scaledAmount.scale));
    scaledAmount.amount += scaledAdd.toUint96();
    return scaledAdd;
  }

  function sub(ScaledAmount storage scaledAmount, uint256 amount, uint256 interestRate) internal returns (uint256) {
    updateScale(scaledAmount, interestRate);
    uint256 scaledSub = _currentToScale(amount, uint256(scaledAmount.scale));
    scaledAmount.amount -= scaledSub.toUint96();
    if (scaledAmount.amount == 0) {
      // Reset scale if amount == 0
      scaledAmount.scale = RAY112;
    }
    return scaledSub;
  }

  function discreteChange(ScaledAmount storage scaledAmount, int256 amount, uint256 interestRate) internal {
    if (scaledAmount.amount == 0) {
      add(scaledAmount, uint256(amount), interestRate);
      return;
    }
    updateScale(scaledAmount, interestRate);
    uint256 newCurrentAmount = uint256(int256(getCurrentAmount(scaledAmount, interestRate)) + amount);
    scaledAmount.scale = _wadToRay(newCurrentAmount).mulDiv(RAY, _wadToRay(uint256(scaledAmount.amount))).toUint112();
    // Consistency check - Uncomment for testing
    // require(newCurrentAmount == getCurrentAmount(scaledAmount, interestRate), "Error");
    require(scaledAmount.scale >= MIN_SCALE, "Scale too small, can lead to rounding errors");
  }

  function minValue(ScaledAmount storage scaledAmount) internal view returns (uint256) {
    return uint256(scaledAmount.amount).mulDiv(MIN_SCALE_WAD, WAD);
  }
}
