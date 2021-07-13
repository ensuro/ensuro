// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

/**
 * @title IRiskModule interface
 * @dev Interface for RiskModule smart contracts. Gives access to RiskModule configuration parameters
 * @author Ensuro
 */
interface IRiskModule {
  function name() external view returns (string memory);

  function scrPercentage() external view returns (uint256);

  function moc() external view returns (uint256);

  function premiumShare() external view returns (uint256);

  function ensuroShare() external view returns (uint256);

  function maxScrPerPolicy() external view returns (uint256);

  function scrLimit() external view returns (uint256);

  function totalScr() external view returns (uint256);

  function sharedCoverageMinPercentage() external view returns (uint256);

  function sharedCoveragePercentage() external view returns (uint256);

  function sharedCoverageScr() external view returns (uint256);

  function wallet() external view returns (address);
}
