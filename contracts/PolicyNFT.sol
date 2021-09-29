// SPDX-License-Identifier: MIT
pragma solidity ^0.8.2;

import {ERC721Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import {CountersUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/CountersUpgradeable.sol";
import {PolicyPoolComponent} from "./PolicyPoolComponent.sol";
import {IPolicyPool} from "../interfaces/IPolicyPool.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IPolicyNFT} from "../interfaces/IPolicyNFT.sol";

contract PolicyNFT is ERC721Upgradeable, PolicyPoolComponent, IPolicyNFT {
  using CountersUpgradeable for CountersUpgradeable.Counter;

  CountersUpgradeable.Counter private _tokenIdCounter;

  function initialize(
    string memory name_,
    string memory symbol_,
    IPolicyPool policyPool_
  ) public initializer {
    __ERC721_init(name_, symbol_);
    __PolicyPoolComponent_init(IPolicyPool(address(0)));
    __PolicyNFT_init_unchained(policyPool_);
  }

  // solhint-disable-next-line func-name-mixedcase
  function __PolicyNFT_init_unchained(IPolicyPool policyPool_) internal initializer {
    _policyPool = policyPool_;
    _tokenIdCounter.increment(); // I don't want _tokenId==0
  }

  function connect() external override {
    require(
      address(_policyPool) == address(0) || address(_policyPool) == _msgSender(),
      "PolicyPool already connected"
    );
    _policyPool = IPolicyPool(_msgSender());
    // Not possible to do this validation because connect is called in _policyPool initialize :'(
    // require(_policyPool.config() == this, "PolicyPool not connected to this config");
  }

  function safeMint(address to) external override onlyPolicyPool whenNotPaused returns (uint256) {
    uint256 tokenId = _tokenIdCounter.current();
    _safeMint(to, tokenId);
    _tokenIdCounter.increment();
    return tokenId;
  }

  function _beforeTokenTransfer(
    address from,
    address to,
    uint256 tokenId
  ) internal override whenNotPaused {
    super._beforeTokenTransfer(from, to, tokenId);
  }
}
