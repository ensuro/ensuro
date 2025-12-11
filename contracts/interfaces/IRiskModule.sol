// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IPremiumsAccount} from "./IPremiumsAccount.sol";
import {IUnderwriter} from "./IUnderwriter.sol";

/**
 * @title IRiskModule interface
 * @notice Interface for RiskModule smart contracts. Gives access to RiskModule configuration parameters
 * @author Ensuro
 */
interface IRiskModule {
  /**
   * @notice Returns the address of the partner that receives the partnerCommission
   */
  function wallet() external view returns (address);

  /**
   * @notice Returns the {PremiumsAccount} where the premiums of this risk module are collected. Never changes.
   */
  function premiumsAccount() external view returns (IPremiumsAccount);

}
