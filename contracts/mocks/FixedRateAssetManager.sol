// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {BaseAssetManager} from "../BaseAssetManager.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPolicyPool} from "../../interfaces/IPolicyPool.sol";
import {WadRayMath} from "../WadRayMath.sol";
import {IMintableERC20} from "./IMintableERC20.sol";

contract FixedRateAssetManager is BaseAssetManager {
  using SafeERC20 for IERC20Metadata;
  using WadRayMath for uint256;

  uint256 internal constant SECONDS_PER_YEAR = 365 days;

  uint256 public interestRate;
  uint256 public lastMintBurn;

  /// @custom:oz-upgrades-unsafe-allow constructor
  // solhint-disable-next-line no-empty-blocks
  constructor(IPolicyPool policyPool_) BaseAssetManager(policyPool_) {}

  function initialize(
    uint256 liquidityMin_,
    uint256 liquidityMiddle_,
    uint256 liquidityMax_,
    uint256 interestRate_
  ) public initializer {
    __BaseAssetManager_init(liquidityMin_, liquidityMiddle_, liquidityMax_);
    interestRate = interestRate_;
    lastMintBurn = block.timestamp;
  }

  function getInvestmentValue() public view override returns (uint256) {
    uint256 balance = currency().balanceOf(address(this));
    if (lastMintBurn >= block.timestamp) return balance;
    uint256 secs = block.timestamp - lastMintBurn;
    uint256 scale = WadRayMath.ray() + (interestRate * secs) / SECONDS_PER_YEAR;
    return balance.wadMul(scale.rayToWad());
  }

  function _mintBurn() internal {
    if (lastMintBurn >= block.timestamp) return;
    uint256 balance = currency().balanceOf(address(this));
    uint256 currentValue = getInvestmentValue();
    if (currentValue > balance) {
      IMintableERC20(address(currency())).mint(address(this), currentValue - balance);
    } else if (currentValue < balance) {
      IMintableERC20(address(currency())).burn(address(this), balance - currentValue);
    }
    lastMintBurn = block.timestamp;
  }

  function _invest(uint256 amount) internal override {
    _mintBurn();
    super._invest(amount);
    _policyPool.currency().safeTransferFrom(address(_policyPool), address(this), amount);
  }

  function _deinvest(uint256 amount) internal override {
    _mintBurn();
    super._deinvest(amount);
    _policyPool.currency().safeTransfer(address(_policyPool), amount);
  }
}
