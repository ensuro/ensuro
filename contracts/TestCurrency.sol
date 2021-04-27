//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract TestCurrency is ERC20 {
  constructor(uint256 initialSupply) ERC20("Test Currency", "TEST") {
    _mint(msg.sender, initialSupply);
  }
}
