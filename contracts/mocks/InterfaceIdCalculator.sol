// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IPolicyPool} from "../interfaces/IPolicyPool.sol";
import {IPolicyPoolComponent} from "../interfaces/IPolicyPoolComponent.sol";
import {IEToken} from "../interfaces/IEToken.sol";
import {IRiskModule} from "../interfaces/IRiskModule.sol";
import {IPremiumsAccount} from "../interfaces/IPremiumsAccount.sol";
import {ILPWhitelist} from "../interfaces/ILPWhitelist.sol";
import {IAccessManager} from "../interfaces/IAccessManager.sol";

contract InterfaceIdCalculator {
  bytes4 public constant IERC165_interfaceId = type(IERC165).interfaceId;
  bytes4 public constant IPolicyPool_interfaceId = type(IPolicyPool).interfaceId;
  bytes4 public constant IPolicyPoolComponent_interfaceId = type(IPolicyPoolComponent).interfaceId;
  bytes4 public constant IEToken_interfaceId = type(IEToken).interfaceId;
  bytes4 public constant IRiskModule_interfaceId = type(IRiskModule).interfaceId;
  bytes4 public constant IPremiumsAccount_interfaceId = type(IPremiumsAccount).interfaceId;
  bytes4 public constant ILPWhitelist_interfaceId = type(ILPWhitelist).interfaceId;
  bytes4 public constant IAccessManager_interfaceId = type(IAccessManager).interfaceId;
}
