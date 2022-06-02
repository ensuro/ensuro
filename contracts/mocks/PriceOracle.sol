// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {IPriceOracle} from "../../interfaces/IExchange.sol";

contract PriceOracle is IPriceOracle {
  mapping(address => uint256) internal _prices;

  function getAssetPrice(address asset) external view override returns (uint256) {
    return _prices[asset];
  }

  function setAssetPrice(address asset, uint256 priceInETH) external {
    _prices[asset] = priceInETH;
  }
}
