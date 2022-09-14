// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IPolicyPool} from "./interfaces/IPolicyPool.sol";
import {IAssetManager} from "./interfaces/IAssetManager.sol";
import {IAccessManager} from "./interfaces/IAccessManager.sol";
import {PolicyPoolComponent} from "./PolicyPoolComponent.sol";

/**
 * @title Base contract for Ensuro cash reserves
 * @dev This contract implements the methods related with management of the reserves and payments
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
abstract contract Reserve is PolicyPoolComponent {
  using SafeERC20 for IERC20Metadata;
  using Address for address;

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
    if (balance < amount) {
      address am = address(assetManager());
      if (am != address(0)) {
        am.functionDelegateCall(
          abi.encodeWithSelector(IAssetManager.refillWallet.selector, amount),
          "Error refilling wallet"
        );
      }
      if ((amount - balance) < NEGLIGIBLE_AMOUNT) amount = balance;
    }
    currency().safeTransfer(destination, amount);
  }

  function assetManager() public view virtual returns (IAssetManager);

  function _setAssetManager(IAssetManager newAM) internal virtual;

  function _assetEarnings(int256 earnings) internal virtual;

  function setAssetManager(IAssetManager newAM, bool force)
    external
    onlyPoolRole2(GUARDIAN_ROLE, LEVEL1_ROLE)
  {
    require(address(newAM).isContract(), "The assetManager is not a contract!");
    address am = address(assetManager());
    IAccessManager.GovernanceActions action = IAccessManager.GovernanceActions.setAssetManager;
    if (am != address(0)) {
      if (force) {
        // Ignores success or not
        // solhint-disable-next-line avoid-low-level-calls
        (bool success, bytes memory result) = am.delegatecall(
          abi.encodeWithSelector(IAssetManager.deinvestAll.selector)
        );
        if (!success) {
          action = IAccessManager.GovernanceActions.setAssetManagerForced;
        } else {
          _assetEarnings(abi.decode(result, (int256)));
        }
      } else {
        bytes memory result = am.functionDelegateCall(
          abi.encodeWithSelector(IAssetManager.deinvestAll.selector)
        );
        _assetEarnings(abi.decode(result, (int256)));
      }
    }
    _setAssetManager(newAM);
    am = address(assetManager());
    if (am != address(0)) {
      am.functionDelegateCall(abi.encodeWithSelector(IAssetManager.connect.selector));
    }
    emit ComponentChanged(action, address(newAM));
  }

  function rebalance() public whenNotPaused {
    address am = address(assetManager());
    require(am != address(0), "No asset manager");
    am.functionDelegateCall(abi.encodeWithSelector(IAssetManager.rebalance.selector));
  }

  function recordEarnings() public whenNotPaused {
    address am = address(assetManager());
    require(am != address(0), "No asset manager");
    bytes memory result = am.functionDelegateCall(
      abi.encodeWithSelector(IAssetManager.recordEarnings.selector)
    );
    _assetEarnings(abi.decode(result, (int256)));
  }

  function checkpoint() external whenNotPaused {
    recordEarnings();
    rebalance();
  }

  function forwardToAssetManager(bytes memory functionCall)
    external
    onlyComponentRole(LEVEL2_ROLE)
    returns (bytes memory)
  {
    address am = address(assetManager());
    return am.functionDelegateCall(functionCall);
  }
}
