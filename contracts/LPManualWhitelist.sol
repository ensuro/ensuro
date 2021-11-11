// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {IPolicyPool} from "../interfaces/IPolicyPool.sol";
import {PolicyPoolComponent} from "./PolicyPoolComponent.sol";
import {ILPWhitelist} from "../interfaces/ILPWhitelist.sol";
import {IEToken} from "../interfaces/IEToken.sol";

/**
 * @title Manual Whitelisting contract
 * @dev LP addresses are whitelisted (and un-whitelisted) manually with transactions by user with given role
 * @author Ensuro
 */
contract LPManualWhitelist is ILPWhitelist, PolicyPoolComponent {
  bytes32 public constant LP_WHITELIST_ROLE = keccak256("LP_WHITELIST_ROLE");

  mapping(address => bool) private _whitelisted;

  event LPWhitelisted(address provider, bool whitelisted);

  // solhint-disable-next-line no-empty-blocks
  constructor(IPolicyPool policyPool_) PolicyPoolComponent(policyPool_) {}

  /**
   * @dev Initializes the Whitelist contract
   */
  function initialize() public initializer {
    __PolicyPoolComponent_init();
  }

  function whitelistAddress(address provider, bool whitelisted)
    external
    onlyPoolRole(LP_WHITELIST_ROLE)
  {
    _whitelisted[provider] = whitelisted;
    emit LPWhitelisted(provider, whitelisted);
  }

  function acceptsDeposit(
    IEToken,
    address provider,
    uint256
  ) external view override returns (bool) {
    return _whitelisted[provider];
  }

  function acceptsTransfer(
    IEToken,
    address,
    address providerTo,
    uint256
  ) external view override returns (bool) {
    return _whitelisted[providerTo];
  }
}
