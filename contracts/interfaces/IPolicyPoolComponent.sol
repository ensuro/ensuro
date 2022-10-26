// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.16;

import {IPolicyPool} from "./IPolicyPool.sol";

/**
 * @title IPolicyPoolComponent interface
 * @dev Interface for Contracts linked (owned) by a PolicyPool. Useful to avoid cyclic dependencies
 * @author Ensuro
 */
interface IPolicyPoolComponent {
  /**
   * @dev Returns the address of the PolicyPool (see {PolicyPool}) where this component belongs.
   */
  function policyPool() external view returns (IPolicyPool);
}
