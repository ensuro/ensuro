// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IEToken} from "./interfaces/IEToken.sol";
import {ILPWhitelist} from "./interfaces/ILPWhitelist.sol";

// Internal interface to access whitelist() on the underlying EToken without modifying IEToken,
// which would require changes to PolicyPool's interface checks.
interface IETokenWithWhitelist is IEToken {
  function whitelist() external view returns (ILPWhitelist);
}

/**
 * @title WEToken - Non-rebasing ERC-4626 wrapper for Ensuro EToken
 * @notice Wraps the rebasing EToken into a non-rebasing ERC-4626 vault token with static balances.
 *         1 WEToken (share) = 1 unit of scaled balance in the underlying EToken.
 *         As the EToken accrues yield, each WEToken becomes redeemable for more eTokens.
 * @dev The conversion between eTokens (assets) and WETokens (shares) uses {IEToken-getCurrentScale}:
 *        shares = assets * WAD / scale
 *        assets = shares * scale / WAD
 *      If the underlying eToken has a whitelist, this contract's address must be whitelisted.
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
contract WEToken is ERC4626, ERC20Permit, Ownable {
  uint256 internal constant WAD = 1e18;

  /// @notice Thrown when a transfer is attempted from a frozen account
  error FrozenAccount(address account);

  /// @notice Thrown when {setFrozen} is called by an unauthorized address (freezer is set and caller is not the freezer)
  error NotFreezer();

  /// @notice Thrown when the requested frozen state conflicts with the eToken whitelist's sendTransfer decision
  error FrozenStateMismatch(address user, bool whitelistFrozen, bool newFrozenState);

  /// @notice Thrown when freezer is address(0) and the eToken has no whitelist to validate against
  error NoWhitelistConfigured();

  /// @notice Emitted when an account is frozen or unfrozen
  event AccountFrozen(address indexed account, bool frozen);

  /// @notice Emitted when the freezer address is changed by the owner
  event FreezerChanged(address indexed oldFreezer, address indexed newFreezer);

  /**
   * @notice Address authorized to call {setFrozen}. If address(0), anyone may call it but
   *         the freeze is always validated against the eToken's whitelist (open-freeze / cache mode).
   *         Can be changed by the owner via {setFreezer}.
   */
  address public freezer;

  /**
   * @notice Tracks frozen accounts; frozen accounts cannot transfer WETokens out
   * @dev When the eToken has a whitelist, this acts as a cache of whatever is enabled or not for the eToken.
   *      An account can't be frozen unless it can't transfer out normal eTokens (checked from the whitelist), and
   *      can't be unfrozen unless it CAN transfer out normal eTokens.
   */
  mapping(address => bool) public frozen;

  /**
   * @param eToken_ The underlying rebasing EToken to wrap
   * @param name_ Name for the wrapped token
   * @param symbol_ Symbol for the wrapped token
   * @param freezer_ Initial address authorized to freeze/unfreeze accounts. Use address(0) for
   *                 open freeze mode (anyone can call, validated against the eToken's whitelist).
   * @param owner_ Initial owner, authorized to change the freezer via {setFreezer}.
   */
  constructor(
    IEToken eToken_,
    string memory name_,
    string memory symbol_,
    address freezer_,
    address owner_
  ) ERC4626(IERC20(address(eToken_))) ERC20(name_, symbol_) ERC20Permit(name_) Ownable(owner_) {
    _setFreezer(freezer_);
  }

  /// @inheritdoc ERC4626
  function decimals() public pure override(ERC4626, ERC20) returns (uint8) {
    return 18;
  }

  /// @dev Uses the eToken scale directly rather than the totalAssets/totalSupply ratio.
  function _convertToShares(uint256 assets, Math.Rounding rounding) internal view override returns (uint256) {
    return Math.mulDiv(assets, WAD, IEToken(asset()).getCurrentScale(true), rounding);
  }

  /// @dev Uses the eToken scale directly rather than the totalAssets/totalSupply ratio.
  function _convertToAssets(uint256 shares, Math.Rounding rounding) internal view override returns (uint256) {
    return Math.mulDiv(shares, IEToken(asset()).getCurrentScale(true), WAD, rounding);
  }

  /**
   * @dev Blocks any share movement where `from` is frozen (transfers and burns).
   *      Deposit (mint: from == address(0)) is already gated by the eToken's safeTransferFrom —
   *      a blacklisted user's eToken transfer will revert at the eToken level.
   *      Burns (redeem/withdraw) must also be blocked: ERC-4626 allows an arbitrary `receiver`,
   *      so a frozen owner could otherwise drain their underlying eTokens to another address.
   */
  function _update(address from, address to, uint256 value) internal override {
    if (from != address(0)) {
      require(!frozen[from], FrozenAccount(from));
    }
    super._update(from, to, value);
  }

  /**
   * @notice Updates the authorized freezer address.
   * @param newFreezer The new freezer. Use address(0) to switch to open-freeze / cache mode.
   */
  function setFreezer(address newFreezer) external onlyOwner {
    _setFreezer(newFreezer);
  }

  function _setFreezer(address newFreezer) internal {
    emit FreezerChanged(freezer, newFreezer);
    freezer = newFreezer;
  }

  /**
   * @notice Freezes or unfreezes an account.
   *
   * @dev Caller must be the freezer or, when freezer is address(0), anyone may call.
   *      The eToken's whitelist is always consulted when it is configured: freezing requires the
   *      whitelist to reject the user's sendTransfer; unfreezing requires it to accept.
   *      When there is no whitelist, the call only succeeds if freezer != address(0) (an
   *      authorized freezer may act without a whitelist, but open-freeze mode requires one).
   *
   * @param user    The account to freeze or unfreeze.
   * @param frozen_ True to freeze, false to unfreeze.
   */
  function setFrozen(address user, bool frozen_) external {
    require(freezer == address(0) || freezer == msg.sender, NotFreezer());
    ILPWhitelist wl = IETokenWithWhitelist(address(asset())).whitelist();
    if (address(wl) != address(0)) {
      bool wlFrozen = !wl.acceptsOperation(IEToken(asset()), user, ILPWhitelist.Operation.sendTransfer);
      require(frozen_ == wlFrozen, FrozenStateMismatch(user, wlFrozen, frozen_));
    } else {
      require(freezer != address(0), NoWhitelistConfigured());
    }
    frozen[user] = frozen_;
    emit AccountFrozen(user, frozen_);
  }
}
