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
 * @notice This contract handles the cooldown required before withdrawal of eTokens
 * @dev For each withdrawal position it mints an NFT. The owner of the NFT is who receives the funds when the
 * withdrawal is executed. The value of the eTokens at the execution time can be higher or lower than the value
 * of the eTokens when the withdrawal was scheduled, due to earnings and losses during the cooldown period. If the
 * resulting amount is lower, the LP (owner of the NFT) will receive less. If the value is higher than the value at
 * the schedule period, the LP will receive ONLY the value at the schedule time, and the difference will be
 * distributed to the remaining LPs of the token.
 *
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
contract Cooler is ICooler, PolicyPoolComponent, ERC721Upgradeable {
  using SafeERC20 for IERC20;
  using SafeCast for uint256;
  using Math for uint256;

  /**
   * @notice Struct to store info about the withdrawal request
   * @dev There's one of this for each request (each NFT). It contains the request amount and the request time
   * and expiration.
   */
  struct WithdrawalRequest {
    ETKLib.Scale scaleAtRequest; // in Wad - the scale factor of the eToken at request time
    IEToken etk; // Whitelist for deposits and transfers
    uint128 requestedAmount; // Withdrawal amount requested
    uint40 requestedAt; // Timestamp when the withdrawal was requested
    uint40 expiration; // Timestamp when the withdrawal can be executed
  }

  /// @notice Mapping with the WithdrawalRequest info
  mapping(uint256 => WithdrawalRequest) internal _withdrawalRequests;

  /// @notice Mapping with the cooldown period (in seconds) for each eToken
  mapping(IEToken => uint40) internal _cooldownPeriods;

  /// @notice Mapping with the aggregate amount of pending withdrawals per eToken
  mapping(IEToken => uint256) internal _pendingWithdrawals;

  /// @notice It used for the withdrawal NFTs, starts at 1.
  uint256 internal _nextTokenId;

  /**
   * @notice Event emitted when the cooldown period is changed
   *
   * @param eToken The EToken contract address for which the cooldown period was modified
   * @param oldCooldownPeriod The previous cooldown period value (in seconds)
   * @param newCooldownPeriod The new cooldown period value (in seconds)
   */
  event CooldownPeriodChanged(IEToken indexed eToken, uint40 oldCooldownPeriod, uint40 newCooldownPeriod);

  /**
   * @notice Event emitted when a withdrawal is requested
   *
   * @param eToken The EToken contract from which the withdrawal is being requested
   * @param tokenId The NFT id of the withdrawal position created
   * @param owner The owner initiating the withdrawal request
   * @param when The timestamp when the withdrawal can be executed
   * @param scaleAtRequest The token scale (see {EToken.getCurrentScale(true)}) at the time of the withdrawal request
   * @param amount The amount of eTokens being requested for withdrawal
   */
  event WithdrawalRequested(
    IEToken indexed eToken,
    uint256 indexed tokenId,
    address indexed owner,
    uint40 when,
    ETKLib.Scale scaleAtRequest,
    uint256 amount
  );

  /**
   * @notice Event emitted when a withdrawal is executed
   *
   * @param eToken The EToken contract from which the withdrawal was processed
   * @param tokenId The unique identifier of the token position that was withdrawn
   * @param receiver The address that received the withdrawn funds
   * @param amountRequested The original amount of eTokens requested for withdrawal
   * @param amountWithdrawn The actual amount withdrawn to the receiver
   */
  event WithdrawalExecuted(
    IEToken indexed eToken,
    uint256 indexed tokenId,
    address indexed receiver,
    uint256 amountRequested,
    uint256 amountWithdrawn
  );

  /**
   * @notice Error produced when requesting a withdrawal earlier than the minimum withdrawal period
   */
  error WithdrawalRequestEarlierThanMin(uint40 minRequestTime, uint40 timeRequested);

  /**
   * @notice Error produced when requesting a withdrawal from an eToken that doesn't have address(this) as cooler
   */
  error InvalidEToken(IEToken eToken);

  /**
   * @notice Error produced when trying to execute a withdrawal of an non-existent or already used NFT
   */
  error InvalidWithdrawalRequest(uint256 tokenId);

  /**
   * @notice Error produced when trying to execute a withdrawal ahead of time (WithdrawalRequest.when)
   */
  error WithdrawalNotReady(uint256 tokenId, uint40 expiration);

  /**
   * @notice Error produced when trying to schedule a withdrawal with zero amount
   */
  error CannotDoZeroWithdrawals();

  /// @custom:oz-upgrades-unsafe-allow constructor
  // solhint-disable-next-line no-empty-blocks
  constructor(IPolicyPool policyPool_) PolicyPoolComponent(policyPool_) {}

  /**
   * @notice Initializes the Cooler contract
   *
   * @param name_ ERC721 name attribute of the NFT collection
   * @param symbol_ ERC721 symbol attribute of the NFT collection
   */
  function initialize(string memory name_, string memory symbol_) public virtual initializer {
    __Cooler_init(name_, symbol_);
  }

  // solhint-disable-next-line func-name-mixedcase
  function __Cooler_init(string memory name_, string memory symbol_) internal onlyInitializing {
    __PolicyPoolComponent_init();
    __ERC721_init(name_, symbol_);
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

  /**
   * @notice Sets the cooldown period for a specific EToken
   *
   * @param eToken The EToken contract address to configure the cooldown period for
   * @param newCooldownPeriod The new cooldown period duration in seconds
   *
   * @custom:emits CooldownPeriodChanged event with the old and new cooldown periods
   */
  function setCooldownPeriod(IEToken eToken, uint40 newCooldownPeriod) external {
    emit CooldownPeriodChanged(eToken, _cooldownPeriods[eToken], newCooldownPeriod);
    _cooldownPeriods[eToken] = newCooldownPeriod;
  }

  /**
   * @notice Schedules a withdrawal using EIP-2612 permit for gasless approval
   *
   * @dev This function allows users to schedule withdrawals without prior ERC20 approvals
   * by using EIP-2612 permit signatures for gasless transactions
   *
   * @custom:emits WithdrawalRequested
   *
   * @param eToken The EToken contract from which to withdraw
   * @param when The timestamp when the withdrawal should be executable (when =0 uses the minimum cooldown period)
   * @param amount The amount of eTokens to withdraw
   * @param deadline The expiration timestamp for the permit signature
   * @param v The recovery byte of the signature
   * @param r The R component of the signature
   * @param s The S component of the signature
   * @return tokenId The NFT ID of the token representing the withdrawal position
   */
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

  /**
   * @notice Schedules a withdrawal
   *
   * @custom:emits WithdrawalRequested
   *
   * @param eToken The EToken contract from which to withdraw
   * @param when The timestamp when the withdrawal should be executable (when =0 uses the minimum cooldown period)
   * @param amount The amount of eTokens to withdraw
   * @return tokenId The NFT ID of the token representing the withdrawal position
   */
  function scheduleWithdrawal(IEToken eToken, uint40 when, uint256 amount) external returns (uint256 tokenId) {
    return _scheduleWithdrawal(eToken, when, amount);
  }

  function _scheduleWithdrawal(IEToken eToken, uint40 when, uint256 amount) internal returns (uint256 tokenId) {
    require(eToken.cooler() == address(this), InvalidEToken(eToken));
    if (amount == type(uint256).max) amount = IERC20(address(eToken)).balanceOf(_msgSender());
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

  /**
   * @notice Executes a previously scheduled withdrawal after the cooldown period has elapsed
   * @dev This function processes a withdrawal request that has completed its cooldown period,
   * transferring the underlying tokens to the token owner and cleaning up the withdrawal state.
   *
   * @param tokenId The ID of the token representing the withdrawal position to execute
   *
   * @custom:pre The withdrawal request must exist (`request.requestedAt != 0`)
   * @custom:pre The cooldown period must have elapsed (`block.timestamp >= request.expiration`)
   *
   * @custom:emits WithdrawalExecuted with the requested and actual withdrawn amounts
   */
  function executeWithdrawal(uint256 tokenId) external {
    WithdrawalRequest storage request = _withdrawalRequests[tokenId];
    require(request.requestedAt != 0, InvalidWithdrawalRequest(tokenId));
    require(block.timestamp >= request.expiration, WithdrawalNotReady(tokenId, request.expiration));

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
      // uses balanceOf just in case there's small difference in the funds available to redistribute because
      // of pessimistic rounding
      request.etk.redistribute(
        Math.min(amountAtExecution - amountWithdraw, IERC20(address(request.etk)).balanceOf(address(this)))
      );
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

  /**
   * @notice Returns the current withdrawable value for a given withdrawal position
   *
   * @param tokenId The ID of the token representing the withdrawal position
   * @return The current withdrawable amount in underlying tokens
   */
  function getCurrentValue(uint256 tokenId) external view returns (uint256) {
    WithdrawalRequest storage request = _withdrawalRequests[tokenId];
    if (request.requestedAt == 0) return 0;
    return Math.min(_computeCurrentValue(request), request.requestedAmount);
  }
}
