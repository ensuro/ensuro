// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.0;

import {WadRayMath} from "./WadRayMath.sol";

/**
 * @title TimeScaled
 * @dev Library for packed amounts that increase continuoulsly with a scale factor
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
library TimeScaled {
  using WadRayMath for uint256;

  uint256 internal constant SECONDS_PER_YEAR = 365 days;
  uint128 public constant MIN_SCALE = 1e17; // 0.0000000001 == 1e-10 in ray

  struct ScaledAmount {
    uint128 scale;
    uint96 amount;
    uint32 lastUpdate;
  }

  function updateScale(ScaledAmount storage scaledAmount, uint256 interestRate) internal {
    if (scaledAmount.lastUpdate >= uint32(block.timestamp)) return;
    if (scaledAmount.amount == 0) {
      scaledAmount.lastUpdate = uint32(block.timestamp);
    } else {
      scaledAmount.scale = uint128(getScale(scaledAmount, interestRate));
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
        ((interestRate.wadToRay() * timeDifference) / SECONDS_PER_YEAR) + WadRayMath.ray()
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
    scaledAmount.scale = uint128(WadRayMath.ray());
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
    scaledAmount.amount += uint96(scaledAdd);
    return scaledAdd;
  }

  function sub(
    ScaledAmount storage scaledAmount,
    uint256 amount,
    uint256 interestRate
  ) internal returns (uint256) {
    updateScale(scaledAmount, interestRate);
    uint256 scaledSub = scaleAmount(scaledAmount, amount);
    scaledAmount.amount -= uint96(scaledSub);
    if (scaledAmount.amount == 0) {
      // Reset scale if amount == 0
      scaledAmount.scale = uint128(WadRayMath.ray());
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
    scaledAmount.scale = uint128(
      newScaledAmount.wadToRay().rayDiv(uint256(scaledAmount.amount).wadToRay())
    );
    require(scaledAmount.scale >= MIN_SCALE, "Scale too small, can lead to rounding errors");
  }

  function maxNegativeAdjustment(ScaledAmount storage scaledAmount, uint256 interestRate)
    internal
    view
    returns (uint256)
  {
    uint256 ts = getScaledAmount(scaledAmount, interestRate);
    uint256 minTs = uint256(scaledAmount.amount).wadToRay().rayMul(MIN_SCALE * 10).rayToWad();
    if (ts > minTs) return ts - minTs;
    else return 0;
  }
}
