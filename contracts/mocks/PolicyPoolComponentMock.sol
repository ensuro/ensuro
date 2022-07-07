// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {IPolicyPool} from "../../interfaces/IPolicyPool.sol";
import {IPolicyPoolComponent} from "../../interfaces/IPolicyPoolComponent.sol";

contract PolicyPoolComponentMock is IPolicyPoolComponent {
  IPolicyPool internal immutable _policyPool;

  constructor(IPolicyPool policyPool_) {
    _policyPool = policyPool_;
  }

  function policyPool() external view override returns (IPolicyPool) {
    return _policyPool;
  }
}
