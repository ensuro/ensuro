// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Policy} from '../contracts/Policy.sol';

interface IPolicyPool {
  event NewPolicy(address indexed riskModule, uint256 policyId);

  function currency() external view returns (IERC20);
  function newPolicy(Policy.PolicyData memory policy, address customer) external returns (uint256);
  function resolvePolicy(uint256 policyId, bool customerWon) external;

  function getPolicy(uint256 policyId) external view returns (Policy.PolicyData memory);
}
