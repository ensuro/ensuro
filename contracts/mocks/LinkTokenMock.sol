//SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {LinkTokenInterface} from "@chainlink/contracts/src/v0.8/interfaces/LinkTokenInterface.sol";

contract LinkTokenMock is ERC20 {
  address public lastTransferTo;
  uint256 public lastTransferValue;
  bytes public lastTransferData;

  constructor(
    string memory name_,
    string memory symbol_,
    uint256 initialSupply
  ) ERC20(name_, symbol_) {
    _mint(msg.sender, initialSupply);
  }

  function transferAndCall(
    address to,
    uint256 value,
    bytes calldata data
  ) external returns (bool success) {
    lastTransferTo = to;
    lastTransferValue = value;
    lastTransferData = data;
    return true;
  }
}
