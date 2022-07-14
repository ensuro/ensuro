// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IPolicyPool} from "../interfaces/IPolicyPool.sol";
import {PolicyPoolComponent} from "./PolicyPoolComponent.sol";

/**
 * @title Base contract for Ensuro cash reserves
 * @dev This contract implements the methods related with management of the reserves and payments
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
abstract contract Reserve is PolicyPoolComponent {
  using SafeERC20 for IERC20Metadata;

  /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
  // solhint-disable-next-line var-name-mixedcase
  uint256 public immutable NEGLIGIBLE_AMOUNT; // init as 10**(decimals/2) == 0.001 USD

  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor(IPolicyPool policyPool_) PolicyPoolComponent(policyPool_) {
    NEGLIGIBLE_AMOUNT = 10**(policyPool_.currency().decimals() / 2);
  }

  function _transferTo(address destination, uint256 amount) internal {
    if (amount == 0) return;
    uint256 balance = currency().balanceOf(address(this));
    if (balance < amount && (amount - balance) < NEGLIGIBLE_AMOUNT) amount = balance;
    // TODO: asset management
    currency().safeTransfer(destination, amount);
  }
}
