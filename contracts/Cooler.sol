// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {ERC721Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {PolicyPoolComponent} from "./PolicyPoolComponent.sol";
import {ICooler} from "./interfaces/ICooler.sol";
import {IEToken} from "./interfaces/IEToken.sol";
import {IPolicyPool} from "./interfaces/IPolicyPool.sol";
import {PolicyPool} from "./PolicyPool.sol";
import {ETKLib} from "./ETKLib.sol";

/**
 * @title Cooler contract
 * @dev This contract handles the cooldown required before withdrawal of eTokens
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
contract Cooler is ICooler, PolicyPoolComponent, ERC721Upgradeable {
  using SafeERC20 for IERC20;
  using SafeCast for uint256;
  using Math for uint256;

  struct WithdrawalRequest {
    ETKLib.Scale scaleAtRequest; // in Wad - the scale factor of the eToken at request time
    IEToken etk; // Whitelist for deposits and transfers
    uint128 requestedAmount; // Withdrawal amount requested
    uint40 requestedAt; // Timestamp when the withdrawal was requested
    uint40 expiration; // Timestamp when the withdrawal can be executed
  }

  mapping(uint256 => WithdrawalRequest) internal _withdrawalRequests;
  mapping(IEToken => uint40) internal _cooldownPeriods;
  mapping(IEToken => uint256) internal _pendingWithdrawals;
  uint256 internal _nextTokenId;

  event CooldownPeriodChanged(IEToken indexed eToken, uint40 oldCooldownPeriod, uint40 newCooldownPeriod);
  event WithdrawalRequested(
    IEToken indexed eToken,
    uint256 indexed tokenId,
    address indexed owner,
    uint40 when,
    ETKLib.Scale scaleAtRequest,
    uint256 amount
  );

  event WithdrawalExecuted(
    IEToken indexed eToken,
    uint256 indexed tokenId,
    address indexed receiver,
    uint256 amountRequested,
    uint256 amountWithdrawn
  );

  error WithdrawalRequestEarlierThanMin(uint40 minRequestTime, uint40 timeRequested);
  error InvalidEToken(IEToken eToken);
  error InvalidWithdrawalRequest(uint256 tokenId);
  error CannotDoZeroWithdrawals();

  /// @custom:oz-upgrades-unsafe-allow constructor
  // solhint-disable-next-line no-empty-blocks
  constructor(IPolicyPool policyPool_) PolicyPoolComponent(policyPool_) {}

  /**
   * @dev Initializes the Whitelist contract
   */
  function initialize() public virtual initializer {
    __Cooler_init();
  }

  // solhint-disable-next-line func-name-mixedcase
  function __Cooler_init() internal onlyInitializing {
    __PolicyPoolComponent_init();
  }

  /// @inheritdoc IERC165
  function supportsInterface(
    bytes4 interfaceId
  ) public view virtual override(ERC721Upgradeable, PolicyPoolComponent) returns (bool) {
    return
      ERC721Upgradeable.supportsInterface(interfaceId) ||
      PolicyPoolComponent.supportsInterface(interfaceId) ||
      interfaceId == type(ICooler).interfaceId;
  }

  /// @inheritdoc ICooler
  function pendingWithdrawals(IEToken eToken) external view override returns (uint256) {
    return _pendingWithdrawals[eToken];
  }

  /// @inheritdoc ICooler
  function cooldownPeriod(
    IEToken eToken,
    address /* owner */,
    uint256 /* amount */
  ) public view override returns (uint40) {
    return _cooldownPeriods[eToken];
  }

  function setCooldownPeriod(IEToken eToken, uint40 newCooldownPeriod) external {
    emit CooldownPeriodChanged(eToken, _cooldownPeriods[eToken], newCooldownPeriod);
    _cooldownPeriods[eToken] = newCooldownPeriod;
  }

  function scheduleWithdrawalWithPermit(
    IEToken eToken,
    uint40 when,
    uint256 amount,
    uint256 deadline,
    uint8 v,
    bytes32 r,
    bytes32 s
  ) external returns (uint256 tokenId) {
    // solhint-disable-next-line no-empty-blocks
    try IERC20Permit(address(eToken)).permit(_msgSender(), address(this), amount, deadline, v, r, s) {} catch {}
    // Check https://github.com/OpenZeppelin/openzeppelin-contracts/blob/1cf13771092c83a060eaef0f8809493fb4c04eb1/contracts/token/ERC20/extensions/IERC20Permit.sol#L16
    // for explanation of this try/catch pattern
    return _scheduleWithdrawal(eToken, when, amount);
  }

  function scheduleWithdrawal(IEToken eToken, uint40 when, uint256 amount) external returns (uint256 tokenId) {
    return _scheduleWithdrawal(eToken, when, amount);
  }

  function _scheduleWithdrawal(IEToken eToken, uint40 when, uint256 amount) internal returns (uint256 tokenId) {
    require(eToken.cooler() == address(this), InvalidEToken(eToken));
    require(amount > 0, CannotDoZeroWithdrawals());
    // Check or compute the withdrawal time
    uint40 minCooldownWhen = uint40(block.timestamp) + cooldownPeriod(eToken, _msgSender(), amount);
    if (when == 0) {
      when = minCooldownWhen;
    } else if (when < minCooldownWhen) {
      revert WithdrawalRequestEarlierThanMin(minCooldownWhen, when);
    }
    // Store withdrawal request
    tokenId = ++_nextTokenId;
    ETKLib.Scale scaleAtRequest = ETKLib.Scale.wrap(uint96(eToken.getCurrentScale(true)));
    _withdrawalRequests[tokenId] = WithdrawalRequest({
      etk: eToken,
      scaleAtRequest: scaleAtRequest,
      requestedAt: uint40(block.timestamp),
      expiration: when,
      requestedAmount: amount.toUint128()
    });
    _pendingWithdrawals[eToken] += amount;
    IERC20(address(eToken)).safeTransferFrom(_msgSender(), address(this), amount);
    _safeMint(_msgSender(), tokenId, abi.encode(_withdrawalRequests[tokenId]));
    emit WithdrawalRequested(eToken, tokenId, _msgSender(), when, scaleAtRequest, amount);
  }

  function executeWithdrawal(uint256 tokenId) external {
    WithdrawalRequest storage request = _withdrawalRequests[tokenId];
    require(request.requestedAt != 0, InvalidWithdrawalRequest(tokenId));

    address receiver = ownerOf(tokenId);
    uint256 amountAtExecution = _computeCurrentValue(request);
    uint256 amountWithdraw = Math.min(amountAtExecution, request.requestedAmount);

    // Clean my storage before calling other contracts
    request.requestedAt = 0; // Delete the request
    _burn(tokenId);
    _pendingWithdrawals[request.etk] -= request.requestedAmount;

    PolicyPool(address(_policyPool)).withdraw(request.etk, amountWithdraw, receiver, address(this));
    if (amountAtExecution > amountWithdraw) {
      // Burn some eTokens to generate additional yields to remaining LPs
      request.etk.redistribute(amountAtExecution - amountWithdraw);
    }
    emit WithdrawalExecuted(request.etk, tokenId, receiver, request.requestedAmount, amountWithdraw);
  }

  function _computeCurrentValue(WithdrawalRequest storage request) internal view returns (uint256) {
    return
      uint256(request.requestedAmount).mulDiv(
        request.etk.getCurrentScale(true), // scaleAtExecution
        ETKLib.Scale.unwrap(request.scaleAtRequest)
      );
  }

  function getCurrentValue(uint256 tokenId) external view returns (uint256) {
    WithdrawalRequest storage request = _withdrawalRequests[tokenId];
    require(request.requestedAt != 0, InvalidWithdrawalRequest(tokenId));
    return Math.min(_computeCurrentValue(request), request.requestedAmount);
  }
}
