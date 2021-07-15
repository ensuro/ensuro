//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

contract TestNFT is ERC721 {
  address private _owner;

  constructor(string memory name_, string memory symbol_) ERC721(name_, symbol_) {
    _owner = msg.sender;
  }

  function mint(address recipient, uint256 tokenId) public {
    // require(msg.sender == _owner, "Only owner can mint");
    return _mint(recipient, tokenId);
  }

  function burn(uint256 tokenId) public {
    require(ERC721.ownerOf(tokenId) == msg.sender, "ERC721: burn of token that is not own");
    return _burn(tokenId);
  }
}
