// SPDX-License-Identifier: MIT
pragma solidity ^0.8.2;

import "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/CountersUpgradeable.sol";
import "../interfaces/IMintable.sol";

contract PolicyNFT is
  Initializable,
  ERC721Upgradeable,
  PausableUpgradeable,
  AccessControlUpgradeable,
  UUPSUpgradeable,
  IMintable
{
  using CountersUpgradeable for CountersUpgradeable.Counter;

  bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
  bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
  CountersUpgradeable.Counter private _tokenIdCounter;
  bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

  function initialize(
    string memory name_,
    string memory symbol_
  ) initializer public {
    __ERC721_init(name_, symbol_);
    __Pausable_init();
    __AccessControl_init();
    __UUPSUpgradeable_init();

    _setupRole(DEFAULT_ADMIN_ROLE, msg.sender);
    _setupRole(PAUSER_ROLE, msg.sender);
    _setupRole(MINTER_ROLE, msg.sender);
    _setupRole(UPGRADER_ROLE, msg.sender);
    _tokenIdCounter.increment();  // I don't want _tokenId==0
  }

  function safeMint(address to) external override onlyRole(MINTER_ROLE) returns (uint256) {
    uint256 tokenId = _tokenIdCounter.current();
    _safeMint(to, tokenId);
    _tokenIdCounter.increment();
    return tokenId;
  }

  function pause() public onlyRole(PAUSER_ROLE) {
    _pause();
  }

  function unpause() public onlyRole(PAUSER_ROLE) {
    _unpause();
  }

  function _beforeTokenTransfer(address from, address to, uint256 tokenId)
    internal
    whenNotPaused
    override
  {
    super._beforeTokenTransfer(from, to, tokenId);
  }

  function _authorizeUpgrade(address newImplementation)
    internal
    onlyRole(UPGRADER_ROLE)
    override
  {}

  function supportsInterface(bytes4 interfaceId)
    public
    view
    override(ERC721Upgradeable, AccessControlUpgradeable)
    returns (bool)
  {
    return super.supportsInterface(interfaceId);
  }
}
