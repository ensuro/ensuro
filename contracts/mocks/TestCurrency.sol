//SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
// Don't remove it - required to find the ERC1967Proxy in brownie
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IMintableERC20} from "./IMintableERC20.sol";

contract TestCurrency is ERC20, IMintableERC20 {
  address private _owner;
  uint8 internal immutable _decimals;

  constructor(
    string memory name_,
    string memory symbol_,
    uint256 initialSupply,
    uint8 decimals_
  ) ERC20(name_, symbol_) {
    _owner = msg.sender;
    _decimals = decimals_;
    _mint(msg.sender, initialSupply);
  }

  function decimals() public view virtual override returns (uint8) {
    return _decimals;
  }

  function mint(address recipient, uint256 amount) external override {
    // require(msg.sender == _owner, "Only owner can mint");
    return _mint(recipient, amount);
  }

  function burn(address recipient, uint256 amount) external override {
    // require(msg.sender == _owner, "Only owner can burn");
    return _burn(recipient, amount);
  }
}
