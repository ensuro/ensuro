// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IPolicyPool} from "../interfaces/IPolicyPool.sol";
import {IPremiumsAccount} from "../interfaces/IPremiumsAccount.sol";
import {IRiskModule} from "../interfaces/IRiskModule.sol";
import {IPolicyPoolComponent} from "../interfaces/IPolicyPoolComponent.sol";
import {ForwardProxy} from "./ForwardProxy.sol";

contract RiskModuleMock is ForwardProxy, IRiskModule, IPolicyPoolComponent {
  IPremiumsAccount internal immutable _premiumsAccount;
  address internal immutable _wallet;

  constructor(
    IPolicyPool policyPool_,
    IPremiumsAccount premiumsAccount_,
    address wallet_
  ) ForwardProxy(address(policyPool_)) {
    _premiumsAccount = premiumsAccount_;
    _wallet = wallet_;
  }

  function policyPool() public view override returns (IPolicyPool) {
    return IPolicyPool(_forwardTo);
  }

  function premiumsAccount() external view override returns (IPremiumsAccount) {
    return _premiumsAccount;
  }

  /**
   * @dev Returns the address of the partner that receives the partnerCommission
   */
  function wallet() external view returns (address) {
    return _wallet;
  }

  function supportsInterface(bytes4 interfaceId) public view virtual override returns (bool) {
    return interfaceId == type(IRiskModule).interfaceId;
  }
}
