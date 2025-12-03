// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;
import {Policy} from "../Policy.sol";
import {IUnderwriter} from "../interfaces/IUnderwriter.sol";

/**
 * @title FullTrustedUW
 * @dev Underwriter that just decodes what it receives. The access validations should be done on risk module methods.
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
contract FullTrustedUW is IUnderwriter {
  using Policy for Policy.PolicyData;

  /// @inheritdoc IUnderwriter
  function priceNewPolicy(
    address /* rm */,
    bytes calldata inputData
  )
    external
    pure
    override
    returns (
      uint256 payout,
      uint256 premium,
      uint256 lossProb,
      uint40 expiration,
      uint96 internalId,
      Policy.Params memory params
    )
  {
    return abi.decode(inputData, (uint256, uint256, uint256, uint40, uint96, Policy.Params));
  }

  /// @inheritdoc IUnderwriter
  function pricePolicyReplacement(
    address /* rm */,
    bytes calldata inputData
  )
    external
    pure
    override
    returns (
      Policy.PolicyData memory oldPolicy,
      uint256 payout,
      uint256 premium,
      uint256 lossProb,
      uint40 expiration,
      uint96 internalId,
      Policy.Params memory params
    )
  {
    return abi.decode(inputData, (Policy.PolicyData, uint256, uint256, uint256, uint40, uint96, Policy.Params));
  }

  /// @inheritdoc IUnderwriter
  function pricePolicyCancellation(
    address /* rm */,
    bytes calldata inputData
  )
    external
    view
    override
    returns (
      Policy.PolicyData memory policyToCancel,
      uint256 purePremiumRefund,
      uint256 jrCocRefund,
      uint256 srCocRefund
    )
  {
    (policyToCancel, purePremiumRefund, jrCocRefund, srCocRefund) = abi.decode(
      inputData,
      (Policy.PolicyData, uint256, uint256, uint256)
    );
    if (jrCocRefund == type(uint256).max) jrCocRefund = policyToCancel.jrCoc - policyToCancel.jrAccruedInterest();
    if (srCocRefund == type(uint256).max) srCocRefund = policyToCancel.srCoc - policyToCancel.srAccruedInterest();
  }
}
