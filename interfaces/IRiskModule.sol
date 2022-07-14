// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {IPremiumsAccount} from "./IPremiumsAccount.sol";

/**
 * @title IRiskModule interface
 * @dev Interface for RiskModule smart contracts. Gives access to RiskModule configuration parameters
 * @author Ensuro
 */
interface IRiskModule {
  function name() external view returns (string memory);

  function collRatio() external view returns (uint256);

  function moc() external view returns (uint256);

  function ensuroFee() external view returns (uint256);

  function roc() external view returns (uint256);

  function maxPayoutPerPolicy() external view returns (uint256);

  function scrLimit() external view returns (uint256);

  function totalScr() external view returns (uint256);

  function wallet() external view returns (address);

  function releaseScr(uint256 scrAmount) external;

  function premiumsAccount() external view returns (IPremiumsAccount);
}
