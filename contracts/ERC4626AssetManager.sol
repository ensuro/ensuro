// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {LiquidityThresholdAssetManager} from "./LiquidityThresholdAssetManager.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

/**
 * @title Asset Manager that deploys the funds into an ERC4626 vault
 * @dev Using liquidity thresholds defined in {LiquidityThresholdAssetManager}, deploys the funds into an ERC4626 vault.
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
contract ERC4626AssetManager is LiquidityThresholdAssetManager {
  IERC4626 internal immutable _vault;

  constructor(IERC20Metadata asset_, IERC4626 vault_) LiquidityThresholdAssetManager(asset_) {
    _vault = vault_;
  }

  function connect() public override {
    super.connect();
    _asset.approve(address(_vault), type(uint256).max); // infinite approval to the vault
  }

  function _invest(uint256 amount) internal override {
    super._invest(amount);
    _vault.deposit(amount, address(this));
  }

  function _deinvest(uint256 amount) internal override {
    super._deinvest(amount);
    _vault.withdraw(amount, address(this), address(this));
  }

  function deinvestAll() external override returns (int256 earnings) {
    DiamondStorage storage ds = diamondStorage();
    uint256 assets = _vault.redeem(_vault.balanceOf(address(this)), address(this), address(this));
    earnings = int256(assets) - int256(uint256(ds.lastInvestmentValue));
    ds.lastInvestmentValue = uint128(assets);
    emit MoneyDeinvested(assets);
    emit EarningsRecorded(earnings);
    return earnings;
  }

  function getInvestmentValue() public view override returns (uint256) {
    return _vault.convertToAssets(_vault.balanceOf(address(this)));
  }
}
