// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {IEToken} from "./IEToken.sol";
import {Policy} from "../Policy.sol";

/**
 * @title IPremiumsAccount interface
 * @dev Interface for Premiums Account contracts.
 * @author Ensuro
 */
interface IPremiumsAccount {
  function policyCreated(Policy.PolicyData memory policy) external;

  function policyResolvedWithPayout(
    address policyOwner,
    Policy.PolicyData memory policy,
    uint256 payout
  ) external;

  function policyExpired(Policy.PolicyData memory policy) external;

  function seniorEtk() external view returns (IEToken);

  function juniorEtk() external view returns (IEToken);
}
