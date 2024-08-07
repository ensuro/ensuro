// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {ERC4626AssetManager} from "./ERC4626AssetManager.sol";
import {LiquidityThresholdAssetManager} from "./LiquidityThresholdAssetManager.sol";

/**
 * @title Asset Manager that deploys the funds into a given ERC4626 but also, at request, can deploy the funds in
 *         another vault, the discretionary vault.
 * @dev Using liquidity thresholds defined in {LiquidityThresholdAssetManager}, deploys the funds into _vault.
 *      By request of the administrator it can also deploy the funds in _discretionaryVault. When deinvesting, if
 *      funds in _vault are not enough, it tries to withdraw from _discretionaryVault.
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
contract ERC4626PlusVaultAssetManager is ERC4626AssetManager {
  IERC4626 internal immutable _discretionaryVault;

  constructor(
    IERC20Metadata asset_,
    IERC4626 vault_,
    IERC4626 discretionaryVault_
  ) ERC4626AssetManager(asset_, vault_) {
    require(address(discretionaryVault_) != address(0), "ERC4626PlusVaultAssetManager: vault cannot be zero address");
    require(
      address(asset_) == discretionaryVault_.asset(),
      "ERC4626PlusVaultAssetManager: vault must have the same asset"
    );
    _discretionaryVault = discretionaryVault_;
  }

  function _deinvest(uint256 amount) internal virtual override {
    LiquidityThresholdAssetManager._deinvest(amount);
    uint256 vaultAmount = Math.min(amount, _vault.maxWithdraw(address(this)));
    if (vaultAmount != 0) _vault.withdraw(vaultAmount, address(this), address(this));
    if (amount - vaultAmount != 0) _discretionaryVault.withdraw(amount - vaultAmount, address(this), address(this));
  }

  function connect() public override {
    super.connect();
    _asset.approve(address(_discretionaryVault), type(uint256).max); // infinite approval to the vault
  }

  function deinvestAll() external virtual override returns (int256 earnings) {
    DiamondStorage storage ds = diamondStorage();
    uint256 fromVault = _vault.redeem(_vault.balanceOf(address(this)), address(this), address(this));
    /**
     * WARNING: this was implemented withdrawing as much as possible from the vault WITHOUT failing.
     * This implementation might leave some assets (those that aren't withdrawable) in the vault and those will
     * be reported as losses.
     */
    uint256 redeemable = _discretionaryVault.maxRedeem(address(this));
    uint256 fromDiscVault = redeemable != 0 ? _discretionaryVault.redeem(redeemable, address(this), address(this)) : 0;
    earnings = int256(fromVault + fromDiscVault) - int256(uint256(ds.lastInvestmentValue));
    ds.lastInvestmentValue = 0;
    emit MoneyDeinvested(fromDiscVault + fromVault);
    emit EarningsRecorded(earnings);
    return earnings;
  }

  function _erc4626Assets(IERC4626 vault) internal view returns (uint256) {
    return vault.convertToAssets(vault.balanceOf(address(this)));
  }

  function getInvestmentValue() public view virtual override returns (uint256) {
    return _erc4626Assets(_vault) + _erc4626Assets(_discretionaryVault);
  }

  /**
   * @dev Transfers the given amount from _vault to the _discretionaryVault
   *
   * @param amount The amount to transfer. If that amount isn't available in _vault it reverts.
   *               If amount = type(uint256).max it withdraws all the withdrawable funds from _vault.
   */
  function vaultToDiscretionary(uint256 amount) external {
    if (amount == type(uint256).max) amount = _vault.maxWithdraw(address(this));
    _vault.withdraw(amount, address(this), address(this));
    _discretionaryVault.deposit(amount, address(this));
  }

  /**
   * @dev Transfers the given amount from the _discretionaryVault to _vault
   *
   * @param amount The amount to transfer. If that amount isn't available in the _discretionaryVault it reverts.
   *               If amount = type(uint256).max it withdraws all the funds withdrawable in the _discretionaryVault
   */
  function discretionaryToVault(uint256 amount) external {
    uint256 withdrawn;
    if (amount == type(uint256).max) {
      withdrawn = _discretionaryVault.redeem(
        _discretionaryVault.maxRedeem(address(this)),
        address(this),
        address(this)
      );
    } else {
      _discretionaryVault.withdraw(amount, address(this), address(this));
      withdrawn = amount;
    }
    _vault.deposit(withdrawn, address(this));
  }
}
