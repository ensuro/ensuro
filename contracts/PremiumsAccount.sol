// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {WadRayMath} from "./WadRayMath.sol";
import {IPolicyPool} from "../interfaces/IPolicyPool.sol";
import {Reserve} from "./Reserve.sol";
import {IPremiumsAccount} from "../interfaces/IPremiumsAccount.sol";
import {Policy} from "./Policy.sol";
import {IEToken} from "../interfaces/IEToken.sol";
import {DataTypes} from "./DataTypes.sol";

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

  bytes32 public constant WITHDRAW_WON_PREMIUMS_ROLE = keccak256("WITHDRAW_WON_PREMIUMS_ROLE");

  uint256 internal _activePurePremiums; // sum of pure-premiums of active policies - In Wad
  uint256 internal _borrowedActivePP; // amount borrowed from active pure premiums to pay defaulted policies
  uint256 internal _wonPurePremiums; // amount of pure premiums won from non-defaulted policies

  /*
   * Premiums can come in (for free, without liability) with receiveGrant.
   * And can come out (withdrawed to treasury) with withdrawWonPremiums
   */
  event WonPremiumsInOut(bool moneyIn, uint256 value);

  /// @custom:oz-upgrades-unsafe-allow constructor
  // solhint-disable-next-line no-empty-blocks
  constructor(IPolicyPool policyPool_) Reserve(policyPool_) {}

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
    _borrowedActivePP = 0;
    _wonPurePremiums = 0;
    */
    _validateParameters();
  }

  // solhint-disable-next-line no-empty-blocks
  function _validateParameters() internal view override {}

  function purePremiums() public view returns (uint256) {
    return _activePurePremiums + _wonPurePremiums - _borrowedActivePP;
  }

  function activePurePremiums() external view returns (uint256) {
    return _activePurePremiums;
  }

  function wonPurePremiums() external view returns (uint256) {
    return _wonPurePremiums;
  }

  function borrowedActivePP() external view returns (uint256) {
    return _borrowedActivePP;
  }

  function _payFromPool(uint256 toPay) internal returns (uint256) {
    // 1. take from won_pure_premiums
    if (toPay <= _wonPurePremiums) {
      _wonPurePremiums -= toPay;
      return 0;
    }
    toPay -= _wonPurePremiums;
    _wonPurePremiums = 0;
    // 2. borrow from active pure premiums
    if (_activePurePremiums > _borrowedActivePP) {
      if (toPay <= (_activePurePremiums - _borrowedActivePP)) {
        _borrowedActivePP += toPay;
        return 0;
      } else {
        toPay -= _activePurePremiums - _borrowedActivePP;
        _borrowedActivePP = _activePurePremiums;
      }
    }
    return toPay;
  }

  function _storePurePremiumWon(uint256 purePremiumWon) internal {
    // TODO: merge _wonPurePremiums and _borrowedActivePP into single int256 variable
    // and this will be just `_wonPurePremiums += purePremiumWon;`
    if (purePremiumWon == 0) return;
    if (_borrowedActivePP >= purePremiumWon) {
      _borrowedActivePP -= purePremiumWon;
    } else {
      _wonPurePremiums += (purePremiumWon - _borrowedActivePP);
      _borrowedActivePP = 0;
    }
  }

  // TODO: restore repayETokenLoan?

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
   * - onlyPoolRole(WITHDRAW_WON_PREMIUMS_ROLE)
   * - _wonPurePremiums > 0
   */
  function withdrawWonPremiums(uint256 amount)
    external
    onlyPoolRole(WITHDRAW_WON_PREMIUMS_ROLE)
    returns (uint256)
  {
    if (amount > _wonPurePremiums) amount = _wonPurePremiums;
    require(amount > 0, "No premiums to withdraw");
    _wonPurePremiums -= amount;
    _transferTo(_policyPool.config().treasury(), amount); // TODO: discuss if destination shoud be msg.sender
    emit WonPremiumsInOut(false, amount);
    return amount;
  }

  function newPolicy(uint256 purePremium) external override onlyPolicyPool {
    _activePurePremiums += purePremium;
  }

  function policyResolvedWithPayout(
    address policyOwner,
    uint256 purePremium,
    uint256 payout,
    IEToken etk
  ) external override onlyPolicyPool {
    _activePurePremiums -= purePremium;
    if (purePremium >= payout) {
      _storePurePremiumWon(purePremium - payout);
      // TODO: repay debt?
      _transferTo(policyOwner, payout);
    } else {
      uint256 borrowFromScr = _payFromPool(payout - purePremium);
      if (borrowFromScr > 0) {
        uint256 left = etk.lendToPool(borrowFromScr, policyOwner, true);
        require(left <= NEGLIGIBLE_AMOUNT, "Don't know where to take the rest of the money");
      }
      _transferTo(policyOwner, payout - borrowFromScr);
    }
  }

  function policyExpired(uint256 purePremium, IEToken etk) external override onlyPolicyPool {
    uint256 aux;
    uint256 purePremiumWon = purePremium;
    _activePurePremiums -= purePremiumWon;

    // If negative _activePurePremiums, repay this first (shouldn't happen)
    if (_borrowedActivePP > _activePurePremiums) {
      aux = Math.min(_borrowedActivePP - _activePurePremiums, purePremiumWon);
      _borrowedActivePP -= aux;
      purePremiumWon -= aux;
    }

    // Then repay loan
    uint256 borrowedFromEtk = etk.getPoolLoan();
    if (borrowedFromEtk > 0) {
      uint256 etkRepayment = Math.min(purePremiumWon, borrowedFromEtk);
      _transferTo(address(etk), etkRepayment);
      etk.repayPoolLoan(etkRepayment);
      purePremiumWon -= etkRepayment;
    }
    // Finally store purePremiumWon
    _storePurePremiumWon(purePremiumWon);
  }
}