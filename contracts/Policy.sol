// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title Policy library
 * @notice Library for PolicyData struct. This struct represents an active policy, the premium and solvency breakdown
 * @dev Tracks how the premium is distributed, the probability of payout, duration and how the capital is locked.
 * It is never stored on-chain, but instead we store a hash and we receive the policy on each operation
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
library Policy {
  using Math for uint256;

  uint256 internal constant WAD = 1e18;
  uint256 internal constant SECONDS_PER_YEAR = 365 days;

  /**
   * @notice Struct of the parameters of the risk module that are used to calculate the different Policy fields (see
   * {Policy-PolicyData}.
   */
  struct Params {
    /**
     * @dev MoC (Margin of Conservativism) is a factor that multiplies the lossProb to increase or decrease the pure
     * premium.
     */
    uint256 moc;
    /**
     * @dev Junior Collateralization Ratio is the percentage of policy exposure (payout) that will be covered with the
     * purePremium and the Junior EToken
     */
    uint256 jrCollRatio;
    /**
     * @dev Collateralization Ratio is the percentage of policy exposure (payout) that will be covered by the
     * purePremium and the Junior and Senior EToken. Usually is calculated as the relation between VAR99.5% and VAR100
     * (full collateralization).
     */
    uint256 collRatio;
    /**
     * @dev Ensuro PurePremium Fee is the percentage that will be multiplied by the pure premium to obtain the part of
     * the Ensuro Fee that's proportional to the pure premium.
     */
    uint256 ensuroPpFee;
    /**
     * @dev Ensuro Cost of Capital Fee is the percentage that will be multiplied by the cost of capital (CoC) to
     * obtain the part of the Ensuro Fee that's proportional to the CoC.
     */
    uint256 ensuroCocFee;
    /**
     * @dev Junior Return on Capital is the annualized interest rate that's charged for the capital locked in the Junior
     * EToken.
     */
    uint256 jrRoc;
    /**
     * @dev Senior Return on Capital is the annualized interest rate that's charged for the capital locked in the Senior
     * EToken.
     */
    uint256 srRoc;
  }

  /**
   * @notice Struct with all the info of a given policy
   * @dev It includes the premium breakdown
   * (`premium=purePremium + jrCoc + srCoc + ensuroCommission + partnerCommission`), the solvency breakdown
   * (`solvency = purePremium + jrScr + srScr = payout * collRatio`), and the start and end of the policy.
   */
  struct PolicyData {
    uint256 id;
    uint256 payout;
    uint256 jrScr;
    uint256 srScr;
    uint256 lossProb; // original loss probability (in wad)
    uint256 purePremium; // share of the premium that covers expected losses
    // equal to payout * lossProb * riskModule.moc
    uint256 ensuroCommission; // share of the premium that goes for Ensuro
    uint256 partnerCommission; // share of the premium that goes for the RM
    uint256 jrCoc; // share of the premium that goes to junior liquidity providers (won or not)
    uint256 srCoc; // share of the premium that goes to senior liquidity providers (won or not)
    uint40 start;
    uint40 expiration;
  }

  /**
   * @notice Struct that contains the breakdown of premium and policy solvency
   * @dev Used for internal calculations.
   * `totalPremium = purePremium + jrCoc + srCoc + ensuroCommission + partnerCommission`
   */
  struct PremiumComposition {
    uint256 purePremium;
    uint256 jrScr;
    uint256 srScr;
    uint256 jrCoc;
    uint256 srCoc;
    uint256 ensuroCommission;
    uint256 partnerCommission;
    uint256 totalPremium;
  }

  /**
   * @notice Raised when the received premium is less than the minimum
   * @dev The minPremium is the one that results of computing the CoCs, purePremium and ensuroCommission for the given
   * parameters, assuming partnerCommission = 0.
   */
  error PremiumLessThanMinimum(uint256 premium, uint256 minPremium);

  /// @notice Raised when the premium exceeds the payoutreceived premium is less than the minimum
  error PremiumExceedsPayout(uint256 premium, uint256 payout);

  /// @notice Raised when the computed hash is bytes32(0)
  error ZeroHash(PolicyData policy);

  /**
   * @notice Computes the minimum premium
   * @dev The minPremium is the one that results of computing the CoCs, purePremium and ensuroCommission for the given
   * parameters, assuming partnerCommission = 0.
   *
   * @param rmParams Struct with the business and quantitative parameters that define the risk (see {Params}).
   * @param payout Maximum payout (exposure) of the policy
   * @param lossProb Probability of paying the maximum payout (purePremium = rmParams.moc * lossProb * payout)
   * @param expiration Timestamp when the policy expires (can't be claimed anymore)
   * @param start Timestamp when the policy starts (block.timestamp for new policies)
   * @return minPremium PremiumComposition struct with the computed premium and its breakdown
   */
  function getMinimumPremium(
    Params memory rmParams,
    uint256 payout,
    uint256 lossProb,
    uint40 expiration,
    uint40 start
  ) internal pure returns (PremiumComposition memory minPremium) {
    minPremium.purePremium = payout.mulDiv(lossProb, WAD).mulDiv(rmParams.moc, WAD);
    minPremium.jrScr = payout.mulDiv(rmParams.jrCollRatio, WAD);
    if (minPremium.jrScr > minPremium.purePremium) {
      minPremium.jrScr -= minPremium.purePremium;
    } else {
      minPremium.jrScr = 0;
    }

    minPremium.srScr = payout.mulDiv(rmParams.collRatio, WAD);
    if (minPremium.srScr > (minPremium.purePremium + minPremium.jrScr)) {
      minPremium.srScr -= minPremium.purePremium + minPremium.jrScr;
    } else {
      minPremium.srScr = 0;
    }

    // Calculate CoCs
    minPremium.jrCoc = minPremium.jrScr.mulDiv((rmParams.jrRoc * (expiration - start)) / SECONDS_PER_YEAR, WAD);
    minPremium.srCoc = minPremium.srScr.mulDiv((rmParams.srRoc * (expiration - start)) / SECONDS_PER_YEAR, WAD);
    uint256 totalCoc = minPremium.jrCoc + minPremium.srCoc;

    minPremium.ensuroCommission =
      minPremium.purePremium.mulDiv(rmParams.ensuroPpFee, WAD) +
      totalCoc.mulDiv(rmParams.ensuroCocFee, WAD);

    minPremium.totalPremium = minPremium.purePremium + minPremium.ensuroCommission + totalCoc;
  }

  /**
   * @notice Initializes a policy struct
   * @dev Computes the minimum premium and the remaining (premium - minPremium) is assigned as partnerCommissiona
   *
   * @custom:throws PremiumLessThanMinimum when `premium` parameter is less than the computed minPremium
   *
   * @param rmParams Struct with the business and quantitative parameters that define the risk (see {Params}).
   * @param premium The premium that will be paid for the policy
   * @param payout Maximum payout (exposure) of the policy
   * @param lossProb Probability of paying the maximum payout (purePremium = rmParams.moc * lossProb * payout)
   * @param expiration Timestamp when the policy expires (can't be claimed anymore)
   * @param start Timestamp when the policy starts (block.timestamp for new policies)
   * @return newPolicy PolicyData struct with the fields initialized (all except .id)
   */
  function initialize(
    Params memory rmParams,
    uint256 premium,
    uint256 payout,
    uint256 lossProb,
    uint40 expiration,
    uint40 start
  ) internal pure returns (PolicyData memory newPolicy) {
    require(premium < payout, PremiumExceedsPayout(premium, payout));
    PolicyData memory policy;

    policy.payout = payout;
    policy.lossProb = lossProb;
    policy.start = start;
    policy.expiration = expiration;

    PremiumComposition memory minPremium = getMinimumPremium(rmParams, payout, lossProb, expiration, start);

    policy.purePremium = minPremium.purePremium;
    policy.jrScr = minPremium.jrScr;
    policy.srScr = minPremium.srScr;
    policy.jrCoc = minPremium.jrCoc;
    policy.srCoc = minPremium.srCoc;
    policy.ensuroCommission = minPremium.ensuroCommission;

    require(minPremium.totalPremium <= premium, PremiumLessThanMinimum(premium, minPremium.totalPremium));

    policy.partnerCommission = premium - minPremium.totalPremium;
    return policy;
  }

  /**
   * @notice Computes the annualized interest rate paid to Junior LPs, for a given policy
   * @dev Computed as `(jrCoc / jrScr) * (SECONDS_PER_YEAR / duration)`. The result should be almost the same as
   * the initial rmParams.jrRoc sent to `initialize`.
   *
   * @param policy Struct with all the info of the policy
   * @return Annualized interest rate in WAD
   */
  function jrInterestRate(PolicyData memory policy) internal pure returns (uint256) {
    return ((policy.jrCoc * SECONDS_PER_YEAR) / duration(policy)).mulDiv(WAD, policy.jrScr);
  }

  /**
   * @notice Computed the interest accrued by junior LPs
   * @dev The value is directly proportional to the elapsed time since policy.start with respect to the duration
   *
   * @param policy Struct with all the info of the policy
   * @return Amount of the JrCoc accrued so far
   */
  function jrAccruedInterest(PolicyData memory policy) internal view returns (uint256) {
    return (policy.jrCoc * (block.timestamp - policy.start)) / duration(policy);
  }

  /**
   * @notice Computes the annualized interest rate paid to Senior LPs, for a given policy
   * @dev Computed as `(srCoc / srScr) * (SECONDS_PER_YEAR / duration)`. The result should be almost the same as
   * the initial rmParams.srRoc sent to `initialize`.
   *
   * @param policy Struct with all the info of the policy
   * @return Annualized interest rate in WAD
   */
  function srInterestRate(PolicyData memory policy) internal pure returns (uint256) {
    return ((policy.srCoc * SECONDS_PER_YEAR) / duration(policy)).mulDiv(WAD, policy.srScr);
  }

  /**
   * @notice Computed the interest accrued by senior LPs
   * @dev The value is directly proportional to the elapsed time since policy.start with respect to the duration
   *
   * @param policy Struct with all the info of the policy
   * @return Amount of the SrCoc accrued so far
   */
  function srAccruedInterest(PolicyData memory policy) internal view returns (uint256) {
    return (policy.srCoc * (block.timestamp - policy.start)) / duration(policy);
  }

  /// @notice Returns the duration in seconds of the policy
  function duration(PolicyData memory policy) internal pure returns (uint40) {
    return policy.expiration - policy.start;
  }

  /// @notice Returns a hash of all the fields of the policy
  function hash(PolicyData memory policy) internal pure returns (bytes32 retHash) {
    retHash = keccak256(abi.encode(policy));
    require(retHash != bytes32(0), ZeroHash(policy));
    return retHash;
  }
}
