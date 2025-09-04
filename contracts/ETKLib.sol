// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/**
 * @title ETKLib
 * @dev Library with different datatypes and utils used by the eToken contract
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
library ETKLib {
  using Math for uint256;
  using SafeCast for uint256;

  uint256 private constant SECONDS_PER_YEAR = 365 days;
  uint96 private constant MIN_SCALE = 1e8; // 0.0000000001 == 1e-10 in wad
  uint96 private constant WAD96 = 1e18;
  uint256 internal constant WAD = 1e18;

  struct ScaledAmount {
    uint128 amount; // amount before applying any factor to take it to current value
    uint96 scale; // in Wad - factor used to compute the current value from the amount at the lastUpdate time
    uint32 lastUpdate; // Timestamp when the scale was computed. From that point to 'now', we increase with at a
    // given interestRate.
  }

  struct Scr {
    uint128 scr; // amount - Capital locked as Solvency Capital Requirement of backed up policies
    uint64 interestRate; // in Wad - Interest rate received in exchange of solvency capital
    uint64 tokenInterestRate; // in Wad - Overall interest rate of the token
  }

  /**
   * @dev unchecked version of Math.mulDiv that returns the result of a * b / c.
   *
   * Assumes a * b < 2**256
   */
  function _mulDiv(uint256 a, uint256 b, uint256 c) internal pure returns (uint256) {
    unchecked {
      return (a * b) / c;
    }
  }

  /*** BEGIN ScaledAmount functions ***/
  function updateScale(ScaledAmount storage scaledAmount, uint256 interestRate) internal {
    if (scaledAmount.lastUpdate >= uint32(block.timestamp)) return;
    if (scaledAmount.amount == 0) {
      scaledAmount.lastUpdate = uint32(block.timestamp);
    } else {
      scaledAmount.scale = getScale(scaledAmount, interestRate).toUint96();
      scaledAmount.lastUpdate = uint32(block.timestamp);
    }
  }

  function getScale(ScaledAmount storage scaledAmount, uint256 interestRate) internal view returns (uint256) {
    uint32 now_ = uint32(block.timestamp);
    if (scaledAmount.lastUpdate < now_) {
      return
        uint256(scaledAmount.scale).mulDiv(
          ((interestRate * uint256(now_ - scaledAmount.lastUpdate)) / SECONDS_PER_YEAR) + WAD,
          WAD
        );
    } else {
      return scaledAmount.scale;
    }
  }

  /**
   * @dev Converts a "scaled amount" (raw value, without applying earnings) to the current value after
   *      after applying the scale.
   * @param scaledAmount The `scaled amount` as the ones stored in `$._balances`
   * @param scale        The scale to apply.
   * @return The current amount, that results of `scaledAmount * scale`
   */
  function _scaledToCurrent(uint256 scaledAmount, uint256 scale) internal pure returns (uint256) {
    return _mulDiv(scaledAmount, scale, WAD);
  }

  /**
   * @dev Converts a "current amount" (end user value, after applying earnings) to the scaled amount (raw value)
   * @param currentAmount The `current amount` as the ones obtainted by the user in balanceOf or totalSupply()
   * @param scale        The scale to un-apply.
   * @return The scaled amount, that results of `currentAmount / scale`
   */
  function _currentToScale(uint256 currentAmount, uint256 scale) internal pure returns (uint256) {
    return _mulDiv(currentAmount, WAD, scale);
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
    scaledAmount.scale = WAD96;
    scaledAmount.amount = 0;
    scaledAmount.lastUpdate = uint32(block.timestamp);
  }

  function add(ScaledAmount storage scaledAmount, uint256 amount, uint256 interestRate) internal returns (uint256) {
    updateScale(scaledAmount, interestRate);
    uint256 scaledAdd = _currentToScale(amount, uint256(scaledAmount.scale));
    scaledAmount.amount += scaledAdd.toUint128();
    return scaledAdd;
  }

  function sub(ScaledAmount storage scaledAmount, uint256 amount, uint256 interestRate) internal returns (uint256) {
    updateScale(scaledAmount, interestRate);
    uint256 scaledSub = _currentToScale(amount, uint256(scaledAmount.scale));
    scaledAmount.amount -= scaledSub.toUint128();
    if (scaledAmount.amount == 0) {
      // Reset scale if amount == 0
      scaledAmount.scale = WAD96;
    }
    return scaledSub;
  }

  function discreteChange(
    ScaledAmount storage scaledAmount,
    int256 amount,
    uint256 interestRate
  ) internal returns (uint256 newCurrentAmount) {
    if (scaledAmount.amount == 0) {
      add(scaledAmount, uint256(amount), interestRate);
      return _scaledToCurrent(uint256(amount), uint256(scaledAmount.scale));
    }
    updateScale(scaledAmount, interestRate);
    newCurrentAmount = uint256(int256(getCurrentAmount(scaledAmount, interestRate)) + amount);
    scaledAmount.scale = newCurrentAmount.mulDiv(WAD, uint256(scaledAmount.amount)).toUint96();
    // Consistency check - Uncomment for testing
    // require(newCurrentAmount == getCurrentAmount(scaledAmount, interestRate), "Error");
    require(scaledAmount.scale >= MIN_SCALE, "Scale too small, can lead to rounding errors");
  }

  function minValue(ScaledAmount storage scaledAmount) internal view returns (uint256) {
    return _mulDiv(uint256(scaledAmount.amount), MIN_SCALE, WAD);
  }
  /*** END ScaledAmount functions ***/

  /*** BEGIN Scr functions ***/
  function add(
    Scr storage scr,
    uint256 scrAmount_,
    uint256 policyInterestRate,
    uint256 totalSupply
  ) internal view returns (Scr memory modifiedScr) {
    if (scr.scr == 0) {
      return
        Scr({
          scr: scrAmount_.toUint128(),
          interestRate: policyInterestRate.toUint64(),
          tokenInterestRate: _mulDiv(policyInterestRate, scrAmount_, totalSupply).toUint64()
        });
    } else {
      uint256 origScr = uint256(scr.scr);
      uint256 newScr = origScr + scrAmount_;
      // newInterestRate = (oldInterestRate * oldScr + policyInterestRate * scrAmount_) / newScr
      uint256 newInterestRate = _mulDiv(
        _mulDiv(uint256(scr.interestRate), origScr, WAD) + _mulDiv(policyInterestRate, scrAmount_, WAD),
        WAD,
        newScr
      );

      return
        Scr({
          scr: newScr.toUint128(),
          interestRate: newInterestRate.toUint64(),
          tokenInterestRate: _mulDiv(newInterestRate, newScr, totalSupply).toUint64()
        });
    }
  }

  function sub(
    Scr storage scr,
    uint256 scrAmount_,
    uint256 policyInterestRate,
    uint256 totalSupply
  ) internal view returns (Scr memory modifiedScr) {
    if (scr.scr == scrAmount_) {
      return Scr({scr: 0, interestRate: 0, tokenInterestRate: 0});
    } else {
      uint256 origScr = uint256(scr.scr);
      uint256 newScr = origScr - scrAmount_;
      // newInterestRate = (oldInterestRate * oldScr - scrAmount_ * policyInterestRate) / newScr
      uint256 newInterestRate = _mulDiv(
        _mulDiv(uint256(scr.interestRate), origScr, WAD) - _mulDiv(policyInterestRate, scrAmount_, WAD),
        WAD,
        newScr
      );

      return
        Scr({
          scr: newScr.toUint128(),
          interestRate: newInterestRate.toUint64(),
          tokenInterestRate: _mulDiv(newInterestRate, newScr, totalSupply).toUint64()
        });
    }
  }

  function updateTokenInterestRate(Scr storage scr, uint256 totalSupply) internal {
    if (totalSupply == 0) scr.tokenInterestRate = 0;
    else {
      scr.tokenInterestRate = _mulDiv(uint256(scr.interestRate), uint256(scr.scr), totalSupply).toUint64();
    }
  }

  function fundsAvailable(Scr storage scr, uint256 totalSupply) internal view returns (uint256) {
    uint256 scr_ = uint256(scr.scr);
    if (totalSupply > scr_) return totalSupply - scr_;
    else return 0;
  }

  function scrAmount(Scr storage scr) internal view returns (uint256) {
    return uint256(scr.scr);
  }

  /*** END Scr functions ***/
}
