//SPDX-License-Identifier: Unlicense
pragma solidity ^0.7.3;
pragma experimental ABIEncoderV2;

import "hardhat/console.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract TestCurrency is ERC20 {
  constructor(uint256 initialSupply) ERC20("Test Currency", "TEST") {
    _mint(msg.sender, initialSupply);
  }
}
