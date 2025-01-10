// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IPolicyPool} from "../interfaces/IPolicyPool.sol";
import {IPolicyPoolComponent} from "../interfaces/IPolicyPoolComponent.sol";

contract PolicyPoolComponentMock is IPolicyPoolComponent {
  IPolicyPool internal immutable _policyPool;

  constructor(IPolicyPool policyPool_) {
    _policyPool = policyPool_;
  }

  function policyPool() external view override returns (IPolicyPool) {
    return _policyPool;
  }

  /**
   * @dev See {IERC165-supportsInterface}.
   */
  function supportsInterface(bytes4 interfaceId) public view virtual override returns (bool) {
    return interfaceId == type(IERC165).interfaceId || interfaceId == type(IPolicyPoolComponent).interfaceId;
  }
}
