// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IPolicyPool} from "../interfaces/IPolicyPool.sol";
import {IPolicyPoolComponent} from "../interfaces/IPolicyPoolComponent.sol";
import {IEToken} from "../interfaces/IEToken.sol";
import {IRiskModule} from "../interfaces/IRiskModule.sol";
import {IPolicyHolder} from "../interfaces/IPolicyHolder.sol";
import {IPremiumsAccount} from "../interfaces/IPremiumsAccount.sol";
import {ILPWhitelist} from "../interfaces/ILPWhitelist.sol";

contract InterfaceIdCalculator {
  bytes4 public constant IERC165_INTERFACEID = type(IERC165).interfaceId;
  bytes4 public constant IERC20_INTERFACEID = type(IERC20).interfaceId;
  bytes4 public constant IERC20METADATA_INTERFACEID = type(IERC20Metadata).interfaceId;
  bytes4 public constant IERC721_INTERFACEID = type(IERC721).interfaceId;
  bytes4 public constant IACCESSCONTROL_INTERFACEID = type(IAccessControl).interfaceId;
  bytes4 public constant IPOLICYPOOL_INTERFACEID = type(IPolicyPool).interfaceId;
  bytes4 public constant IPOLICYPOOLCOMPONENT_INTERFACEID = type(IPolicyPoolComponent).interfaceId;
  bytes4 public constant IETOKEN_INTERFACEID = type(IEToken).interfaceId;
  bytes4 public constant IRISKMODULE_INTERFACEID = type(IRiskModule).interfaceId;
  bytes4 public constant IPREMIUMSACCOUNT_INTERFACEID = type(IPremiumsAccount).interfaceId;
  bytes4 public constant ILPWHITELIST_INTERFACEID = type(ILPWhitelist).interfaceId;
  bytes4 public constant IPOLICYHOLDER_INTERFACEID = type(IPolicyHolder).interfaceId;
}
