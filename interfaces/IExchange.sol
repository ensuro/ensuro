// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

/**
 * @title IPriceOracle - Interface for external price oracle to get assets' prices
 * @author Ensuro
 */
interface IPriceOracle {
  /**
   * @dev Returns the price of the asset in ETH
   * @param asset Address of a ERC20 asset
   * @return Price of the asset in ETH (Wad)
   */
  function getAssetPrice(address asset) external view returns (uint256);
}

/**
 * @title IExchange - Interface that handles exchange operations between tokens
 * @author Ensuro
 */
interface IExchange {
  function convert(
    address assetFrom,
    address assetTo,
    uint256 amount
  ) external view returns (uint256);

  function getAmountIn(
    address assetIn,
    address assetOut,
    uint256 amountOut
  ) external view returns (uint256);

  function getSwapRouter() external view returns (address);

  function getPriceOracle() external view returns (IPriceOracle);

  function sell(
    address assetIn,
    address assetOut,
    uint256 amountInExact,
    address outAddr,
    uint256 deadline
  ) external view returns (bytes memory);

  function decodeSwapOut(bytes memory responseData) external view returns (uint256);
}
