// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IRiskModule {
  // event SCRLocked(uint256 interest_rate, uint256 value);
  // event SCRUnlocked(uint256 interest_rate, uint256 value);

  function name() external view returns (string memory);

  function scrPercentage() external view returns (uint256);

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
