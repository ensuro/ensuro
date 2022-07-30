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

  struct ScaledAmount {
    uint40 lastUpdate;
    uint96 scale;
    uint96 amount;
  }

  function _updateScale(ScaledAmount storage scaledAmount, uint256 interestRate) private {
    if (scaledAmount.amount == 0) {
      scaledAmount.lastUpdate = uint40(block.timestamp);
    } else {
      scaledAmount.scale = uint96(_getScale(scaledAmount, interestRate));
      scaledAmount.lastUpdate = uint40(block.timestamp);
    }
  }

  function _getScale(ScaledAmount storage scaledAmount, uint256 interestRate)
    private
    view
    returns (uint256)
  {
    uint40 now_ = uint40(block.timestamp);
    if (scaledAmount.lastUpdate >= now_) {
      return scaledAmount.scale;
    }
    uint256 timeDifference = uint256(now_ - scaledAmount.lastUpdate);
    return
      uint256(scaledAmount.scale).rayMul(
        ((interestRate * timeDifference) / SECONDS_PER_YEAR) + WadRayMath.ray()
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
        .rayMul(_getScale(scaledAmount, interestRate))
        .rayToWad();
  }

  function init(ScaledAmount storage scaledAmount) internal {
    scaledAmount.amount = 0;
    scaledAmount.scale = uint96(WadRayMath.ray());
    scaledAmount.lastUpdate = uint40(block.timestamp);
  }

  function add(
    ScaledAmount storage scaledAmount,
    uint256 amount,
    uint256 interestRate
  ) internal {
    _updateScale(scaledAmount, interestRate);
    scaledAmount.amount += uint96(amount.wadToRay().rayDiv(uint256(scaledAmount.scale)).rayToWad());
  }

  function sub(
    ScaledAmount storage scaledAmount,
    uint256 amount,
    uint256 interestRate
  ) internal {
    _updateScale(scaledAmount, interestRate);
    scaledAmount.amount = uint96(
      (getScaledAmount(scaledAmount, interestRate) - amount)
        .wadToRay()
        .rayDiv(uint256(scaledAmount.scale))
        .rayToWad()
    );
    if (scaledAmount.amount == 0) {
      scaledAmount.scale = uint96(WadRayMath.ray());
    }
  }
}
