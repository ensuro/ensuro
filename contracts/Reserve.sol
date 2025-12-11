// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IPolicyPool} from "./interfaces/IPolicyPool.sol";
import {PolicyPoolComponent} from "./PolicyPoolComponent.sol";

/**
 * @title Base contract for Ensuro cash reserves
 * @notice Implements the methods related with management of the reserves and payments. {EToken} and
 * {PremiumsAccount} inherit from this contract.
 *
 * @dev These contracts have an asset manager {IAssetManager} that's a strategy contract that runs in the same context
 * (called with delegatecall) that apply some strategy to reinvest the assets managed by the contract to generate
 * additional returns.
 *
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
abstract contract Reserve is PolicyPoolComponent {
  using SafeERC20 for IERC20Metadata;

  /**
   * @dev Tracks the amount of assets invested in the yieldVault, up to the last time it was recorded
   */
  uint256 internal _invested;

  /// @notice Thrown when the yield vault is unset or invalid for the configured currency.
  error InvalidYieldVault();
  /**
   * @notice Thrown when trying to invest more cash than currently liquid in the reserve.
   * @param required The requested amount of liquid funds
   * @param available The currently available liquid balance
   */
  error NotEnoughCash(uint256 required, uint256 available);
  /**
   * @notice Thrown when attempting to transfer to the zero address.
   * @param receiver The receiver that was provided (cannot be the zero address)
   */
  error ReserveInvalidReceiver(address receiver);

  /**
   * @notice Emitted when the yield vault is changed.
   * @dev When replacing an existing vault, the reserve attempts to redeem the full position (unless `force` is used).
   *
   * @param oldVault The previous yield vault (can be `address(0)`)
   * @param newVault The new yield vault (can be `address(0)`)
   * @param forced True if the switch ignored a partial/failed deinvestment and proceeded anyway
   */
  event YieldVaultChanged(IERC4626 indexed oldVault, IERC4626 indexed newVault, bool forced);

  /**
   * @notice Emitted when a forced deinvestment ignored a redeem failure.
   *
   * @param oldVault The vault that failed to redeem
   * @param shares The number of shares attempted to redeem
   */
  event ErrorIgnoredDeinvestingVault(IERC4626 indexed oldVault, uint256 shares);

  /**
   * @notice Event emitted when investment yields are accounted in the reserve
   *
   * @param earnings The amount of earnings generated since last record. It's positive in the case of earnings or
   * negative when there are losses.
   */
  event EarningsRecorded(int256 earnings);

  /**
   * @dev Reserve constructor
   *
   * @param policyPool_ The {PolicyPool} where this reserve will be plugged
   */
  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor(IPolicyPool policyPool_) PolicyPoolComponent(policyPool_) {}

  /**
   * @dev Initializes the Reserve (to be called by subclasses)
   */
  // solhint-disable-next-line func-name-mixedcase
  function __Reserve_init() internal onlyInitializing {
    __PolicyPoolComponent_init();
  }

  /**
   * @dev Internal function that transfers money to a destination. It might need to call `_deinvest` to deinvest
   *      some money to have enough liquidity for the payment.
   *
   * @param destination The destination of the transfer. If destination == address(this) it doesn't transfer, just
   *                    makes sure the amount is available.
   * @param amount The amount to be transferred.
   *
   * @custom:pre `destination` must not be `address(0)`
   * @custom:pre If a yield vault is configured, it must be compatible with {currency()}
   *
   * @custom:throws ReserveInvalidReceiver if `destination == address(0)`
   */
  function _transferTo(address destination, uint256 amount) internal {
    require(destination != address(0), ReserveInvalidReceiver(destination));
    if (amount == 0) return;
    uint256 balance = _balance();
    if (balance < amount) {
      IERC4626 yv = yieldVault();
      if (address(yv) != address(0)) {
        _deinvest(yv, amount - balance);
      }
      // If balance still < amount, it will fail later...
    }
    if (destination != address(this)) currency().safeTransfer(destination, amount);
  }

  /**
   * @notice Returns the address of the yield vault, where the part of the funds are invested to generate additional
   *      yields. Can be `address(0)` if no yieldVault has been set.
   */
  function yieldVault() public view virtual returns (IERC4626);

  /**
   * @dev Internal function that needs to be implemented by child contracts because they might store the yield vault
   * address in a different way. This function just stores the value, doesn't do any validation (validations are done
   * on `setYieldVault`.
   *
   * @param newYieldVault The address of the new Yield vault. The yield vault is an ERC-4626 compatible vault
   */
  function _setYieldVault(IERC4626 newYieldVault) internal virtual;

  /**
   * @notice Returns the amount of funds that were invested in the yieldVault, up to the last recorded earnings / losses
   */
  function investedInYV() public view returns (uint256) {
    return _invested;
  }

  /**
   * @dev Internal function that needs to be implemented by child contracts to record the earnings (or losses if
   * negative) generated by the yield vault
   *
   * @param earnings The amount of earnings (or losses if negative) generated since last time the earnings were
   * recorded.
   *
   * @custom:emits {EarningsRecorded}
   */
  function _yieldEarnings(int256 earnings) internal virtual {
    emit EarningsRecorded(earnings);
  }

  /**
   * @notice Sets the new yield vault for this reserve. If the reserve had previously a yield vault, it will deinvest all
   * the funds, making all of the liquid in the reserve balance.
   *
   *
   * @param newYieldVault The address of the new yield vault to assign to the reserve. If is `address(0)` it means
   *                      the reserve will not have a yield vault. If not `address(0)` it MUST be an IERC4626
   *                      where `newYieldVault.asset()` equals `.currency()`
   * @param force When a previous yield vault exists, before setting the new one, the funds are deinvested. When
   *              `force` is true, an error in the deinvestment of the assets (or some assets not withdrawable)
   *              will be ignored. When `force` is false, it will revert if `oldVault.balanceOf(address(this)) != 0`.
   * @custom:emits {YieldVaultChanged}
   */
  function setYieldVault(IERC4626 newYieldVault, bool force) external {
    bool forced;
    IERC20Metadata asset = currency();
    require(address(newYieldVault) == address(0) || newYieldVault.asset() == address(asset), InvalidYieldVault());
    IERC4626 oldYV = yieldVault();
    uint256 deinvested;

    if (address(oldYV) != address(0)) {
      uint256 yvShares = oldYV.balanceOf(address(this));
      if (yvShares != 0) {
        if (force) {
          // Never fails, honors maxRedeem and deinvest as much as possible
          (deinvested, forced) = _safeDeInvestAll(oldYV, yvShares);
        } else {
          // Redeems ALL the shares, otherwise, it fails
          deinvested = oldYV.redeem(yvShares, address(this), address(this));
        }
      }
    }
    _setYieldVault(newYieldVault); // Stores the new YV

    // Records the earnings
    _yieldEarnings(int256(deinvested) - int256(_invested));
    _invested = 0;
    emit YieldVaultChanged(oldYV, newYieldVault, forced);
  }

  /**
   * @dev Internal helper to deinvest `amount` assets from `yieldVault_`.
   *
   * It calls `withdraw(amount, address(this), address(this))` on the vault and updates `_invested`,
   * also recording earnings if more than the tracked `_invested` is recovered.
   *
   * Although the protocol usually operates with safe investments where significant losses are not expected,
   * there could be losses anyway. Calls to deinvest should be preceded by a call to `recordEarnings()`
   * in situations where accurate earnings/losses tracking is required (like LP withdrawals).
   *
   * @param yieldVault_ Yield vault to deinvest from
   * @param amount Amount of assets to withdraw from the vault
   */
  function _deinvest(IERC4626 yieldVault_, uint256 amount) internal {
    yieldVault_.withdraw(amount, address(this), address(this));
    if (amount > _invested) {
      // If deinvests more than was already invested, then there's an earning and we have to record it.
      _yieldEarnings(int256(amount - _invested));
      _invested = 0;
    } else {
      _invested -= amount;
    }
  }

  /**
   * @dev Deinvests all the funds or as much as possible, without failing.
   *
   * @param yieldVault_ Yield vault to deinvest from
   * @param sharesToRedeem Initial amount of shares to redeem
   *
   * @return deinvested The amount that was withdrawn from the vault
   * @return forced If true, it indicates that something failed and it wasn't able to withdraw all the funds
   *
   * @custom:emits {ErrorIgnoredDeinvestingVault}
   */
  function _safeDeInvestAll(
    IERC4626 yieldVault_,
    uint256 sharesToRedeem
  ) internal returns (uint256 deinvested, bool forced) {
    try yieldVault_.maxRedeem(address(this)) returns (uint256 result) {
      if (result < sharesToRedeem) {
        forced = true;
        sharesToRedeem = result;
      }
      // solhint-disable-next-line no-empty-blocks
    } catch {}
    try yieldVault_.redeem(sharesToRedeem, address(this), address(this)) returns (uint256 result) {
      deinvested = result;
    } catch {
      emit ErrorIgnoredDeinvestingVault(yieldVault_, sharesToRedeem);
      forced = true;
    }
  }

  /**
   * @dev Returns the liquid balance of `currency()` held directly by this reserve.
   */
  function _balance() internal view returns (uint256) {
    return IERC20Metadata(currency()).balanceOf(address(this));
  }

  /**
   * @notice Deinvest from the vault a given amount.
   *
   * @param amount Amount to withdraw from the `yieldVault()`. If equal type(uint256).max, deinvests maxWithdraw()
   * @return deinvested The amount that was deinvested and added as liquid funds to the reserve
   * @custom:pre yieldVault() != address(0)
   * @custom:pre yieldVault().maxWithdraw(address(this)) >= amount
   *             (this condition is not checked here; exceeding it is expected to revert in the vault during _deinvest()).
   */
  function withdrawFromYieldVault(uint256 amount) external returns (uint256 deinvested) {
    recordEarnings();
    IERC4626 yv = yieldVault();
    if (amount == type(uint256).max) amount = yv.maxWithdraw(address(this));
    _deinvest(yv, amount);
    return amount;
  }

  /**
   * @notice Moves money that's liquid in the contract to the yield vault, to generate yields
   * @param amount Amount to transfer to the `$._yieldVault`. If equal type(uint256).max, transfers `_balance()`
   * @custom:pre _balance() >= amount
   */
  function depositIntoYieldVault(uint256 amount) external {
    IERC4626 yv = yieldVault();
    require(address(yv) != address(0), InvalidYieldVault());
    uint256 balance = _balance();
    if (amount == type(uint256).max) {
      amount = balance;
    } else {
      require(amount <= balance, NotEnoughCash(amount, balance));
    }
    _invested += amount;
    currency().approve(address(yv), amount);
    yv.deposit(amount, address(this));
  }

  /**
   * @dev Computes the value of the assets invested in the yieldVault() and then calls `_yieldEarnings` to
   *      reflect the earnings/losses in the way defined for each reserve.
   * @custom:emits {EarningsRecorded}
   */
  function recordEarnings() public {
    IERC4626 yv = yieldVault();
    require(address(yv) != address(0), InvalidYieldVault());
    uint256 assetsInvested = yv.convertToAssets(yv.balanceOf(address(this)));
    int256 earned = int256(assetsInvested) - int256(_invested);
    if (earned != 0) {
      _invested = assetsInvested;
      _yieldEarnings(earned);
    }
  }

  /**
   * @dev This empty reserved space is put in place to allow future versions to add new
   * variables without shifting down storage in the inheritance chain.
   * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
   */
  uint256[49] private __gap;
}
