//SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.0;

import {Proxy} from "@openzeppelin/contracts/proxy/Proxy.sol";

/**
 * @dev This contract provides a fallback function that forwards all calls to another contract using the EVM
 * instruction `call`.
 *
 * Additionally, delegation to the implementation can be triggered manually through the {_fallback} function, or to a
 * different contract through the {_delegate} function.
 *
 * The success and return data of the delegated call will be returned back to the caller of the proxy.
 */
contract ForwardProxy is Proxy {
  address internal _forwardTo;

  constructor(address forwardTo) {
    _forwardTo = forwardTo;
  }

  /**
   * @dev Delegates the current call to `implementation`.
   *
   * This function does not return to its internall call site, it will return directly to the external caller.
   */
  function _delegate(address implementation) internal virtual override {
    // solhint-disable-next-line no-inline-assembly
    assembly {
      // Copy msg.data. We take full control of memory in this inline assembly
      // block because it will not return to Solidity code. We overwrite the
      // Solidity scratch pad at memory position 0.
      calldatacopy(0, 0, calldatasize())

      // Call the implementation.
      // out and outsize are 0 because we don't know the size yet.
      // let result := delegatecall(gas(), implementation, 0, calldatasize(), 0, 0)
      let result := call(gas(), implementation, 0, 0, calldatasize(), 0, 0)

      // Copy the returned data.
      returndatacopy(0, 0, returndatasize())

      switch result
      // delegatecall returns 0 on error.
      case 0 {
        revert(0, returndatasize())
      }
      default {
        return(0, returndatasize())
      }
    }
  }

  /**
   * @dev This is a virtual function that should be overriden so it returns the address to which the fallback function
   * and {_fallback} should delegate.
   */
  function _implementation() internal view virtual override returns (address) {
    return _forwardTo;
  }

  function setForwardTo(address forwardTo) external {
    _forwardTo = forwardTo;
  }
}
