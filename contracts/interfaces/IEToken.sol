// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/**
 * @title IEToken interface
 * @notice Interface for EToken smart contracts, these are the capital pools.
 * @author Ensuro
 */
interface IEToken {
  /**
   * @notice Enum of the configurable parameters in an EToken.
   *
   * @dev These are the supported parameter types:
   * - liquidityRequirement: target solvency/liquidity constraint (typically 1, scales the SCR to lock more)
   * - minUtilizationRate: lower bound for utilization rate after deposits (prevents excess idle liquidity)
   * - maxUtilizationRate: upper bound for utilization rate after capital lock (prevents locking all the capital)
   * - internalLoanInterestRate: annualized rate charged on internal loans (wad)
   */
  enum Parameter {
    liquidityRequirement,
    minUtilizationRate,
    maxUtilizationRate,
    internalLoanInterestRate
  }

  /**
   * @notice Event emitted when part of the funds of the eToken are locked as solvency capital.
   * @param policyId The id of the policy that locks the capital
   * @param interestRate The annualized interestRate paid for the capital (wad)
   * @param value The amount locked
   */
  event SCRLocked(uint256 indexed policyId, uint256 interestRate, uint256 value);

  /**
   * @notice Event emitted when the locked funds are unlocked and no longer used as solvency capital.
   * @param policyId The id of the policy that unlocks the capital (should be the that locked before with SCRLocked)
   * @param interestRate The annualized interestRate that was paid for the capital (wad)
   * @param value The amount unlocked
   * @param adjustment Discrete amount of adjustment done to the totalSupply to reflect when more or less
   *                   than the received cost of capital has been accrued since the SCR was locked.
   */
  event SCRUnlocked(uint256 indexed policyId, uint256 interestRate, uint256 value, int256 adjustment);

  /**
   * @notice Returns the amount of capital that's locked as solvency capital for active policies.
   */
  function scr() external view returns (uint256);

  /**
   * @notice Locks part of the liquidity of the EToken as solvency capital.
   *
   * @param policyId The id of the policy that locks the capital
   * @param scrAmount The amount to lock
   * @param policyInterestRate The annualized interest rate (wad) to be paid for the `scrAmount`
   *
   * @custom:pre Must be called by a _borrower_ (PremiumsAccount) previously added with `addBorrower`.
   * @custom:pre `scrAmount` <= `fundsAvailableToLock()`
   *
   * @custom:emits SCRLocked
   */
  function lockScr(uint256 policyId, uint256 scrAmount, uint256 policyInterestRate) external;

  /**
   * @notice Unlocks solvency capital previously locked with `lockScr`.
   * @dev The capital no longer needed as solvency, enabling withdrawal.
   *
   * @param policyId The id of the policy that locked the scr originally
   * @param scrAmount The amount to unlock
   * @param policyInterestRate The annualized interest rate that was paid for the `scrAmount`, must be the same that
   *                           was sent in `lockScr` call.
   * @param adjustment Discrete amount of adjustment done to the totalSupply to reflect when more or less
   *                   than the received cost of capital has been accrued since the SCR was locked.
   *
   * @custom:pre Must be called by a _borrower_ (PremiumsAccount) previously added with `addBorrower`.
   * @custom:pre `scrAmount` must be <= {scr}
   *
   * @custom:emits SCRUnlocked
   */
  function unlockScr(uint256 policyId, uint256 scrAmount, uint256 policyInterestRate, int256 adjustment) external;

  /**
   * @notice Unlocks solvency capital previously locked with `lockScr`, doing a refund of the CoC previously received
   * @dev The capital no longer needed as solvency . It refunds part of the Coc received that wasn't accrued (or if
   * it was already accrued, it is adjusted). The refund doesn't affect the totalSupply. It just changes the reserves.
   *
   * @param policyId The id of the policy that locked the scr originally
   * @param scrAmount The amount to unlock
   * @param policyInterestRate The annualized interest rate that was paid for the `scrAmount`, must be the same that
   * was sent in `lockScr` call.
   * @param receiver The address of the receiver of the refund
   * @param refundAmount The amount to refund
   *
   * @custom:pre Must be called by a _borrower_ previously added with `addBorrower`.
   *
   * @custom:emits SCRUnlocked
   * @custom:emits CoCRefunded
   */
  function unlockScrWithRefund(
    uint256 policyId,
    uint256 scrAmount,
    uint256 policyInterestRate,
    int256 adjustment,
    address receiver,
    uint256 refundAmount
  ) external;

  /**
   * @notice Registers a deposit of liquidity in the pool.
   * @dev Called from the PolicyPool, assumes the amount has already been transferred. `amount` of eToken are minted
   * and given to the provider in exchange of the liquidity provided.
   *
   * @param amount The amount deposited.
   * @param caller The user that initiates the deposit
   * @param receiver The user that will receive the minted eTokens
   *
   * @custom:pre Must be called by `policyPool()`
   * @custom:pre The amount was transferred
   * @custom:pre `utilizationRate()` after the deposit is >= `minUtilizationRate()`
   * @custom:pre If there is a whitelist, caller must be authorized to deposit. If caller != receiver, then transfer from caller
   *             to received must be authorized
   *
   * @custom:emits Transfer with `from` = 0x0 and to = `provider` (mint)
   */
  function deposit(uint256 amount, address caller, address receiver) external;

