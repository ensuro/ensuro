// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

/**
 * @title IMintableERC20 interface
 * @dev Interface for mintable / burnable ERC20 - for testing
 * @author Ensuro
 */
interface IMintableERC20 {
  function mint(address recipient, uint256 amount) external;

  function burn(address recipient, uint256 amount) external;
}
