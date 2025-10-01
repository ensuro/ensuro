// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;
import {Policy} from "../Policy.sol";
import {IUnderwriter} from "../interfaces/IUnderwriter.sol";

/**
 * @title Underwriter interface
 * @dev Interface for a contract that validates inputs and converts it into the fields required to create a policy
 */
contract FullTrustedUW is IUnderwriter {
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
}
