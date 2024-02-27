// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.16;

import {IPolicyPool} from "./interfaces/IPolicyPool.sol";
import {PolicyPoolComponent} from "./PolicyPoolComponent.sol";
import {ILPWhitelist} from "./interfaces/ILPWhitelist.sol";
import {IEToken} from "./interfaces/IEToken.sol";

/**
 * @title Manual Whitelisting contract
 * @dev LP addresses are whitelisted (and un-whitelisted) manually with transactions by user with given role
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
contract LPManualWhitelist is ILPWhitelist, PolicyPoolComponent {
  bytes32 public constant LP_WHITELIST_ROLE = keccak256("LP_WHITELIST_ROLE");
  bytes32 public constant LP_WHITELIST_ADMIN_ROLE = keccak256("LP_WHITELIST_ADMIN_ROLE");

  /**
   * @dev Enum with the different options for whitelisting status
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

  event LPWhitelistStatusChanged(address provider, WhitelistStatus whitelisted);

  /// @custom:oz-upgrades-unsafe-allow constructor
  // solhint-disable-next-line no-empty-blocks
  constructor(IPolicyPool policyPool_) PolicyPoolComponent(policyPool_) {}

  /**
   * @dev Initializes the Whitelist contract
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

  function whitelistAddress(
    address provider,
    WhitelistStatus calldata newStatus
  ) external onlyComponentRole(LP_WHITELIST_ROLE) {
    require(provider != address(0), "You can't change the defaults");
    _whitelistAddress(provider, newStatus);
  }

  function _checkDefaultStatus(WhitelistStatus calldata newStatus) internal pure {
    require(
      newStatus.deposit != WhitelistOptions.undefined &&
        newStatus.withdraw != WhitelistOptions.undefined &&
        newStatus.sendTransfer != WhitelistOptions.undefined &&
        newStatus.receiveTransfer != WhitelistOptions.undefined,
      "You need to define the default status for all the operations"
    );
  }

  function setWhitelistDefaults(
    WhitelistStatus calldata newStatus
  ) external onlyComponentRole(LP_WHITELIST_ADMIN_ROLE) {
    _checkDefaultStatus(newStatus);
    _whitelistAddress(address(0), newStatus);
  }

  function getWhitelistDefaults() external view returns (WhitelistStatus memory) {
    return _wlStatus[address(0)];
  }

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

  function acceptsDeposit(IEToken, address provider, uint256) external view override returns (bool) {
    WhitelistOptions wl = _wlStatus[provider].deposit;
    if (wl == WhitelistOptions.undefined) {
      wl = _wlStatus[address(0)].deposit;
    }
    return wl == WhitelistOptions.whitelisted;
  }

  function acceptsWithdrawal(IEToken, address provider, uint256) external view override returns (bool) {
    WhitelistOptions wl = _wlStatus[provider].withdraw;
    if (wl == WhitelistOptions.undefined) {
      wl = _wlStatus[address(0)].withdraw;
    }
    return wl == WhitelistOptions.whitelisted;
  }

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
