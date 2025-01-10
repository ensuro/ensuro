// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {IPolicyPool} from "../interfaces/IPolicyPool.sol";
import {IEToken} from "../interfaces/IEToken.sol";
import {LPManualWhitelistV20} from "./LPManualWhitelistV20.sol";

/**
 * @title Manual Whitelisting contract - Migration from 2.0 to 2.1
 * @dev Contract with the same storage as the LPManualWhitelist 2.0 but that complies with the new interface
 *      useful for update in place of the current whitelist
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
contract LPManualWhitelistV20Upgraded is LPManualWhitelistV20 {
  constructor(IPolicyPool policyPool_) LPManualWhitelistV20(policyPool_) {}

  function acceptsWithdrawal(IEToken etk, address provider, uint256 amount) external view override returns (bool) {
    return this.acceptsDeposit(etk, provider, amount);
  }
}
