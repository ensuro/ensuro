// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SignedMath} from "@openzeppelin/contracts/utils/math/SignedMath.sol";
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
 * Collaborates with a junior {EToken} and a senior {EToken} that act as lenders when the premiums aren't enough to
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
  bytes32 public constant REPAY_LOANS_ROLE = keccak256("REPAY_LOANS_ROLE");
  uint256 internal constant FOUR_DECIMAL_TO_WAD = 1e14;
  uint16 internal constant HUNDRED_PERCENT = 1e4;

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

  /**
   * @dev This struct has the parameters that can be modified by governance
   * @member deficitRatio A value between [0, 1] that defines the percentage of active pure premiums that can be used
   *                      to cover losses.
   * @member assetManager This is the implementation contract that manages the PremiumsAccount's funds. See
   *                      {IAssetManager}
   * @member jrLoanLimit  This is the maximum amount that can be borrowed from the Junior eToken (without decimals)
   * @member srLoanLimit  This is the maximum amount that can be borrowed from the Senior eToken (without decimals)
   */
  struct PackedParams {
    uint16 deficitRatio;
    IAssetManager assetManager;
    uint32 jrLoanLimit;
    uint32 srLoanLimit;
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
   * @dev Modifier to make a function callable only by a certain global or component role.
   * In addition to checking the sender's role, `address(0)` 's role is also
   * considered. Granting a role to `address(0)` (at global or component level) is equivalent
   * to enabling this role for everyone.
   */
  modifier onlyGlobalOrComponentOrOpenRole(bytes32 role) {
    if (!_policyPool.access().hasComponentRole(address(this), role, address(0), true)) {
      _policyPool.access().checkComponentRole(address(this), role, _msgSender(), true);
    }
    _;
  }

  /**
   * @dev Constructor of the contract, sets the immutable fields.
   *
   * @param juniorEtk_ Address of the Junior EToken (first loss lender). `address(0)` if not present.
   * @param seniorEtk_ Address of the Senior EToken (2nd loss lender). `address(0)` if not present.
   */
  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor(IPolicyPool policyPool_, IEToken juniorEtk_, IEToken seniorEtk_) Reserve(policyPool_) {
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
    __Reserve_init();
    __PremiumsAccount_init_unchained();
  }

  // solhint-disable-next-line func-name-mixedcase
  function __PremiumsAccount_init_unchained() internal onlyInitializing {
    /*
    _activePurePremiums = 0;
    */
    _params = PackedParams({
      deficitRatio: HUNDRED_PERCENT,
      assetManager: IAssetManager(address(0)),
      jrLoanLimit: 0,
      srLoanLimit: 0
    });
    _validateParameters();
  }

  function _upgradeValidations(address newImpl) internal view virtual override {
    super._upgradeValidations(newImpl);
    IPremiumsAccount newPA = IPremiumsAccount(newImpl);
    require(
      newPA.juniorEtk() == _juniorEtk || address(_juniorEtk) == address(0),
      "Can't upgrade changing the Junior ETK unless to non-zero"
    );
    require(
      newPA.seniorEtk() == _seniorEtk || address(_seniorEtk) == address(0),
      "Can't upgrade changing the Senior ETK unless to non-zero"
    );
  }

  /**
   * @dev See {IERC165-supportsInterface}.
   */
  function supportsInterface(bytes4 interfaceId) public view virtual override returns (bool) {
    return super.supportsInterface(interfaceId) || interfaceId == type(IPremiumsAccount).interfaceId;
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
   * - If positive, repays the loans and accumulates the rest in the surplus.
   * - If negative (losses) substracts it from surplus. It never can exceed _maxDeficit and doesn't takes
   *   loans to cover asset losses.
   */
  function _assetEarnings(int256 earningsOrLosses) internal override {
    if (earningsOrLosses >= 0) {
      _storePurePremiumWon(uint256(earningsOrLosses));
    } else {
      require(_payFromPremiums(-earningsOrLosses) == 0, "Losses can't exceed maxDeficit");
    }
  }

  function _validateParameters() internal view override {
    require(
      _params.deficitRatio <= HUNDRED_PERCENT && _params.deficitRatio >= 0,
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

  /**
   * @dev Returns the amount of funds available to cover losses or repay eToken loans.
   */
  function fundsAvailable() public view returns (uint256) {
    // This is guaranteed to be positive because _maxDeficit is negative and always gte _surplus in absolute value
    return uint256(_surplus - _maxDeficit(deficitRatio()));
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

  function _toAmount(uint32 value) internal view returns (uint256) {
    // 0 decimals to amount decimals
    return uint256(value) * 10 ** currency().decimals();
  }

  function _toZeroDecimals(uint256 amount) internal view returns (uint32) {
    // Removes the decimals from the amount
    return (amount / 10 ** currency().decimals()).toUint32();
  }

  /**
   * @dev Returns the percentage of the active pure premiums that can be used to cover losses of finalized policies.
   */
  function deficitRatio() public view returns (uint256) {
    return uint256(_params.deficitRatio) * FOUR_DECIMAL_TO_WAD; // 4 -> 18 decimals
  }

  /**
   * @dev Returns the limit on the Junior eToken loans (infinite if _params.jrLoanLimit == 0)
   */
  function jrLoanLimit() public view returns (uint256) {
    return _params.jrLoanLimit == 0 ? type(uint256).max : _toAmount(_params.jrLoanLimit);
  }

  /**
   * @dev Returns the limit on the Senior eToken loans (infinite if _params.srLoanLimit == 0)
   */
  function srLoanLimit() public view returns (uint256) {
    return _params.srLoanLimit == 0 ? type(uint256).max : _toAmount(_params.srLoanLimit);
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
  function setDeficitRatio(uint256 newRatio, bool adjustment) external onlyGlobalOrComponentRole(LEVEL2_ROLE) {
    uint16 truncatedRatio = (newRatio / FOUR_DECIMAL_TO_WAD).toUint16();
    require(uint256(truncatedRatio) * FOUR_DECIMAL_TO_WAD == newRatio, "Validation: only up to 4 decimals allowed");

    int256 maxDeficit = _maxDeficit(newRatio);
    require(adjustment || _surplus >= maxDeficit, "Validation: surplus must be >= maxDeficit");
    _params.deficitRatio = truncatedRatio;
    _validateParameters();

    IAccessManager.GovernanceActions action = IAccessManager.GovernanceActions.setDeficitRatio;
    if (_surplus < maxDeficit) {
      // Do the adjustment
      uint256 borrow = uint256(-_surplus + maxDeficit);
      _surplus = maxDeficit;
      _borrowFromEtk(borrow, address(this), address(_juniorEtk) != address(0));
      action = IAccessManager.GovernanceActions.setDeficitRatioWithAdjustment;
    }
    _parameterChanged(action, newRatio);
  }

  /**
   * @dev Changes the `jrLoanLimit` or `srLoanLimit` parameter.
   *
   * Requirements:
   * - onlyGlobalOrComponentRole(LEVEL2_ROLE)
   *
   * Events:
   * - Emits GovernanceAction with action = setDeficitRatio or setDeficitRatioWithAdjustment if an adjustment was made.
   *
   * @param newLimitJr     The new limit to be set for the loans taken from the Junior eToken.
                           If newLimitJr == MAX_UINT, it's ignored. If == 0, means the loans are unbounded.
   * @param newLimitSr     The new limit to be set for the loans taken from the Senior eToken.
                           If newLimitSr == MAX_UINT, it's ignored. If == 0, means the loans are unbounded.
   */
  function setLoanLimits(uint256 newLimitJr, uint256 newLimitSr) external onlyGlobalOrComponentRole(LEVEL2_ROLE) {
    if (newLimitJr != type(uint256).max) {
      _params.jrLoanLimit = _toZeroDecimals(newLimitJr);
      require(_toAmount(_params.jrLoanLimit) == newLimitJr, "Validation: no decimals allowed");
      _parameterChanged(IAccessManager.GovernanceActions.setJrLoanLimit, newLimitJr);
    }
    if (newLimitSr != type(uint256).max) {
      _params.srLoanLimit = _toZeroDecimals(newLimitSr);
      require(_toAmount(_params.srLoanLimit) == newLimitSr, "Validation: no decimals allowed");
      _parameterChanged(IAccessManager.GovernanceActions.setSrLoanLimit, newLimitSr);
    }
  }

  /**
   * @dev Internal function called when money in the PremiumsAccount is not enough and we need to borrow from the
   * eTokens.
   *
   * @param borrow The amount to borrow.
   * @param receiver The address that will receive the money of the loan. Usually is the policy holder if this is called
   *                 in the context of a policy payout.
   * @param jrEtk If true it indicates that the loan is asked first from the junior eToken.
   */
  function _borrowFromEtk(uint256 borrow, address receiver, bool jrEtk) internal {
    uint256 left = borrow;
    if (jrEtk) {
      if (_juniorEtk.getLoan(address(this)) + borrow <= jrLoanLimit()) {
        left = _juniorEtk.internalLoan(borrow, receiver);
      } else if (_juniorEtk.getLoan(address(this)) < jrLoanLimit()) {
        // Partial loan
        uint256 loanExcess = _juniorEtk.getLoan(address(this)) + borrow - jrLoanLimit();
        left = loanExcess + _juniorEtk.internalLoan(borrow - loanExcess, receiver);
      }
    }
    if (left > NEGLIGIBLE_AMOUNT) {
      // Consume Senior Pool only up to SCR
      if (_seniorEtk.getLoan(address(this)) + left < srLoanLimit()) {
        left = _seniorEtk.internalLoan(left, receiver);
      } // in the senior eToken doesn't make sense to handle partial loan
      require(left <= NEGLIGIBLE_AMOUNT, "Don't know where to source the rest of the money");
    }
  }

  /**
   * @dev Updates the `_surplus` field with the payment made. Since the _surplus can never exceed `_maxDeficit()`,
   * returns the remaining amount in case something can't be paid from the PremiumsAccount.
   *
   * @param toPay The amount to pay.
   * @return The amount that couldn't be paid from the premiums account.
   */
  function _payFromPremiums(int256 toPay) internal returns (uint256) {
    int256 newSurplus = _surplus - toPay;
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
    currency().safeTransferFrom(_msgSender(), address(this), amount);
    emit WonPremiumsInOut(true, amount);
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
  function withdrawWonPremiums(
    uint256 amount,
    address destination
  ) external onlyGlobalOrComponentRole(WITHDRAW_WON_PREMIUMS_ROLE) returns (uint256) {
    require(destination != address(0), "PremiumsAccount: destination cannot be the zero address");
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

  function policyCreated(Policy.PolicyData memory policy) external override onlyPolicyPool whenNotPaused {
    _activePurePremiums += policy.purePremium;
    if (policy.jrScr > 0) _juniorEtk.lockScr(policy.jrScr, policy.jrInterestRate());
    if (policy.srScr > 0) _seniorEtk.lockScr(policy.srScr, policy.srInterestRate());
  }

  function policyReplaced(
    Policy.PolicyData memory oldPolicy,
    Policy.PolicyData memory newPolicy
  ) external override onlyPolicyPool whenNotPaused {
    if (oldPolicy.srScr > 0 && newPolicy.srScr > 0) {
      int256 diff = int256(oldPolicy.srInterestRate()) - int256(newPolicy.srInterestRate());
      require(SignedMath.abs(diff) < 1e14, "Interest rate can't change");
    }
    if (oldPolicy.jrScr > 0 && newPolicy.jrScr > 0) {
      int256 diff = int256(oldPolicy.jrInterestRate()) - int256(newPolicy.jrInterestRate());
      require(SignedMath.abs(diff) < 1e14, "Interest rate can't change");
    }
    /*
     * Supporting interest rate change is possible, but it would require complex computations.
     * If new IR > old IR, then we must adjust positivelly to accrue the interests not accrued
     * If new IR < old IR, then we must adjust negativelly to substract the interests accrued in excess
     */
    _activePurePremiums += newPolicy.purePremium - oldPolicy.purePremium;
    if (oldPolicy.jrScr > 0) _juniorEtk.unlockScr(oldPolicy.jrScr, oldPolicy.jrInterestRate(), 0);
    if (oldPolicy.srScr > 0) _seniorEtk.unlockScr(oldPolicy.srScr, oldPolicy.srInterestRate(), 0);
    if (newPolicy.jrScr > 0) _juniorEtk.lockScr(newPolicy.jrScr, newPolicy.jrInterestRate());
    if (newPolicy.srScr > 0) _seniorEtk.lockScr(newPolicy.srScr, newPolicy.srInterestRate());
  }

  function policyResolvedWithPayout(
    address policyHolder,
    Policy.PolicyData memory policy,
    uint256 payout
  ) external override onlyPolicyPool whenNotPaused {
    _activePurePremiums -= policy.purePremium;
    uint256 borrowFromScr = _payFromPremiums(int256(payout) - int256(policy.purePremium));
    if (borrowFromScr != 0) {
      _unlockScr(policy);
      _borrowFromEtk(borrowFromScr, policyHolder, policy.jrScr > 0);
    } else {
      _unlockScr(policy);
    }
    _transferTo(policyHolder, payout - borrowFromScr);
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
   * @dev Function that repays the loan(s) if fundsAvailable
   *
   * @return available The funds still available after repayment
   */
  function repayLoans()
    external
    onlyGlobalOrComponentOrOpenRole(REPAY_LOANS_ROLE)
    whenNotPaused
    returns (uint256 available)
  {
    available = fundsAvailable();
    if (available != 0 && address(_seniorEtk) != address(0)) available = _repayLoan(available, _seniorEtk);
    if (available != 0 && address(_juniorEtk) != address(0)) available = _repayLoan(available, _juniorEtk);
    return available;
  }

  /**
   * @dev Internal function that repays a loan taken (if any outstanding) from the an eToken
   *
   * @param fundsAvailable_ The amount of funds available for the repayment
   * @param etk The eToken with the potential debt
   * @return The excess amount of the purePremiumWon that wasn't used for the loan repayment.
   */
  function _repayLoan(uint256 fundsAvailable_, IEToken etk) internal returns (uint256) {
    uint256 borrowedFromEtk = etk.getLoan(address(this));
    if (borrowedFromEtk == 0) return fundsAvailable_;
    uint256 repayAmount = Math.min(fundsAvailable_, borrowedFromEtk);
    _surplus -= int256(repayAmount);

    // If not enough liquidity, it deinvests from the asset manager
    if (currency().balanceOf(address(this)) < repayAmount) {
      /**
       * I send `repayAmount` because the IAssetManager expects the full amount that's needed, not the missing one.
       * It uses the value of the full amount to optimize the deinvestment leaving more liquidity if possible to avoid
       * future deinvestment. It will only fail if it can't refill `repayAmount - currency().balanceOf(address(this))`
       */
      _refillWallet(repayAmount);
    }
    // Checks the allowance before repayment
    if (currency().allowance(address(this), address(etk)) < repayAmount) {
      // If I have to approve, I approve for all the pending debt (not just repayAmount), this way I avoid some
      // future approvals.
      currency().approve(address(etk), borrowedFromEtk);
    }
    etk.repayLoan(repayAmount, address(this));
    return fundsAvailable_ - repayAmount;
  }

  function policyExpired(Policy.PolicyData memory policy) external override onlyPolicyPool whenNotPaused {
    _activePurePremiums -= policy.purePremium;
    _storePurePremiumWon(policy.purePremium);
    _unlockScr(policy);
  }

  /**
   * @dev This empty reserved space is put in place to allow future versions to add new
   * variables without shifting down storage in the inheritance chain.
   * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
   */
  uint256[47] private __gap;
}
