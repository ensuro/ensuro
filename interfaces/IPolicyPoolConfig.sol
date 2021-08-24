// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {IAccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {IAssetManager} from "./IAssetManager.sol";
import {IInsolvencyHook} from "./IInsolvencyHook.sol";
import {IRiskModule} from "./IRiskModule.sol";

/**
 * @title IPolicyPoolAccess - Interface for the contract that handles roles for the PolicyPool and components
 * @dev Interface for the contract that handles roles for the PolicyPool and components
 * @author Ensuro
 */
interface IPolicyPoolConfig is IAccessControlUpgradeable {
  function checkRole(bytes32 role, address account) external view;
  function checkRole2(bytes32 role1, bytes32 role2, address account) external view;
  function connect() external;
  function assetManager() external view returns (IAssetManager);
  function insolvencyHook() external view returns (IInsolvencyHook);
  function treasury() external view returns (address);
  function checkAcceptsNewPolicy(IRiskModule riskModule) external view;
  function checkAcceptsResolvePolicy(IRiskModule riskModule) external view;
}
