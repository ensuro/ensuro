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
 * @dev This contract holds the premiums of a set of risk modules
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
contract PremiumsAccount is IPremiumsAccount, Reserve {
  using Policy for Policy.PolicyData;
  using WadRayMath for uint256;
  using SafeERC20 for IERC20Metadata;
  using SafeCast for uint256;

  bytes32 public constant WITHDRAW_WON_PREMIUMS_ROLE = keccak256("WITHDRAW_WON_PREMIUMS_ROLE");

  /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
  IEToken internal immutable _juniorEtk;
  /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
  IEToken internal immutable _seniorEtk;

  uint256 internal _activePurePremiums; // sum of pure-premiums of active policies - In Wad
  int256 internal _surplus;

  struct PackedParams {
    uint16 deficitRatio;
    IAssetManager assetManager;
  }

  PackedParams internal _params;

  /*
   * Premiums can come in (for free, without liability) with receiveGrant.
   * And can come out (withdrawed to treasury) with withdrawWonPremiums
   */
  event WonPremiumsInOut(bool moneyIn, uint256 value);

  /// @custom:oz-upgrades-unsafe-allow constructor
  // solhint-disable-next-line no-empty-blocks
  constructor(
    IPolicyPool policyPool_,
    IEToken juniorEtk_,
    IEToken seniorEtk_
  ) Reserve(policyPool_) {
    _juniorEtk = juniorEtk_;
    _seniorEtk = seniorEtk_;
  }

  /**
   * @dev Public initialize Initializes the PremiumsAccount
   */
  function initialize() public initializer {
    __PremiumsAccount_init();
  }

  /**
   * @dev Initializes the PremiumsAccount
   */
  // solhint-disable-next-line func-name-mixedcase
  function __PremiumsAccount_init() internal initializer {
    __PolicyPoolComponent_init();
    __PremiumsAccount_init_unchained();
  }

  // solhint-disable-next-line func-name-mixedcase
  function __PremiumsAccount_init_unchained() internal initializer {
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

  function _assetEarnings(int256 earningsOrLosses) internal override {
    if (earningsOrLosses > 0) {
      uint256 earnings = uint256(earningsOrLosses);
      if (address(_seniorEtk) != address(0)) earnings = _repayLoan(earnings, _seniorEtk);
      if (address(_juniorEtk) != address(0)) earnings = _repayLoan(earnings, _juniorEtk);
      _storePurePremiumWon(earnings);
    } else {
      _payFromPremiums(uint256(-earningsOrLosses));
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

  function activePurePremiums() external view returns (uint256) {
    return _activePurePremiums;
  }

  function wonPurePremiums() external view returns (uint256) {
    return _surplus >= 0 ? uint256(_surplus) : 0;
  }

  function borrowedActivePP() external view returns (uint256) {
    return _surplus >= 0 ? 0 : uint256(-_surplus);
  }

  function surplus() external view returns (int256) {
    return _surplus;
  }

  function seniorEtk() external view override returns (IEToken) {
    return _seniorEtk;
  }

  function juniorEtk() external view override returns (IEToken) {
    return _juniorEtk;
  }

  function _maxDeficit(uint256 ratio) internal view returns (int256) {
    return -int256(_activePurePremiums.wadMul(ratio));
  }

  function deficitRatio() public view returns (uint256) {
    return uint256(_params.deficitRatio) * 1e14; // 4 -> 18 decimals
  }

  function setDeficitRatio(uint256 newRatio, bool adjustment)
    external
    onlyComponentRole(LEVEL2_ROLE)
  {
    require(newRatio <= 1e18 && newRatio >= 0, "Validation: deficitRatio must be <= 1");
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
    _params.deficitRatio = (newRatio / 1e14).toUint16();
    _parameterChanged(action, newRatio, false);
  }

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
   */
  function receiveGrant(uint256 amount) external {
    currency().safeTransferFrom(msg.sender, address(this), amount);
    _storePurePremiumWon(amount);
    emit WonPremiumsInOut(true, amount);
  }

  /**
   *
   * Withdraws excess premiums to PolicyPool's treasury.
   * This might be needed in some cases for example if we are deprecating the protocol or the excess premiums
   * are needed to compensate something. Shouldn't be used. Can be disabled revoking role WITHDRAW_WON_PREMIUMS_ROLE
   *
   * returns The amount withdrawed
   *
   * Requirements:
   *
   * - onlyGlobalOrComponentRole(WITHDRAW_WON_PREMIUMS_ROLE)
   * - _wonPurePremiums > 0
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

  function _repayLoan(uint256 purePremiumWon, IEToken etk) internal returns (uint256) {
    if (purePremiumWon < NEGLIGIBLE_AMOUNT) return purePremiumWon;
    uint256 borrowedFromEtk = etk.getLoan(address(this));
    if (borrowedFromEtk == 0) return purePremiumWon;
    uint256 repayAmount = borrowedFromEtk > purePremiumWon ? purePremiumWon : borrowedFromEtk;
    // TODO: make sure the balance is available or deinvest
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
