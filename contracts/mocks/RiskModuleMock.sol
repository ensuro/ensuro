// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IPolicyPool} from "../interfaces/IPolicyPool.sol";
import {IPremiumsAccount} from "../interfaces/IPremiumsAccount.sol";
import {IRiskModule} from "../interfaces/IRiskModule.sol";
import {IPolicyPoolComponent} from "../interfaces/IPolicyPoolComponent.sol";
import {Policy} from "../Policy.sol";
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

  function newPolicy(Policy.PolicyData calldata policy, address payer, address policyHolder) external {
    Policy.PolicyData memory p = policy;
    if (p.start == 0) p.start = uint40(block.timestamp);
    IPolicyPool(_forwardTo).newPolicy(p, payer, policyHolder);
  }

  function newPoliciesBatch(Policy.PolicyData[] calldata policies, address payer, address policyHolder) external {
    Policy.PolicyData[] memory p = new Policy.PolicyData[](policies.length);
    for (uint256 i = 0; i < policies.length; i++) {
      p[i] = policies[i];
      if (p[i].start == 0) p[i].start = uint40(block.timestamp);
    }
    IPolicyPool(_forwardTo).newPoliciesBatch(p, payer, policyHolder);
  }
}