  /**
   * @notice Withdraws an amount from an eToken.
   * @dev `withdrawn` eTokens are be burned and the user receives the same amount in `currency()`. 
   * If `amount == type(uint256).max`, it withdraws up to `maxWithdraw` (i.e., as much as possible).
   * Otherwise, it reverts if `amount > maxWithdraw`.
   *
   * @param amount The amount to withdraw. If `amount == type(uint256).max`, withdraws up to `maxWithdraw`.
   * @param caller The user that initiates the withdrawal
   * @param owner The owner of the eTokens (either caller==owner or caller has allowance)
   * @param receiver The address that will receive the resulting `currency()`
   *
   * @custom:pre Must be called by `policyPool()`
   *
   * @custom:emits Transfer with `from` = `provider` and to = `0x0` (burn)
   */
  function withdraw(
    uint256 amount,
    address caller,
    address owner,
    address receiver
  ) external returns (uint256 withdrawn);

  /**
   * @notice Returns the total amount that can be withdrawn
   */
  function totalWithdrawable() external view returns (uint256);

  /**
   * @notice Adds an authorized _borrower_ to the eToken. This _borrower_ will be allowed to lock/unlock funds and to take
   * loans.
   *
   * @dev Borrowers (typically PremiumsAccounts) can:
   * - lock/unlock SCR via {lockScr}/{unlockScr}/{unlockScrWithRefund}
   * - take internal loans via {internalLoan}
   *
   * @param borrower The address of the _borrower_, a PremiumsAccount that has this eToken as senior or junior eToken.
   *
   * @custom:pre Must be called by `policyPool()`
   * @custom:emits InternalBorrowerAdded
   */
  function addBorrower(address borrower) external;

  /**
   * @notice Removes an authorized _borrower_ to the eToken. The _borrower_ can't no longer lock funds or take loans.
   *
   * @param borrower The address of the _borrower_, a PremiumsAccount that has this eToken as senior or junior eToken.
   *
   * @custom:pre Must be called by `policyPool()`
   * @custom:emits InternalBorrowerRemoved with the defaulted debt
   */
  function removeBorrower(address borrower) external;

  /**
   * @notice Lends `amount` to the borrower (msg.sender), transferring the money to `receiver`.
   * @dev This reduces the `totalSupply()` of the eToken, and stores a debt that will be repaid (hopefully) with
   * `repayLoan`.
   *
   * @param amount The amount required
   * @param receiver The received of the funds lent. This is usually the policyholder if the loan is used for a payout.
   * @return Returns the amount that wasn't able to fulfil. `amount - lent`
   *
   * @custom:pre Must be called by a _borrower_ previously added with `addBorrower`.
   *
   * @custom:emits {InternalLoan}
   * @custom:emits {ERC20-Transfer} transferring `lent` to `receiver`
   */
  function internalLoan(uint256 amount, address receiver) external returns (uint256);

  /**
   * @notice Repays a loan taken with `internalLoan`.
   *
   * @param amount The amount to repaid, that will be transferred from `msg.sender` balance.
   * @param onBehalfOf The address of the borrower that took the loan. Usually `onBehalfOf == msg.sender` but we keep it
   * open because in some cases with might need someone else pays the debt.
   *
   * @custom:pre `msg.sender` approved the spending of `currency()` for at least `amount`
   *
   * @custom:emits {InternalLoanRepaid}
   * @custom:emits {ERC20-Transfer} transferring `amount` from `msg.sender` to `this`
   */
  function repayLoan(uint256 amount, address onBehalfOf) external;

  /**
   * @notice Returns the updated debt (principal + interest) of the `borrower`.
   */
  function getLoan(address borrower) external view returns (uint256);

  /**
   * @notice The annualized interest rate at which the `totalSupply()` grows
   */
  function tokenInterestRate() external view returns (uint256);

  /**
   * @notice The weighted average annualized interest rate paid by the currently locked `scr()`.
   */
  function scrInterestRate() external view returns (uint256);

  /**
   * @notice Returns the number that scales the shares to reflect the earnings or losses (rebasing token)
   *
   * @param updated When it's false, it returns the last scale stored. When it's true, it projects that scale applying
   *                the accrued returns of the scr
   */
  function getCurrentScale(bool updated) external view returns (uint256);

  /**
   * @notice Redistributes a given amount of eTokens of the caller between the remaining LPs
   *
   * @param amount The amount of eTokens to burn
   */
  function redistribute(uint256 amount) external;

  /**
   * @notice Returns the cooler contract plugged into the eToken
   */
  function cooler() external view returns (address);
}
