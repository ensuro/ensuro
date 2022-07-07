// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {IEToken} from "./IEToken.sol";

/**
 * @title IPremiumsAccount interface
 * @dev Interface for Premiums Account contracts.
 * @author Ensuro
 */
interface IPremiumsAccount {
  function newPolicy(uint256 purePremium) external;

  function policyResolvedWithPayout(
    address policyOwner,
    uint256 purePremium,
    uint256 payout
  ) external returns (uint256);

  function policyExpired(uint256 purePremium, IEToken etk) external returns (uint256);
}
