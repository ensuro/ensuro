// SPDX-License-Identifier: Apache-2.0

pragma solidity 0.8.16;

import {WadRayMath} from "./dependencies/WadRayMath.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/**
 * @title TimeScaled
 * @dev Library for packed amounts that increase continuoulsly with a scale factor
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
library TimeScaled {
  using WadRayMath for uint256;
  using SafeCast for uint256;

  uint256 private constant SECONDS_PER_YEAR = 365 days;
  uint112 private constant MIN_SCALE = 1e17; // 0.0000000001 == 1e-10 in ray
  uint112 private constant RAY112 = 1e27;

  struct ScaledAmount {
    uint112 scale;
    uint112 amount;
    uint32 lastUpdate;
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

  function getScale(ScaledAmount storage scaledAmount, uint256 interestRate)
    internal
    view
    returns (uint256)
  {
    uint32 now_ = uint32(block.timestamp);
    if (scaledAmount.lastUpdate >= now_) {
      return scaledAmount.scale;
    }
    uint256 timeDifference = uint256(now_ - scaledAmount.lastUpdate);
    return
      uint256(scaledAmount.scale).rayMul(
        ((interestRate.wadToRay() * timeDifference) / SECONDS_PER_YEAR) + WadRayMath.RAY
      );
  }

  function getScaledAmount(ScaledAmount storage scaledAmount, uint256 interestRate)
    internal
    view
    returns (uint256)
  {
    return
      uint256(scaledAmount.amount)
        .wadToRay()
        .rayMul(getScale(scaledAmount, interestRate))
        .rayToWad();
  }

  function init(ScaledAmount storage scaledAmount) internal {
    scaledAmount.scale = RAY112;
    scaledAmount.amount = 0;
    scaledAmount.lastUpdate = uint32(block.timestamp);
  }

  function scaleAmount(ScaledAmount storage scaledAmount, uint256 toScale)
    internal
    view
    returns (uint256)
  {
    return toScale.wadToRay().rayDiv(uint256(scaledAmount.scale)).rayToWad();
  }

  function scaleAmountNow(
    ScaledAmount storage scaledAmount,
    uint256 interestRate,
    uint256 toScale
  ) internal view returns (uint256) {
    return toScale.wadToRay().rayDiv(getScale(scaledAmount, interestRate)).rayToWad();
  }

  function add(
    ScaledAmount storage scaledAmount,
    uint256 amount,
    uint256 interestRate
  ) internal returns (uint256) {
    updateScale(scaledAmount, interestRate);
    uint256 scaledAdd = scaleAmount(scaledAmount, amount);
    scaledAmount.amount += scaledAdd.toUint96();
    return scaledAdd;
  }

  function sub(
    ScaledAmount storage scaledAmount,
    uint256 amount,
    uint256 interestRate
  ) internal returns (uint256) {
    updateScale(scaledAmount, interestRate);
    uint256 scaledSub = scaleAmount(scaledAmount, amount);
    scaledAmount.amount -= scaledSub.toUint96();
    if (scaledAmount.amount == 0) {
      // Reset scale if amount == 0
      scaledAmount.scale = RAY112;
    }
    return scaledSub;
  }

  function discreteChange(
    ScaledAmount storage scaledAmount,
    int256 amount,
    uint256 interestRate
  ) internal {
    updateScale(scaledAmount, interestRate);
    uint256 newScaledAmount = uint256(int256(getScaledAmount(scaledAmount, interestRate)) + amount);
    scaledAmount.scale = newScaledAmount
      .wadToRay()
      .rayDiv(uint256(scaledAmount.amount).wadToRay())
      .toUint112();
    require(scaledAmount.scale >= MIN_SCALE, "Scale too small, can lead to rounding errors");
  }

  function minValue(ScaledAmount storage scaledAmount) internal view returns (uint256) {
    return uint256(scaledAmount.amount).wadToRay().rayMul(MIN_SCALE).rayToWad();
  }
}
