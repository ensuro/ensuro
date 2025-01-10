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
 * @dev This contract implements the methods related with management of the reserves and payments. {EToken} and
 * {PremiumsAccount} inherit from this contract.
 *
 * These contracts have an asset manager {IAssetManager} that's a strategy contract that runs in the same context
 * (called with delegatecall) that apply some strategy to reinvest the assets managed by the contract to generate
 * additional returns.
 *
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
abstract contract Reserve is PolicyPoolComponent {
  using SafeERC20 for IERC20Metadata;
  using Address for address;

  /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
  // solhint-disable-next-line var-name-mixedcase
  uint256 internal immutable NEGLIGIBLE_AMOUNT; // init as 10**(decimals/2) == 0.001 USD

  /**
   * @dev Reserve constructor. Calculates NEGLIGIBLE_AMOUNT to avoid rounding errors.
   *
   * @param policyPool_ The {PolicyPool} where this reserve will be plugged
   */
  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor(IPolicyPool policyPool_) PolicyPoolComponent(policyPool_) {
    NEGLIGIBLE_AMOUNT = 10 ** (policyPool_.currency().decimals() / 2);
  }

  /**
   * @dev Initializes the Reserve (to be called by subclasses)
   */
  // solhint-disable-next-line func-name-mixedcase
  function __Reserve_init() internal onlyInitializing {
    __PolicyPoolComponent_init();
  }

  /**
   * @dev Refills the reserve's balance, deinvesting from the asset manager to be able to make a payment
   *
   * @param amount The amount of the payment that needs to be made
   * @return Returns the actual amount deinvested (how much the `currency().balanceof(this)` was increased). It might be
   * more than `amount` because the asset manager might want to give more liquidity to the reserve to avoid further
   * deinvestments. After the call, the `currency().balanceof(this)` should be greater than `amount` (unless unsolvency
   * problem).
   */
  function _refillWallet(uint256 amount) internal returns (uint256) {
    address am = address(assetManager());
    if (am != address(0)) {
      bytes memory result = am.functionDelegateCall(
        abi.encodeWithSelector(IAssetManager.refillWallet.selector, amount),
        "Error refilling wallet"
      );
      return abi.decode(result, (uint256));
    }
    return 0;
  }

  /**
   * @dev Internal function that transfers money to a destination. It might need to call `_refillWallet` to deinvest
   * some money to have enough liquidity for the payment.
   *
   * @param destination The destination of the transfer.
   * @param amount The amount to be transferred.
   */
  function _transferTo(address destination, uint256 amount) internal {
    require(destination != address(0), "Reserve: transfer to the zero address");
    if (amount == 0) return;
    uint256 balance = currency().balanceOf(address(this));
    if (balance < amount) {
      balance += _refillWallet(amount);
      if (amount > balance) {
        if ((amount - balance) < NEGLIGIBLE_AMOUNT) {
          amount = balance;
        } // else - No need to do anything since safeTransfer will fail anyway
      }
    }
    currency().safeTransfer(destination, amount);
  }

  /**
   * @dev Returns the address of the asset manager for this reserve. The asset manager is the contract that manages the
   * funds to generate additional yields. Can be `address(0)` if no asset manager has been set.
   */
  function assetManager() public view virtual returns (IAssetManager);

  /**
   * @dev Internal function that needs to be implemented by child contracts because they might store the asset manager
   * address in a different way. This function just stores the value, doesn't do any validation (validations are done on
   * `setAssetManager`.
   *
   * @param newAM The address of the new asset manager for the reserve.
   */
  function _setAssetManager(IAssetManager newAM) internal virtual;

  /**
   * @dev Internal function that needs to be implemented by child contracts to record the earnings (or losses if
   * negative) generated by the asset management.
   *
   * @param earnings The amount of earnings (or losses if negative) generated since last time the earnings were
   * recorded.
   */
  function _assetEarnings(int256 earnings) internal virtual;

  /**
   * @dev Sets the asset manager for this reserve. If the reserve had previously an asset manager, it will deinvest all
   * the funds, making all of the liquid in the reserve balance.
   *
   * Requirements:
   * - The caller must have been granted of global or component roles GUARDIAN_ROLE or LEVEL1_ROLE.
   *
   * Events:
   * - Emits ComponentChanged with action setAssetManager or setAssetManagerForced
   *
   * @param newAM The address of the new asset manager to assign to the reserve. If is `address(0)` it means the reserve
   * will not have an asset manager. If not `address(0)` it MUST be a contract following the IAssetManager interface.
   * @param force When a previous asset manager exists, before setting the new one, the funds are deinvested. When
   * `force` is true, an error in the deinvestAll() operation is ignored. When `force` is false, if `deinvestAll()`
   * fails, it reverts.
   */
  function setAssetManager(
    IAssetManager newAM,
    bool force
  ) external onlyGlobalOrComponentRole2(GUARDIAN_ROLE, LEVEL1_ROLE) {
    require(
      address(newAM) == address(0) || newAM.supportsInterface(type(IAssetManager).interfaceId),
      "Reserve: asset manager doesn't implements the required interface"
    );
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
        /**
         * WARNING: if you are doing a forced replacement of the AM and you want the new AM
         * to inherit the storage (just fixing the code), make sure the code of the new AM doesn't clean
         * the storage in the connect() method (as it is the recommended practice in normal changes of AM).
         */
      } else {
        bytes memory result = am.functionDelegateCall(abi.encodeWithSelector(IAssetManager.deinvestAll.selector));
        _assetEarnings(abi.decode(result, (int256)));
      }
    }
    _setAssetManager(newAM);
    am = address(assetManager());
    if (am != address(0)) {
      am.functionDelegateCall(abi.encodeWithSelector(IAssetManager.connect.selector));
    }
    _componentChanged(action, address(newAM));
  }

  /**
   * @dev Calls {IAssetManager-rebalance} of the assigned asset manager (fails if no asset manager). This operation is
   * intended to give the opportunity to rebalance the liquid and invested for better returns and/or gas optimization.
   *
   * - Emits {IAssetManager-MoneyInvested} or {IAssetManager-MoneyDeinvested}
   */
  function rebalance() public whenNotPaused {
    address(assetManager()).functionDelegateCall(abi.encodeWithSelector(IAssetManager.rebalance.selector));
  }

  /**
   * @dev Calls {IAssetManager-recordEarnings} of the assigned asset manager (fails if no asset manager). The asset
   * manager will return the earnings since last time the earnings where recorded. It then calls `_assetEarnings` to
   * reflect the earnings in the way defined for each reserve.
   *
   * - Emits {IAssetManager-EarningsRecorded}
   */
  function recordEarnings() public whenNotPaused {
    bytes memory result = address(assetManager()).functionDelegateCall(
      abi.encodeWithSelector(IAssetManager.recordEarnings.selector)
    );
    _assetEarnings(abi.decode(result, (int256)));
  }

  /**
   * @dev Function that calls both `recordEarnings()` and `rebalance()` (in that order). Usually scheduled to run once a
   * day by a keeper or crontask.
   */
  function checkpoint() external whenNotPaused {
    recordEarnings();
    rebalance();
  }

  /**
   * @dev This function allows to call custom functions of the asset manager (for example for setting parameters).
   *      This functions will be called with `delegatecall`, in the context of the reserve.
   *
   * Requirements:
   * - The caller must have been granted of global or component roles LEVEL2_ROLE.
   *
   * @param functionCall Abi encoded function call to make.
   * @return Returns the return value of the function called, to be decoded by the receiver.
   */
  function forwardToAssetManager(
    bytes memory functionCall
  ) external onlyGlobalOrComponentRole(LEVEL2_ROLE) returns (bytes memory) {
    return address(assetManager()).functionDelegateCall(functionCall);
  }

  /**
   * @dev This empty reserved space is put in place to allow future versions to add new
   * variables without shifting down storage in the inheritance chain.
   * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
   */
  uint256[50] private __gap;
}
