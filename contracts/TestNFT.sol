//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

contract TestNFT is ERC721 {
  address private _owner;

  constructor() ERC721("Test NFT", "NFTEST") {
    _owner = msg.sender;
  }

  function mint(address recipient, uint tokenId) public {
    // require(msg.sender == _owner, "Only owner can mint");
    return _mint(recipient, tokenId);
  }

  function burn(uint tokenId) public {
    require(ERC721.ownerOf(tokenId) == msg.sender, "ERC721: burn of token that is not own");
    return _burn(tokenId);
  }

}
