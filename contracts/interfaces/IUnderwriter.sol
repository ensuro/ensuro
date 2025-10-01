// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;
import {Policy} from "../Policy.sol";

/**
 * @title Underwriter interface
 * @dev Interface for a contract that validates inputs and converts it into the fields required to create a policy
 */
interface IUnderwriter {
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
}
