// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {IPolicyPool} from "../interfaces/IPolicyPool.sol";
import {PolicyPoolComponent} from "../PolicyPoolComponent.sol";
import {ILPWhitelist} from "../interfaces/ILPWhitelist.sol";
import {IEToken} from "../interfaces/IEToken.sol";

/**
 * @title Manual Whitelisting contract - V2.0
 * @dev LP addresses are whitelisted (and un-whitelisted) manually with transactions by user with given role
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
abstract contract LPManualWhitelistV20 is ILPWhitelist, PolicyPoolComponent {
  bytes32 public constant LP_WHITELIST_ROLE = keccak256("LP_WHITELIST_ROLE");

  mapping(address => bool) private _whitelisted;

  event LPWhitelisted(address provider, bool whitelisted);

  /// @custom:oz-upgrades-unsafe-allow constructor
  // solhint-disable-next-line no-empty-blocks
  constructor(IPolicyPool policyPool_) PolicyPoolComponent(policyPool_) {}

  /**
   * @dev Initializes the Whitelist contract
   */
  function initialize() public initializer {
    __PolicyPoolComponent_init();
  }

  function whitelistAddress(address provider, bool whitelisted) external onlyComponentRole(LP_WHITELIST_ROLE) {
    if (_whitelisted[provider] != whitelisted) {
      _whitelisted[provider] = whitelisted;
      emit LPWhitelisted(provider, whitelisted);
    }
  }

  /**
   * @dev See {IERC165-supportsInterface}.
   */
  function supportsInterface(bytes4 interfaceId) public view virtual override returns (bool) {
    return super.supportsInterface(interfaceId) || interfaceId == type(ILPWhitelist).interfaceId;
  }

  function acceptsDeposit(IEToken, address provider, uint256) external view override returns (bool) {
    return _whitelisted[provider];
  }

  function acceptsTransfer(IEToken, address, address providerTo, uint256) external view override returns (bool) {
    return _whitelisted[providerTo];
  }

  /**
   * @dev This empty reserved space is put in place to allow future versions to add new
   * variables without shifting down storage in the inheritance chain.
   * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
   */
  uint256[49] private __gap;
}
