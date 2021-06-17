// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Policy} from '../contracts/Policy.sol';
import {IEToken} from './IEToken.sol';
import {IRiskModule} from './IRiskModule.sol';
import {DataTypes} from '../contracts/DataTypes.sol';

interface IPolicyPool {
  event NewPolicy(IRiskModule indexed riskModule, uint256 policyId);
  event PolicyRebalanced(IRiskModule indexed riskModule, uint256 indexed policyId);
  event PolicyResolved(IRiskModule indexed riskModule, uint256 indexed policyId, bool customerWon);

  event RiskModuleStatusChanged(IRiskModule indexed riskModule, DataTypes.RiskModuleStatus newStatus);

  event ETokenStatusChanged(IEToken indexed eToken, DataTypes.ETokenStatus newStatus);
  event AssetManagerChanged(address indexed assetManager);

  event Withdrawal(IEToken indexed eToken, address indexed provider, uint256 value);

  function currency() external view returns (IERC20);
  function assetManager() external view returns (address);   // TODO: IAssetManager
  function newPolicy(Policy.PolicyData memory policy, address customer) external returns (uint256);
  function resolvePolicy(uint256 policyId, bool customerWon) external;

  function getPolicy(uint256 policyId) external view returns (Policy.PolicyData memory);
}
