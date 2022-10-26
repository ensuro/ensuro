// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {WadRayMath} from "./dependencies/WadRayMath.sol";
import {IPolicyPool} from "./interfaces/IPolicyPool.sol";
import {IEToken} from "./interfaces/IEToken.sol";
import {Reserve} from "./Reserve.sol";
import {IAccessManager} from "./interfaces/IAccessManager.sol";
import {IPremiumsAccount} from "./interfaces/IPremiumsAccount.sol";
import {Policy} from "./Policy.sol";
import {IEToken} from "./interfaces/IEToken.sol";
import {IAssetManager} from "./interfaces/IAssetManager.sol";

/**
 * @title Ensuro Premiums Account
 * @dev This contract holds the pure premiums of a set of risk modules. The pure premiums is the part of the premium
 * that is expected to cover the losses. The contract keeps track of the pure premiums of the active policies
 * (_activePurePremiums) and the surplus or deficit generated by the finalized policies (pure premiums collected -
 * losses).
 *
 * Collaborates with a junior {EToken} and a senior {EToken} that act as lenders when the premiums aren't enought to
 * cover the losses.
 *
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
contract PremiumsAccount is IPremiumsAccount, Reserve {
  using Policy for Policy.PolicyData;
  using WadRayMath for uint256;
  using SafeERC20 for IERC20Metadata;
  using SafeCast for uint256;

  bytes32 public constant WITHDRAW_WON_PREMIUMS_ROLE = keccak256("WITHDRAW_WON_PREMIUMS_ROLE");

  /**
   * @dev The Junior eToken is the first {EToken} to which the PremiumsAccount will go for credit when it runs out of
   * money. Optional (address(0)).
   */
  /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
  IEToken internal immutable _juniorEtk;

  /**
   * @dev The Senior eToken is the second {EToken} to which the PremiumsAccount will go for credit, after trying before
   * with the junior eToken, when it runs out of money. Optional (address(0)).
   */
  /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
  IEToken internal immutable _seniorEtk;

  /**
   * @dev The active pure premiums field keeps track of the pure premiums collected by the active policies of risk
   * modules linked with this PremiumsAccount.
   */
  uint256 internal _activePurePremiums; // sum of pure-premiums of active policies - In Wad

  /**
   * @dev The surplus field keeps track of the surplus or deficit (when negative) of the actual payouts made by the
   * PremiumsAccount versus the collected pure premiums. On the negative side, it has a limit defined by `_maxDeficit()`,
   * after that limit, internal loans are taken from the eTokens.
   */
  int256 internal _surplus;

  struct PackedParams {
    uint16 deficitRatio;
    IAssetManager assetManager;
  }

  PackedParams internal _params;

  /**
   * Premiums can come in (for "free", without liability) with receiveGrant.
   * And can come out (withdrawed to treasury) with withdrawWonPremiums
   *
   * @param moneyIn Indicates if money came in or out (false).
   * @param value The amount of money received or given
   */
  event WonPremiumsInOut(bool moneyIn, uint256 value);

  /**
   * @dev Constructor of the contract, sets the immutable fields.
   *
   * @param juniorEtk_ Address of the Junior EToken (first loss lender). `address(0)` if not present.
   * @param seniorEtk_ Address of the Senior EToken (2nd loss lender). `address(0)` if not present.
   */
  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor(
    IPolicyPool policyPool_,
    IEToken juniorEtk_,
    IEToken seniorEtk_
  ) Reserve(policyPool_) {
    _juniorEtk = juniorEtk_;
    _seniorEtk = seniorEtk_;
  }

  /**
   * @dev Initializes the PremiumsAccount
   */
  function initialize() public initializer {
    __PremiumsAccount_init();
  }

  /**
   * @dev Initializes the PremiumsAccount (to be called by subclasses)
   */
  // solhint-disable-next-line func-name-mixedcase
  function __PremiumsAccount_init() internal onlyInitializing {
    __PolicyPoolComponent_init();
    __PremiumsAccount_init_unchained();
  }

  /**
   * @dev In the initialization, besides settings the parameters, we approve the spending of funds by the eTokens
   * so we don't need to do it on every repayment operation
   */
  // solhint-disable-next-line func-name-mixedcase
  function __PremiumsAccount_init_unchained() internal onlyInitializing {
    /*
    _activePurePremiums = 0;
    */
    if (address(_juniorEtk) != address(0))
      currency().approve(address(_juniorEtk), type(uint256).max);
    if (address(_seniorEtk) != address(0))
      currency().approve(address(_seniorEtk), type(uint256).max);

    _params = PackedParams({deficitRatio: 1e4, assetManager: IAssetManager(address(0))});
    _validateParameters();
  }

  function assetManager() public view override returns (IAssetManager) {
    return _params.assetManager;
  }

  function _setAssetManager(IAssetManager newAM) internal override {
    _params.assetManager = newAM;
  }

  /**
   * @dev This is called by the {Reserve} base class to record the earnings generated by the asset management.
   *
   * @param earningsOrLosses Indicates the amount earned since last time earnings where recorded.
   * - If positive, repays the lons and accumulates the rest in the surplus.
   * - If negative (losses) substracts it from surplus. It never can exceed _maxDeficit and doesn't takes
   *   loans to cover asset losses.
   */
  function _assetEarnings(int256 earningsOrLosses) internal override {
    if (earningsOrLosses > 0) {
      uint256 earnings = uint256(earningsOrLosses);
      if (address(_seniorEtk) != address(0)) earnings = _repayLoan(earnings, _seniorEtk);
      if (address(_juniorEtk) != address(0)) earnings = _repayLoan(earnings, _juniorEtk);
      _storePurePremiumWon(earnings);
    } else {
      require(_payFromPremiums(uint256(-earningsOrLosses)) == 0, "Losses can't exceed maxDeficit");
    }
  }

  function _validateParameters() internal view override {
    require(
      _params.deficitRatio <= 1e4 && _params.deficitRatio >= 0,
      "Validation: deficitRatio must be <= 1"
    );
  }

  function purePremiums() external view override returns (uint256) {
    return uint256(int256(_activePurePremiums) + _surplus);
  }

  /**
   * @dev Returns the total amount of pure premiums that were collected by the active policies of the risk modules
   * linked to this PremiumsAccount.
   */
  function activePurePremiums() external view returns (uint256) {
    return _activePurePremiums;
  }

  /**
   * @dev Returns the surplus between pure premiums collected and payouts of finalized policies. Returns 0 if no surplus
   * or deficit.
   */
  function wonPurePremiums() external view returns (uint256) {
    return _surplus >= 0 ? uint256(_surplus) : 0;
  }

  /**
   * @dev Returns the amount of active pure premiums that was used to cover payouts of finalized policies (in excess of
   * collected pure premiums). This is limited by `_maxDeficit()`
   */
  function borrowedActivePP() external view returns (uint256) {
    return _surplus >= 0 ? 0 : uint256(-_surplus);
  }

  /**
   * @dev Returns the surplus between pure premiums collected and payouts of finalized policies. Losses where more than
   * premiums collected, returns a negative number that indicates the amount of the active pure premiums that was used
   * to cover finalized premiums.
   */
  function surplus() external view returns (int256) {
    return _surplus;
  }

  function seniorEtk() external view override returns (IEToken) {
    return _seniorEtk;
  }

  function juniorEtk() external view override returns (IEToken) {
    return _juniorEtk;
  }

  /**
   * @dev Returns the maximum deficit that's supported by the PremiumsAccount. If more money is needed, it must take
   * loans from the eTokens. The value is calculated as a fraction of the active pure premiums. The fraction is
   * regulated by the `deficitRatio` parameter that indicates the percentage of the active pure premiums that can be
   * used to cover payouts of finalized policies. In many cases is fine to use the active pure premiums to cover the
   * losses because in most cases the policies with payout are triggered long time before the policies without payout.
   * But this also can be dangerous because it can be postponing the losses that should impact on liquidity providers.
   *
   * @param ratio The ratio used in the calculation of the deficit. It's the deficitRatio parameter (whether the current
   * one or the new one when it's being modified).
   */
  function _maxDeficit(uint256 ratio) internal view returns (int256) {
    return -int256(_activePurePremiums.wadMul(ratio));
  }

  /**
   * @dev Returns the percentage of the active pure premiums that can be used to cover losses of finalized policies.
   */
  function deficitRatio() public view returns (uint256) {
    return uint256(_params.deficitRatio) * 1e14; // 4 -> 18 decimals
  }

  /**
   * @dev Changes the `deficitRatio` parameter.
   *
   * Requirements:
   * - onlyGlobalOrComponentRole(LEVEL2_ROLE)
   *
   * Events:
   * - Emits GovernanceAction with action = setDeficitRatio or setDeficitRatioWithAdjustment if an adjustment was made.
   *
   * @param adjustment If true and the new ratio leaves `_surplus < -_maxDeficit()`, it adjusts the _surplus to the new
   *                   `_maxDeficit()` and borrows the difference from the eTokens.
   *                   If false and the new ratio leaves `_surplus < -_maxDeficit()`, the operation is reverted.
   */
  function setDeficitRatio(uint256 newRatio, bool adjustment)
    external
    onlyComponentRole(LEVEL2_ROLE)
  {
    require(newRatio <= 1e18, "Validation: deficitRatio must be <= 1");

    uint16 truncatedRatio = (newRatio / 1e14).toUint16();
    require(
      uint256(truncatedRatio) * 1e14 == newRatio,
      "Validation: only up to 4 decimals allowed"
    );

    int256 maxDeficit = _maxDeficit(newRatio);
    require(adjustment || _surplus >= maxDeficit, "Validation: surplus must be >= maxDeficit");

    IAccessManager.GovernanceActions action = IAccessManager.GovernanceActions.setDeficitRatio;
    if (_surplus < maxDeficit) {
      // Do the adjustment
      uint256 borrow = uint256(-_surplus + maxDeficit);
      _surplus = maxDeficit;
      _borrowFromEtk(borrow, address(this), address(_juniorEtk) != address(0));
      action = IAccessManager.GovernanceActions.setDeficitRatioWithAdjustment;
    }
    _params.deficitRatio = truncatedRatio;
    _parameterChanged(action, newRatio, false);
  }

  /**
   * @dev Internal function called when money in the PremiumsAccount is not enought and we need to borrow from the
   * eTokens.
   *
   * @param borrow The amount to borrow.
   * @param receiver The address that will receive the money of the loan. Usually is the policy holder if this is called
   *                 in the context of a policy payout.
   * @param jrEtk If true it indicates that the loan is asked first from the junior eToken.
   */
  function _borrowFromEtk(
    uint256 borrow,
    address receiver,
    bool jrEtk
  ) internal {
    uint256 left;
    if (jrEtk) {
      // Consume Junior Pool until exhausted
      left = _juniorEtk.internalLoan(borrow, receiver, false);
    } else {
      left = borrow;
    }
    if (left > NEGLIGIBLE_AMOUNT) {
      // Consume Senior Pool only up to SCR
      left = _seniorEtk.internalLoan(left, receiver, true);
      require(left <= NEGLIGIBLE_AMOUNT, "Don't know where to take the rest of the money");
    }
  }

  /**
   * @dev Updates the `_surplus` field with the payment made. Since the _surplus can never exceed `_maxDeficit()`,
   * returns the remaining amount in case something can't be paid from the PremiumsAccount.
   *
   * @param toPay The amount to pay.
   * @return The amount that couldn't be paid from the premiums account.
   */
  function _payFromPremiums(uint256 toPay) internal returns (uint256) {
    int256 newSurplus = _surplus - int256(toPay);
    int256 maxDeficit = _maxDeficit(deficitRatio());
    if (newSurplus >= maxDeficit) {
      _surplus = newSurplus;
      return 0;
    }
    _surplus = maxDeficit;
    return uint256(-newSurplus + maxDeficit);
  }

  /**
   * @dev Stores an earned pure premium. Adds to the surplus, increasing the surplus if it was positive or reducing the
   * deficit if it was negative.
   *
   * @param purePremiumWon The amount earned
   */
  function _storePurePremiumWon(uint256 purePremiumWon) internal {
    if (purePremiumWon == 0) return;
    _surplus += int256(purePremiumWon);
  }

  /**
   *
   * Endpoint to receive "free money" and inject that money into the premium pool.
   *
   * Can be used for example if the PolicyPool subscribes an excess loss policy with other company.
   *
   * Requirements:
   * - The sender needs to approve the spending of `currency()` by this contract.
   *
   * Events:
   * - Emits {WonPremiumsInOut} with moneyIn = true
   *
   * @param amount The amount to be transferred.
   */
  function receiveGrant(uint256 amount) external {
    _storePurePremiumWon(amount);
    emit WonPremiumsInOut(true, amount);
    currency().safeTransferFrom(_msgSender(), address(this), amount);
  }

  /**
   *
   * Withdraws excess premiums (surplus) to the destination.
   *
   * This might be needed in some cases for example if we are deprecating the protocol or the excess premiums
   * are needed to compensate something. Shouldn't be used. Can be disabled revoking role WITHDRAW_WON_PREMIUMS_ROLE
   *
   * Requirements:
   * - onlyGlobalOrComponentRole(WITHDRAW_WON_PREMIUMS_ROLE)
   * - _surplus > 0
   *
   * Events:
   * - Emits {WonPremiumsInOut} with moneyIn = false
   *
   * @param amount The amount to withdraw
   * @param destination The address that will receive the transferred funds.
   * @return Returns the actual amount withdrawn.
   */
  function withdrawWonPremiums(uint256 amount, address destination)
    external
    onlyGlobalOrComponentRole(WITHDRAW_WON_PREMIUMS_ROLE)
    returns (uint256)
  {
    if (_surplus <= 0) {
      amount = 0;
    } else {
      amount = Math.min(amount, uint256(_surplus));
    }
    require(amount > 0, "No premiums to withdraw");
    _surplus -= int256(amount);
    _transferTo(destination, amount);
    emit WonPremiumsInOut(false, amount);
    return amount;
  }

  function policyCreated(Policy.PolicyData memory policy)
    external
    override
    onlyPolicyPool
    whenNotPaused
  {
    _activePurePremiums += policy.purePremium;
    if (policy.jrScr > 0) _juniorEtk.lockScr(policy.jrScr, policy.jrInterestRate());
    if (policy.srScr > 0) _seniorEtk.lockScr(policy.srScr, policy.srInterestRate());
  }

  function policyResolvedWithPayout(
    address policyHolder,
    Policy.PolicyData memory policy,
    uint256 payout
  ) external override onlyPolicyPool whenNotPaused {
    _activePurePremiums -= policy.purePremium;
    if (policy.purePremium >= payout) {
      uint256 purePremiumWon = policy.purePremium - payout;
      if (address(_seniorEtk) != address(0))
        purePremiumWon = _repayLoan(purePremiumWon, _seniorEtk);
      if (address(_juniorEtk) != address(0))
        purePremiumWon = _repayLoan(purePremiumWon, _juniorEtk);
      _storePurePremiumWon(purePremiumWon);
      _unlockScr(policy);
      _transferTo(policyHolder, payout);
    } else {
      uint256 borrowFromScr = _payFromPremiums(payout - policy.purePremium);
      _unlockScr(policy);
      if (borrowFromScr > 0) {
        _borrowFromEtk(borrowFromScr, policyHolder, policy.jrScr > 0);
      }
      _transferTo(policyHolder, payout - borrowFromScr);
    }
  }

  /**
   * @dev Internal function that calls the eTokens to lock the solvency capital when the policy is created.
   *
   * @param policy The policy created
   */
  function _unlockScr(Policy.PolicyData memory policy) internal {
    if (policy.jrScr > 0) {
      _juniorEtk.unlockScr(
        policy.jrScr,
        policy.jrInterestRate(),
        int256(policy.jrCoc) - int256(policy.jrAccruedInterest())
      );
    }
    if (policy.srScr > 0) {
      _seniorEtk.unlockScr(
        policy.srScr,
        policy.srInterestRate(),
        int256(policy.srCoc) - int256(policy.srAccruedInterest())
      );
    }
  }

  /**
   * @dev Internal function that repays a loan taken (if any outstanding) from the an eToken
   *
   * @param purePremiumWon The amount earned and available for loan repayment.
   * @param etk The eToken with the potential debt
   * @return The excess amount of the purePremiumWon that wasn't used for the loan repayment.
   */
  function _repayLoan(uint256 purePremiumWon, IEToken etk) internal returns (uint256) {
    if (purePremiumWon < NEGLIGIBLE_AMOUNT) return purePremiumWon;
    uint256 borrowedFromEtk = etk.getLoan(address(this));
    if (borrowedFromEtk == 0) return purePremiumWon;
    uint256 repayAmount = Math.min(purePremiumWon, borrowedFromEtk);

    // If not enought liquidity, it deinvests from the asset manager
    if (currency().balanceOf(address(this)) < repayAmount) {
      _refillWallet(repayAmount);
    }
    etk.repayLoan(repayAmount, address(this));
    return purePremiumWon - repayAmount;
  }

  function policyExpired(Policy.PolicyData memory policy)
    external
    override
    onlyPolicyPool
    whenNotPaused
  {
    uint256 purePremiumWon = policy.purePremium;
    _activePurePremiums -= purePremiumWon;

    // If negative _activePurePremiums, repay this first (shouldn't happen)
    int256 maxDeficit = _maxDeficit(deficitRatio());
    if (_surplus < maxDeficit) {
      // Covers the excess of deficit first
      purePremiumWon -= uint256(-_surplus + maxDeficit);
      _surplus = maxDeficit;
    }

    if (address(_seniorEtk) != address(0)) purePremiumWon = _repayLoan(purePremiumWon, _seniorEtk);
    if (address(_juniorEtk) != address(0)) purePremiumWon = _repayLoan(purePremiumWon, _juniorEtk);

    // Finally store purePremiumWon
    _storePurePremiumWon(purePremiumWon);
    _unlockScr(policy);
  }
}
