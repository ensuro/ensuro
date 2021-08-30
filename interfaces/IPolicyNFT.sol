// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {IERC721Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC721/IERC721Upgradeable.sol";

/**
 * @title IPolicyNFT interface
 * @dev Interface for mintable NFT token that returns tokenId
 * @author Ensuro
 */
interface IPolicyNFT is IERC721Upgradeable {
  function safeMint(address to) external returns (uint256);

  function connect() external;
}
