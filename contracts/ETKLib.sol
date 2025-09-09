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
  using ETKLib for Scale;

  type Scale is uint96;

  uint256 private constant SECONDS_PER_YEAR = 365 days;
  uint256 private constant MIN_SCALE = 1e8; // 0.0000000001 == 1e-10 in wad
  Scale private constant SCALE_ONE = Scale.wrap(1e18);
  uint256 internal constant WAD = 1e18;
  int256 internal constant SWAD = 1e18;

  // solhint-disable-next-line gas-struct-packing
  struct ScaledAmount {
    uint128 amount; // amount before applying any factor to take it to current value
    Scale scale; // in Wad - factor used to compute the current value from the amount at the lastUpdate time
    uint32 lastUpdate; // Timestamp when the scale was computed. From that point to 'now', we increase with at a
    // given interestRate.
  }

  struct Scr {
    uint128 scr; // amount - Capital locked as Solvency Capital Requirement of backed up policies
    uint128 interestRate; // in Wad - Interest rate received in exchange of solvency capital
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

  /**
   * @dev unchecked version of Math.mulDiv that returns the result of a * b / c. (signed version)
   *
   * Assumes a * b < 2**256
   */
  function _mulDiv(int256 a, int256 b, int256 c) internal pure returns (int256) {
    unchecked {
      return (a * b) / c;
    }
  }

  /*** BEGIN Scale functions ***/

  /**
   * @dev Converts a "scaled amount" (raw value, without applying earnings) to the current value after
   *      after applying the scale.
   * @param scaledAmount The `scaled amount` as the ones stored in `$._balances`
   * @param scale        The scale to apply.
   * @return The current amount, that results of `scaledAmount * scale`
   */
  function toCurrent(Scale scale, uint256 scaledAmount) internal pure returns (uint256) {
    return _mulDiv(scaledAmount, scale.toUint256(), WAD);
  }

  /**
   * @dev Converts a "current amount" (end user value, after applying earnings) to the scaled amount (raw value)
   * @param currentAmount The `current amount` as the ones obtainted by the user in balanceOf or totalSupply()
   * @param scale        The scale to un-apply.
   * @return The scaled amount, that results of `currentAmount / scale`
   */
  function toScaled(Scale scale, uint256 currentAmount) internal pure returns (uint256) {
    return _mulDiv(currentAmount, WAD, scale.toUint256());
  }

  /**
   * @dev Increases the scale for a given factor
   * @param factor In wad
   * @return newScale Returns a `newScale = scale * (1 + factor)`
   */
  function grow(Scale scale, uint256 factor) internal pure returns (Scale newScale) {
    return Scale.wrap(_mulDiv(scale.toUint256(), factor + WAD, WAD).toUint96());
  }

  /**
   * @dev Increases the scale for a given factor
   * @param factor In wad
   * @return newScale Returns a `newScale = scale * (1 + factor)`
   */
  function add(Scale scale, uint256 factor) internal pure returns (Scale newScale) {
    return Scale.wrap((scale.toUint256() + factor).toUint96());
  }

  /**
   * @dev Increases the scale for a given factor. The factor is signed, so the new scale can be lower. Checks
   *      the resulting scale is greater than MIN_SCALE.
   * @param factor In wad
   * @return newScale Returns a `newScale = scale * (1 + factor)`
   */
  function add(Scale scale, int256 factor) internal pure returns (Scale newScale) {
    uint256 newScaleInt = uint256(int256(scale.toUint256()) + factor);
    require(newScaleInt >= MIN_SCALE, "Scale too small, can lead to rounding errors");
    return Scale.wrap(newScaleInt.toUint96());
  }

  function toUint256(Scale scale) internal pure returns (uint256) {
    return Scale.unwrap(scale);
  }

  /*** BEGIN ScaledAmount functions ***/

  /**
   * @dev Computes the scale of the scaledAmount projecting the last recorded value to the future asumming linear rate
   */
  function projectScale(ScaledAmount storage scaledAmount, uint256 interestRate) internal view returns (Scale) {
    uint32 now_ = uint32(block.timestamp);
    if (scaledAmount.lastUpdate < now_) {
      return scaledAmount.scale.grow((interestRate * uint256(now_ - scaledAmount.lastUpdate)) / SECONDS_PER_YEAR);
    } else {
      return scaledAmount.scale;
    }
  }

  /**
   * @dev Computes the scale of the scaledAmount projecting the last recorded value to the future asumming linear rate
   */
  function projectScale(ScaledAmount storage scaledAmount, Scr storage scr) internal view returns (Scale ret) {
    uint256 scrEarnings = earnings(scr, scaledAmount.lastUpdate);
    if (scrEarnings == 0) return scaledAmount.scale;
    ret = scaledAmount.scale.add(_mulDiv(scrEarnings, WAD, uint256(scaledAmount.amount)));
  }

  function init(ScaledAmount storage scaledAmount) internal {
    scaledAmount.scale = SCALE_ONE;
    scaledAmount.amount = 0;
    scaledAmount.lastUpdate = uint32(block.timestamp);
  }

  function _add(
    ScaledAmount storage scaledAmount,
    uint256 amount,
    Scale scale
  ) internal view returns (ScaledAmount memory newScaledAmount, uint256 scaledAdd) {
    scaledAdd = scale.toScaled(amount);
    return (
      ScaledAmount({
        scale: scale,
        amount: (uint256(scaledAmount.amount) + scaledAdd).toUint128(),
        lastUpdate: uint32(block.timestamp)
      }),
      scaledAdd
    );
  }

  function _sub(
    ScaledAmount storage scaledAmount,
    uint256 amount,
    Scale scale
  ) internal view returns (ScaledAmount memory newScaledAmount, uint256 scaledSub) {
    scaledSub = scale.toScaled(amount);
    uint256 newAmount = uint256(scaledAmount.amount) - scaledSub;
    if (newAmount == 0) {
      // Reset scale if amount == 0
      scale = SCALE_ONE;
    }
    return (
      ScaledAmount({scale: scale, amount: newAmount.toUint128(), lastUpdate: uint32(block.timestamp)}),
      scaledSub
    );
  }

  function add(
    ScaledAmount storage scaledAmount,
    uint256 amount,
    uint256 interestRate
  ) internal view returns (ScaledAmount memory newScaledAmount, uint256 scaledAdd) {
    return _add(scaledAmount, amount, projectScale(scaledAmount, interestRate));
  }

  function sub(
    ScaledAmount storage scaledAmount,
    uint256 amount,
    uint256 interestRate
  ) internal view returns (ScaledAmount memory newScaledAmount, uint256 scaledSub) {
    return _sub(scaledAmount, amount, projectScale(scaledAmount, interestRate));
  }

  function add(
    ScaledAmount storage scaledAmount,
    uint256 amount,
    Scr storage scr
  ) internal view returns (ScaledAmount memory newScaledAmount, uint256 scaledAdd) {
    return _add(scaledAmount, amount, projectScale(scaledAmount, scr));
  }

  function sub(
    ScaledAmount storage scaledAmount,
    uint256 amount,
    Scr storage scr
  ) internal view returns (ScaledAmount memory newScaledAmount, uint256 scaledSub) {
    return _sub(scaledAmount, amount, projectScale(scaledAmount, scr));
  }

  function discreteChange(
    ScaledAmount storage scaledAmount,
    int256 amount,
    Scr storage scr
  ) internal view returns (ScaledAmount memory newScaledAmount) {
    // Adds to the discrete change what was earned from SCR returns
    amount += int256(earnings(scr, scaledAmount.lastUpdate));
    Scale newScale = scaledAmount.scale.add(_mulDiv(amount, SWAD, int256(uint256(scaledAmount.amount))));
    return ScaledAmount({amount: scaledAmount.amount, scale: newScale, lastUpdate: uint32(block.timestamp)});
  }

  function minValue(ScaledAmount storage scaledAmount) internal view returns (uint256) {
    return _mulDiv(uint256(scaledAmount.amount), MIN_SCALE, WAD);
  }
  /*** END ScaledAmount functions ***/

  /*** BEGIN Scr functions ***/
  function add(
    Scr storage scr,
    uint256 scrAmount_,
    uint256 policyInterestRate
  ) internal view returns (Scr memory modifiedScr) {
    if (scr.scr == 0) {
      return Scr({scr: scrAmount_.toUint128(), interestRate: policyInterestRate.toUint128()});
    } else {
      uint256 origScr = uint256(scr.scr);
      uint256 newScr = origScr + scrAmount_;
      // newInterestRate = (oldInterestRate * oldScr + policyInterestRate * scrAmount_) / newScr
      uint256 newInterestRate = _mulDiv(
        _mulDiv(uint256(scr.interestRate), origScr, WAD) + _mulDiv(policyInterestRate, scrAmount_, WAD),
        WAD,
        newScr
      );

      return Scr({scr: newScr.toUint128(), interestRate: newInterestRate.toUint128()});
    }
  }

  function sub(
    Scr storage scr,
    uint256 scrAmount_,
    uint256 policyInterestRate
  ) internal view returns (Scr memory modifiedScr) {
    if (scr.scr == scrAmount_) {
      return Scr({scr: 0, interestRate: 0});
    } else {
      uint256 origScr = uint256(scr.scr);
      uint256 newScr = origScr - scrAmount_;
      // newInterestRate = (oldInterestRate * oldScr - scrAmount_ * policyInterestRate) / newScr
      uint256 newInterestRate = _mulDiv(
        _mulDiv(uint256(scr.interestRate), origScr, WAD) - _mulDiv(policyInterestRate, scrAmount_, WAD),
        WAD,
        newScr
      );

      return Scr({scr: newScr.toUint128(), interestRate: newInterestRate.toUint128()});
    }
  }

  /**
   * @dev Returns the earnings of the SCR since a given date
   */
  function earnings(Scr storage scr, uint32 since) internal view returns (uint256) {
    return
      _mulDiv(
        uint256(scr.scr),
        (uint256(scr.interestRate) * (block.timestamp - uint256(since))) / SECONDS_PER_YEAR,
        WAD
      );
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
