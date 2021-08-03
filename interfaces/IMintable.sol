// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

/**
 * @title IMintable interface
 * @dev Interface for mintable NFT token that returns tokenId
 * @author Ensuro
 */
interface IMintable {
  function safeMint(address to) external returns (uint256);
}
