// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Policy} from "../Policy.sol";
import {IEToken} from "./IEToken.sol";
import {IPolicyPoolConfig} from "./IPolicyPoolConfig.sol";

interface IPolicyPool {
  function currency() external view returns (IERC20Metadata);

  function config() external view returns (IPolicyPoolConfig);

  function policyNFT() external view returns (address);

  function newPolicy(
    Policy.PolicyData memory policy,
    address customer,
    uint96 internalId
  ) external returns (uint256);

  function resolvePolicy(Policy.PolicyData calldata policy, uint256 payout) external;

  function resolvePolicyFullPayout(Policy.PolicyData calldata policy, bool customerWon) external;

  function getETokenCount() external view returns (uint256);

  function getETokenAt(uint256 index) external view returns (IEToken);

  function deposit(IEToken eToken, uint256 amount) external;

  function withdraw(IEToken eToken, uint256 amount) external returns (uint256);

  function totalETokenSupply() external view returns (uint256);
}
