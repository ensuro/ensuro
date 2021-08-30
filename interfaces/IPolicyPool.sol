// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Policy} from "../contracts/Policy.sol";
import {IEToken} from "./IEToken.sol";
import {IPolicyPoolConfig} from "./IPolicyPoolConfig.sol";
import {IAssetManager} from "./IAssetManager.sol";

interface IPolicyPool {
  function currency() external view returns (IERC20);

  function config() external view returns (IPolicyPoolConfig);

  function setAssetManager(IAssetManager newAssetManager) external;

  function newPolicy(Policy.PolicyData memory policy, address customer) external returns (uint256);

  function resolvePolicy(uint256 policyId, uint256 payout) external;

  function resolvePolicy(uint256 policyId, bool customerWon) external;

  function receiveGrant(uint256 amount) external;

  function getPolicy(uint256 policyId) external view returns (Policy.PolicyData memory);

  function getInvestable() external view returns (uint256);

  function getETokenCount() external view returns (uint256);

  function getETokenAt(uint256 index) external view returns (IEToken);

  function assetEarnings(uint256 amount, bool positive) external;

  function deposit(IEToken eToken, uint256 amount) external;

  function withdraw(IEToken eToken, uint256 amount) external returns (uint256);

  function totalETokenSupply() external view returns (uint256);
}
