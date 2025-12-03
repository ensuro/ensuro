// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;
import {Policy} from "../Policy.sol";

/**
 * @title Underwriter interface
 * @dev Interface for a contract that validates inputs and converts it into the fields required to create a policy
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
interface IUnderwriter {
  /**
   * @dev Prices a new policy request for RiskModule `rm`.
   *
   * @param rm        The RiskModule address requesting pricing (implementations may use it for access checks).
   * @param inputData Opaque payload consumed by the Underwriter implementation.
   *
   * @return payout      The policy payout.
   * @return premium     The total premium for the policy.
   * @return lossProb    Loss probability used for pricing/risk calculations.
   * @return expiration  Policy expiration timestamp (seconds since epoch).
   * @return internalId  Unique id within `rm` used to derive the policy id.
   * @return params      Additional policy parameters used by {Policy-initialize}.
   *
   * @custom:pre `inputData` must follow the ABI/layout expected by the concrete Underwriter implementation.
   * @custom:pre The caller must satisfy any access/authentication requirements imposed by the implementation.
   */
  function priceNewPolicy(
    address rm,
    bytes calldata inputData
  )
    external
    view
    returns (
      uint256 payout,
      uint256 premium,
      uint256 lossProb,
      uint40 expiration,
      uint96 internalId,
      Policy.Params memory params
    );

  /**
   * @dev Prices a policy replacement request for RiskModule `rm`.
   *
   * @param rm        The RiskModule address requesting pricing (implementations may use it for access checks).
   * @param inputData Opaque payload consumed by the Underwriter implementation.
   *
   * @return oldPolicy   The policy being replaced (as {Policy-PolicyData}).
   * @return payout      The replacement policy payout.
   * @return premium     The replacement policy premium.
   * @return lossProb    Loss probability used for pricing/risk calculations.
   * @return expiration  Replacement policy expiration timestamp.
   * @return internalId  Unique id within `rm` for the replacement policy.
   * @return params      Additional policy parameters used by {Policy-initialize}.
   *
   * @custom:pre `inputData` must follow the ABI/layout expected by the concrete Underwriter implementation.
   * @custom:pre The caller must satisfy any access/authentication requirements imposed by the implementation.
   */
  function pricePolicyReplacement(
    address rm,
    bytes calldata inputData
  )
    external
    view
    returns (
      Policy.PolicyData memory oldPolicy,
      uint256 payout,
      uint256 premium,
      uint256 lossProb,
      uint40 expiration,
      uint96 internalId,
      Policy.Params memory params
    );

  /**
   * @dev Prices a policy cancellation request for RiskModule `rm`.
   *
   * @param rm        The RiskModule address requesting pricing (implementations may use it for access checks).
   * @param inputData Opaque payload consumed by the Underwriter implementation.
   *
   * @return policyToCancel    The policy to cancel (as {Policy-PolicyData}).
   * @return purePremiumRefund Amount to refund from pure premium.
   * @return jrCocRefund       Amount to refund from junior CoC (or a sentinel value, if supported).
   * @return srCocRefund       Amount to refund from senior CoC (or a sentinel value, if supported).
   *
   * @custom:pre `inputData` must follow the ABI/layout expected by the concrete Underwriter implementation.
   * @custom:pre The caller must satisfy any access/authentication requirements imposed by the implementation.
   */
  function pricePolicyCancellation(
    address rm,
    bytes calldata inputData
  )
    external
    view
    returns (
      Policy.PolicyData memory policyToCancel,
      uint256 purePremiumRefund,
      uint256 jrCocRefund,
      uint256 srCocRefund
    );
}
