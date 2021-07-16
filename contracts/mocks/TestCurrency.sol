//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
// Don't remove it - required to find the ERC1967Proxy in brownie

contract TestCurrency is ERC20 {
  address private _owner;

  constructor(
    string memory name_,
    string memory symbol_,
    uint256 initialSupply
  ) ERC20(name_, symbol_) {
    _owner = msg.sender;
    _mint(msg.sender, initialSupply);
  }

  function mint(address recipient, uint256 amount) public {
    // require(msg.sender == _owner, "Only owner can mint");
    return _mint(recipient, amount);
  }

  function burn(address recipient, uint256 amount) public {
    // require(msg.sender == _owner, "Only owner can burn");
    return _burn(recipient, amount);
  }
}
