// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.16;

import {IPremiumsAccount} from "./IPremiumsAccount.sol";

/**
 * @title IRiskModule interface
 * @dev Interface for RiskModule smart contracts. Gives access to RiskModule configuration parameters
 * @author Ensuro
 */
interface IRiskModule {
  /**
   * @dev Enum with the different parameters of the risk module, used in {RiskModule-setParam}.
   */
  enum Parameter {
    moc,
    jrCollRatio,
    collRatio,
    ensuroPpFee,
    ensuroCocFee,
    jrRoc,
    srRoc,
    maxPayoutPerPolicy,
    exposureLimit,
    maxDuration
  }

  /**
   * Struct of the parameters of the risk module that are used to calculate the different Policy fields (see
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
   * @dev A readable name of this risk module. Never changes.
   */
  function name() external view returns (string memory);

  /**
   * @dev Returns different parameters of the risk module (see {Params})
   */
  function params() external view returns (Params memory);

  /**
   * @dev Returns the maximum duration (in hours) of the policies of this risk module.
   *      The `expiration` of the policies has to be `<= (block.timestamp + 3600 * maxDuration())`
   */
  function maxDuration() external view returns (uint256);

  /**
   * @dev Returns the maximum payout accepted for new policies.
   */
  function maxPayoutPerPolicy() external view returns (uint256);

  /**
   * @dev Returns sum of the (maximum) payout of the active policies of this risk module, i.e. the maximum possible
   * amount of money that's exposed for this risk module.
   */
  function activeExposure() external view returns (uint256);

  /**
   * @dev Returns maximum exposure (sum of the (maximum) payout of the active policies) of this risk module.
   * `activeExposure() <= exposureLimit()` always
   */
  function exposureLimit() external view returns (uint256);

  /**
   * @dev Returns the address of the partner that receives the partnerCommission
   */
  function wallet() external view returns (address);

  /**
   * @dev Called when a policy expires or is resolved to update the exposure.
   *
   * Requirements:
   * - Must be called by `policyPool()`
   *
   * @param payout The exposure (maximum payout) of the policy
   */
  function releaseExposure(uint256 payout) external;

  /**
   * @dev Returns the {PremiumsAccount} where the premiums of this risk module are collected. Never changes.
   */
  function premiumsAccount() external view returns (IPremiumsAccount);
}
