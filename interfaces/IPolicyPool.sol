// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Policy} from '../contracts/Policy.sol';

interface IPolicyPool {
  function currency() external view returns (IERC20);
  function assetManager() external view returns (address);   // TODO: IAssetManager
  function newPolicy(Policy.PolicyData memory policy, address customer) external returns (uint256);
  function resolvePolicy(uint256 policyId, uint256 payout) external;
  function resolvePolicy(uint256 policyId, bool customerWon) external;

  function getPolicy(uint256 policyId) external view returns (Policy.PolicyData memory);
}
