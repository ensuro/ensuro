// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {BaseAssetManager} from "./BaseAssetManager.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPolicyPool} from "../interfaces/IPolicyPool.sol";
import {WadRayMath} from "./WadRayMath.sol";
// import {AggregatorV3Interface} from "@chainlink/contracts/src/v0.8/interfaces/AggregatorV3Interface.sol";
import {ILendingPoolAddressesProvider} from "@aave/protocol-v2/contracts/interfaces/ILendingPoolAddressesProvider.sol";
import {ILendingPool} from "@aave/protocol-v2/contracts/interfaces/ILendingPool.sol";
import {IAToken} from "@aave/protocol-v2/contracts/interfaces/IAToken.sol";
import {IPriceOracle} from "@aave/protocol-v2/contracts/interfaces/IPriceOracle.sol";
import {AaveProtocolDataProvider} from "@aave/protocol-v2/contracts/misc/AaveProtocolDataProvider.sol";
import {IUniswapV2Router02} from "@uniswap/v2-periphery/contracts/interfaces/IUniswapV2Router02.sol";

/**
 * @title AssetManager that reinvests the capital in AAVE
 * @dev Deposits and withdraw from AAVE, also converts the rewards
 * @author Ensuro
 */
contract AaveAssetManager is BaseAssetManager {
  using SafeERC20 for IERC20Metadata;
  using WadRayMath for uint256;

  bytes32 public constant SWAP_REWARDS_ROLE = keccak256("SWAP_REWARDS_ROLE");

  ILendingPoolAddressesProvider internal _aaveAddrProv;
  IUniswapV2Router02 internal _swapRouter; // We will use SushiSwap in Polygon

  bytes32 internal constant DATA_PROVIDER_ID =
    0x0100000000000000000000000000000000000000000000000000000000000000;

  uint256 internal constant SECONDS_PER_YEAR = 365 days;

  uint256 public interestRate;
  uint256 public lastMintBurn;

  event RewardSwapped(uint256 rewardIn, uint256 currencyOut);

  function initialize(
    IPolicyPool policyPool_,
    uint256 liquidityMin_,
    uint256 liquidityMiddle_,
    uint256 liquidityMax_,
    ILendingPoolAddressesProvider aaveAddrProv_,
    IUniswapV2Router02 swapRouter_
  ) public initializer {
    __BaseAssetManager_init(policyPool_, liquidityMin_, liquidityMiddle_, liquidityMax_);
    __AaveAssetManager_init(aaveAddrProv_, swapRouter_);
  }

  // solhint-disable-next-line func-name-mixedcase
  function __AaveAssetManager_init(
    ILendingPoolAddressesProvider aaveAddrProv_,
    IUniswapV2Router02 swapRouter_
  ) internal initializer {
    _aaveAddrProv = aaveAddrProv_;
    _swapRouter = swapRouter_;
  }

  function getInvestmentValue() public view override returns (uint256) {
    uint256 balance = aToken().balanceOf(address(this));
    uint256 rewardBalance = rewardToken().balanceOf(address(this)) +
      rewardAToken().balanceOf(address(this));
    return balance + _rewardToCurrency(rewardBalance);
  }

  function lendingPool() public view returns (ILendingPool) {
    return ILendingPool(_aaveAddrProv.getLendingPool());
  }

  function _aaveDataProvider() internal view returns (AaveProtocolDataProvider) {
    return AaveProtocolDataProvider(_aaveAddrProv.getAddress(DATA_PROVIDER_ID));
  }

  function aToken() public view returns (IAToken) {
    (address aToken_, , ) = _aaveDataProvider().getReserveTokensAddresses(address(currency()));
    return IAToken(aToken_);
  }

  function rewardToken() public view returns (IERC20Metadata) {
    return IERC20Metadata(aToken().getIncentivesController().REWARD_TOKEN());
  }

  function rewardAToken() public view returns (IAToken) {
    (address aToken_, , ) = _aaveDataProvider().getReserveTokensAddresses(address(rewardToken()));
    return IAToken(aToken_);
  }

  function _exchangePath() internal view returns (address[] memory) {
    address[] memory path = new address[](2);
    path[0] = address(rewardToken());
    path[1] = address(currency());
    return path;
  }

  function _rewardToCurrency(uint256 amount) internal view returns (uint256) {
    uint256[] memory amountOutMins = _swapRouter.getAmountsOut(amount, _exchangePath());
    return amountOutMins[1];
  }

  function reinvestRewardToken() public {
    ILendingPool lendingPool_ = lendingPool();
    IERC20Metadata token = rewardToken();
    uint256 rewardBalance = token.balanceOf(address(this));
    if (rewardBalance == 0) return;
    token.approve(address(lendingPool_), rewardBalance);
    lendingPool_.deposit(address(token), rewardBalance, address(this), 0);
  }

  function _swapRewards(uint256 amount, address outAddr) internal returns (uint256, uint256) {
    address[] memory path = _exchangePath();
    uint256 swapIn = IERC20Metadata(path[0]).balanceOf(address(this));
    if (swapIn < amount) {
      uint256 toWithdraw = amount - swapIn;
      if (rewardAToken().balanceOf(address(this)) < toWithdraw) {
        toWithdraw = type(uint256).max; // if not enought withdraw all
      }
      swapIn += lendingPool().withdraw(path[0], toWithdraw, address(this));
    } else {
      swapIn = amount;
    }
    uint256 swapOutMin = _swapRouter.getAmountsOut(swapIn, path)[1];
    IERC20Metadata(path[0]).approve(address(_swapRouter), swapIn);
    uint256[] memory amounts = _swapRouter.swapExactTokensForTokens(
      swapIn,
      swapOutMin,
      path,
      outAddr,
      block.timestamp
    );
    emit RewardSwapped(swapIn, amounts[1]);
    return (swapIn, amounts[1]);
  }

  function swapRewards(uint256 amount)
    external
    onlyPoolRole(SWAP_REWARDS_ROLE)
    returns (uint256, uint256)
  {
    (uint256 swapIn, uint256 swapOut) = _swapRewards(amount, address(this));
    ILendingPool lendingPool_ = lendingPool();
    IERC20Metadata token = currency();
    token.approve(address(lendingPool_), swapOut);
    lendingPool_.deposit(address(token), swapOut, address(this), 0);
    return (swapIn, swapOut);
  }

  function rebalance() public virtual override whenNotPaused {
    super.rebalance();
    reinvestRewardToken();
  }

  function _invest(uint256 amount) internal override {
    ILendingPool lendingPool_ = lendingPool();
    IERC20Metadata token = currency();
    token.safeTransferFrom(address(_policyPool), address(this), amount);
    token.approve(address(lendingPool_), amount);
    lendingPool_.deposit(address(token), amount, address(this), 0);
    super._invest(amount);
  }

  function _deinvest(uint256 amount) internal override {
    uint256 remainingAmount = amount;
    // Withdraw directly to _policyPool
    uint256 toWithdraw = amount;
    if (aToken().balanceOf(address(this)) < toWithdraw) {
      toWithdraw = type(uint256).max;
    }
    remainingAmount -= lendingPool().withdraw(
      address(currency()),
      toWithdraw,
      address(_policyPool)
    );
    if (remainingAmount > 0) {
      uint256 requiredRewards = _swapRouter.getAmountsIn(remainingAmount, _exchangePath())[0];
      (, uint256 currencyOut) = _swapRewards(requiredRewards, address(_policyPool));
      if (currencyOut < remainingAmount) {
        remainingAmount -= currencyOut;
      } else {
        remainingAmount = 0;
      }
    }
    super._deinvest(amount - remainingAmount);
  }
}
