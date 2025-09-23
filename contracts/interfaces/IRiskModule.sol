// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IPremiumsAccount} from "./IPremiumsAccount.sol";

/**
 * @title IRiskModule interface
 * @dev Interface for RiskModule smart contracts. Gives access to RiskModule configuration parameters
 * @author Ensuro
 */
interface IRiskModule {
  /**
   * @dev Returns the address of the partner that receives the partnerCommission
   */
  function wallet() external view returns (address);

  /**
   * @dev Returns the {PremiumsAccount} where the premiums of this risk module are collected. Never changes.
   */
  function premiumsAccount() external view returns (IPremiumsAccount);
}
