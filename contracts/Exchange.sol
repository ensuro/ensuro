// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IUniswapV2Router02} from "@uniswap/v2-periphery/contracts/interfaces/IUniswapV2Router02.sol";
import {IPolicyPool} from "../interfaces/IPolicyPool.sol";
import {PolicyPoolComponent} from "./PolicyPoolComponent.sol";
import {IExchange, IPriceOracle} from "../interfaces/IExchange.sol";
import {WadRayMath} from "./WadRayMath.sol";

/**
 * @title Exchange contract
 * @dev Helper contract that handles exchange operations between assets
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
contract Exchange is IExchange, PolicyPoolComponent {
  using WadRayMath for uint256;

  IPriceOracle internal _oracle;
  IUniswapV2Router02 internal _swapRouter; // We will use SushiSwap in Polygon
  uint256 internal _maxSlippage; // Maximum slippage in WAD
  uint256 internal _foo;

  /// @custom:oz-upgrades-unsafe-allow constructor
  // solhint-disable-next-line no-empty-blocks
  constructor(IPolicyPool policyPool_) PolicyPoolComponent(policyPool_) {}

  /**
   * @dev Initializes the RiskModule
   * @param oracle_ Oracle that provides the price of the assets
   * @param swapRouter_ Uniswap compatible exchange
   * @param maxSlippage_ Maximum slippage admitted for exchange operations
   */
  function initialize(
    IPriceOracle oracle_,
    IUniswapV2Router02 swapRouter_,
    uint256 maxSlippage_
  ) public initializer {
    __PolicyPoolComponent_init();
    __Exchange_init(oracle_, swapRouter_, maxSlippage_);
  }

  // solhint-disable-next-line func-name-mixedcase
  function __Exchange_init(
    IPriceOracle oracle_,
    IUniswapV2Router02 swapRouter_,
    uint256 maxSlippage_
  ) internal initializer {
    _oracle = oracle_;
    _swapRouter = swapRouter_;
    _maxSlippage = maxSlippage_;
    _validateParameters();
  }

  function _validateParameters() internal view override {
    require(_maxSlippage <= 1e17, "maxSlippage can't be more than 10%");
    require(address(_oracle) != address(0), "I need a price oracle");
    require(address(_swapRouter) != address(0), "I need a swap router");
  }

  function convert(
    address assetFrom,
    address assetTo,
    uint256 amount
  ) public view override returns (uint256) {
    uint256 exchangeRate = _oracle.getAssetPrice(assetFrom).wadDiv(_oracle.getAssetPrice(assetTo));
    uint8 decFrom = IERC20Metadata(assetFrom).decimals();
    uint8 decTo = IERC20Metadata(assetTo).decimals();
    if (decFrom > decTo) {
      exchangeRate /= 10**(decFrom - decTo);
    } else {
      exchangeRate *= 10**(decTo - decFrom);
    }
    return amount.wadMul(exchangeRate);
  }

  function getAmountIn(
    address assetIn,
    address assetOut,
    uint256 amountOut
  ) external view override returns (uint256) {
    return _swapRouter.getAmountsIn(amountOut, _exchangePath(assetIn, assetOut))[0];
  }

  function getSwapRouter() external view override returns (address) {
    return address(_swapRouter);
  }

  function _exchangePath(address assetIn, address assetOut)
    internal
    pure
    returns (address[] memory)
  {
    address[] memory path = new address[](2);
    path[0] = assetIn;
    path[1] = assetOut;
    return path;
  }

  function sell(
    address assetIn,
    address assetOut,
    uint256 amountInExact,
    address outAddr,
    uint256 deadline
  ) external view override returns (bytes memory) {
    uint256 amountOutMin = convert(assetIn, assetOut, amountInExact).wadMul(1e18 - _maxSlippage);

    return
      abi.encodeWithSignature(
        "swapExactTokensForTokens(uint256,uint256,address[],address,uint256)",
        amountInExact,
        amountOutMin,
        _exchangePath(assetIn, assetOut),
        outAddr,
        deadline
      );
  }

  function decodeSwapOut(bytes memory responseData) external pure override returns (uint256) {
    return abi.decode(responseData, (uint256[]))[1];
  }
}
