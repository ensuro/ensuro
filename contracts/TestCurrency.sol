//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract TestCurrency is ERC20 {
  address private _owner;

  constructor(uint256 initialSupply) ERC20("Test Currency", "TEST") {
    _owner = msg.sender;
    _mint(msg.sender, initialSupply);
  }

  function mint(address recipient, uint amount) public {
    // require(msg.sender == _owner, "Only owner can mint");
    return _mint(recipient, amount);
  }

  function burn(address recipient, uint amount) public {
    // require(msg.sender == _owner, "Only owner can burn");
    return _burn(recipient, amount);
  }

}
