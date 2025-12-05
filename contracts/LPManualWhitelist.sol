// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IPolicyPool} from "./interfaces/IPolicyPool.sol";
import {PolicyPoolComponent} from "./PolicyPoolComponent.sol";
import {ILPWhitelist} from "./interfaces/ILPWhitelist.sol";
import {IEToken} from "./interfaces/IEToken.sol";

/**
 * @title Manual Whitelisting contract
 * @notice LP addresses are whitelisted (and un-whitelisted) manually with transactions by user with given role
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
contract LPManualWhitelist is ILPWhitelist, PolicyPoolComponent {
  /**
   * @notice Enum with the different options for whitelisting status
   */
  enum WhitelistOptions {
    undefined,
    whitelisted,
    blacklisted
  }

  struct WhitelistStatus {
    WhitelistOptions deposit;
    WhitelistOptions withdraw;
    WhitelistOptions sendTransfer;
    WhitelistOptions receiveTransfer;
  }

  mapping(address => WhitelistStatus) private _wlStatus;

  error InvalidProvider(address provider);
  error InvalidWhitelistStatus(WhitelistStatus newStatus);

  /**
   * @notice Emitted when the whitelist status for a provider (or the defaults entry at address(0)) is updated.
   *
   * @param provider The provider whose status was changed. `address(0)` denotes the defaults entry.
   * @param whitelisted The new status stored for the provider.
   */
  event LPWhitelistStatusChanged(address provider, WhitelistStatus whitelisted);

  /// @custom:oz-upgrades-unsafe-allow constructor
  // solhint-disable-next-line no-empty-blocks
  constructor(IPolicyPool policyPool_) PolicyPoolComponent(policyPool_) {}

  /**
   * @notice Initializes the Whitelist contract
   */
  function initialize(WhitelistStatus calldata defaultStatus) public virtual initializer {
    __LPManualWhitelist_init(defaultStatus);
  }

  // solhint-disable-next-line func-name-mixedcase
  function __LPManualWhitelist_init(WhitelistStatus calldata defaultStatus) internal onlyInitializing {
    __PolicyPoolComponent_init();
    __LPManualWhitelist_init_unchained(defaultStatus);
  }

  // solhint-disable-next-line func-name-mixedcase
  function __LPManualWhitelist_init_unchained(WhitelistStatus calldata defaultStatus) internal onlyInitializing {
    _checkDefaultStatus(defaultStatus);
    _wlStatus[address(0)] = defaultStatus;
    emit LPWhitelistStatusChanged(address(0), defaultStatus);
  }

  /**
   * @notice Sets a custom whitelist status for `provider`.
   *
   * @param provider The LP address whose status will be updated. Must be non-zero.
   * @param newStatus The status to store for `provider`. Fields may be `undefined` to indicate "use defaults".
   *
   * @custom:pre `provider != address(0)`
   *
   * @custom:throws {InvalidProvider} if `provider == address(0)`
   */
  function whitelistAddress(address provider, WhitelistStatus calldata newStatus) external {
    require(provider != address(0), InvalidProvider(provider));
    _whitelistAddress(provider, newStatus);
  }

  /**
   * @notice Internal validator for the defaults entry. All fields must be explicitly set (non-`undefined`).
   *
   * @param newStatus Candidate defaults status.
   *
   * @custom:pre `newStatus.deposit != WhitelistOptions.undefined`
   * @custom:pre `newStatus.withdraw != WhitelistOptions.undefined`
   * @custom:pre `newStatus.sendTransfer != WhitelistOptions.undefined`
   * @custom:pre `newStatus.receiveTransfer != WhitelistOptions.undefined`
   *
   * @custom:throws {InvalidWhitelistStatus} if any field is `undefined`
   */
  function _checkDefaultStatus(WhitelistStatus calldata newStatus) internal pure {
    require(
      newStatus.deposit != WhitelistOptions.undefined &&
        newStatus.withdraw != WhitelistOptions.undefined &&
        newStatus.sendTransfer != WhitelistOptions.undefined &&
        newStatus.receiveTransfer != WhitelistOptions.undefined,
      InvalidWhitelistStatus(newStatus)
    );
  }

  /**
   * @notice Updates the default whitelist status stored at `_wlStatus[address(0)]`.
   *
   * @param newStatus The new defaults entry. All fields must be non-`undefined`.
   *
   * @custom:pre `newStatus.deposit != WhitelistOptions.undefined`
   * @custom:pre `newStatus.withdraw != WhitelistOptions.undefined`
   * @custom:pre `newStatus.sendTransfer != WhitelistOptions.undefined`
   * @custom:pre `newStatus.receiveTransfer != WhitelistOptions.undefined`
   *
   * @custom:throws {InvalidWhitelistStatus} if any defaults field is `undefined`
   */
  function setWhitelistDefaults(WhitelistStatus calldata newStatus) external {
    _checkDefaultStatus(newStatus);
    _whitelistAddress(address(0), newStatus);
  }

  /**
   * @notice Returns the default whitelist status stored at `_wlStatus[address(0)]`.
   */
  function getWhitelistDefaults() external view returns (WhitelistStatus memory) {
    return _wlStatus[address(0)];
  }

  /**
   * @notice Stores `newStatus` for `provider`.
   *
   * @param provider The provider whose entry is being written.
   * @param newStatus The status to store.
   *
   * @custom:emits {LPWhitelistStatusChanged}
   */
  function _whitelistAddress(address provider, WhitelistStatus memory newStatus) internal {
    _wlStatus[provider] = newStatus;
    emit LPWhitelistStatusChanged(provider, newStatus);
  }

  /**
   * @dev See {IERC165-supportsInterface}.
   */
  function supportsInterface(bytes4 interfaceId) public view virtual override returns (bool) {
    return super.supportsInterface(interfaceId) || interfaceId == type(ILPWhitelist).interfaceId;
  }

  /// @inheritdoc ILPWhitelist
  function acceptsDeposit(IEToken, address provider, uint256) external view override returns (bool) {
    WhitelistOptions wl = _wlStatus[provider].deposit;
    if (wl == WhitelistOptions.undefined) {
      wl = _wlStatus[address(0)].deposit;
    }
    return wl == WhitelistOptions.whitelisted;
  }

  /// @inheritdoc ILPWhitelist
  function acceptsWithdrawal(IEToken, address provider, uint256) external view override returns (bool) {
    WhitelistOptions wl = _wlStatus[provider].withdraw;
    if (wl == WhitelistOptions.undefined) {
      wl = _wlStatus[address(0)].withdraw;
    }
    return wl == WhitelistOptions.whitelisted;
  }

  /// @inheritdoc ILPWhitelist
  function acceptsTransfer(
    IEToken,
    address providerFrom,
    address providerTo,
    uint256
  ) external view override returns (bool) {
    WhitelistOptions wl = _wlStatus[providerFrom].sendTransfer;
    if (wl == WhitelistOptions.undefined) {
      wl = _wlStatus[address(0)].sendTransfer;
    }
    if (wl != WhitelistOptions.whitelisted) return false;
    wl = _wlStatus[providerTo].receiveTransfer;
    if (wl == WhitelistOptions.undefined) {
      wl = _wlStatus[address(0)].receiveTransfer;
    }
    return wl == WhitelistOptions.whitelisted;
  }

  /**
   * @dev This empty reserved space is put in place to allow future versions to add new
   * variables without shifting down storage in the inheritance chain.
   * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
   */
  uint256[49] private __gap;
}
