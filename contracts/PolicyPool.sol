// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPolicyPoolConfig} from "../interfaces/IPolicyPoolConfig.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {IPolicyPool} from "../interfaces/IPolicyPool.sol";
import {IRiskModule} from "../interfaces/IRiskModule.sol";
import {IInsolvencyHook} from "../interfaces/IInsolvencyHook.sol";
import {IPolicyPoolComponent} from "../interfaces/IPolicyPoolComponent.sol";
import {IEToken} from "../interfaces/IEToken.sol";
import {IPolicyNFT} from "../interfaces/IPolicyNFT.sol";
import {IAssetManager} from "../interfaces/IAssetManager.sol";
import {Policy} from "./Policy.sol";
import {WadRayMath} from "./WadRayMath.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {DataTypes} from "./DataTypes.sol";

// #invariant_disabled {:msg "Borrow up to activePurePremiums"} _borrowedActivePP <= _activePurePremiums;
// #invariant_disabled {:msg "Can't borrow if not exhausted before won"} (_borrowedActivePP > 0) ==> _wonPurePremiums == 0;
contract PolicyPool is IPolicyPool, PausableUpgradeable, UUPSUpgradeable {
  using EnumerableSet for EnumerableSet.AddressSet;
  using WadRayMath for uint256;
  using Policy for Policy.PolicyData;
  using DataTypes for DataTypes.ETokenToWadMap;
  using DataTypes for DataTypes.ETokenStatusMap;
  using SafeERC20 for IERC20Metadata;

  uint256 public constant NEGLIGIBLE_AMOUNT = 1e14; // "0.0001" in Wad

  bytes32 public constant REBALANCE_ROLE = keccak256("REBALANCE_ROLE");
  bytes32 public constant WITHDRAW_WON_PREMIUMS_ROLE = keccak256("WITHDRAW_WON_PREMIUMS_ROLE");

  bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
  bytes32 public constant LEVEL1_ROLE = keccak256("LEVEL1_ROLE");
  bytes32 public constant LEVEL2_ROLE = keccak256("LEVEL2_ROLE");
  bytes32 public constant LEVEL3_ROLE = keccak256("LEVEL3_ROLE");

  uint256 public constant MAX_ETOKENS = 10;

  /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
  IPolicyPoolConfig internal immutable _config;
  /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
  IERC20Metadata internal immutable _currency;
  /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
  IPolicyNFT internal immutable _policyNFT;

  DataTypes.ETokenStatusMap internal _eTokens;

  mapping(uint256 => Policy.PolicyData) internal _policies;
  mapping(uint256 => DataTypes.ETokenToWadMap) internal _policiesFunds;

  uint256 internal _activePremiums; // sum of premiums of active policies - In Wad
  uint256 internal _activePurePremiums; // sum of pure-premiums of active policies - In Wad
  uint256 internal _borrowedActivePP; // amount borrowed from active pure premiums to pay defaulted policies
  uint256 internal _wonPurePremiums; // amount of pure premiums won from non-defaulted policies

  event NewPolicy(IRiskModule indexed riskModule, uint256 policyId);
  event PolicyRebalanced(IRiskModule indexed riskModule, uint256 indexed policyId);
  event PolicyResolved(IRiskModule indexed riskModule, uint256 indexed policyId, uint256 payout);

  event ETokenStatusChanged(IEToken indexed eToken, DataTypes.ETokenStatus newStatus);

  /*
   * Premiums can come in (for free, without liability) with receiveGrant.
   * And can come out (withdrawed to treasury) with withdrawWonPremiums
   */
  event WonPremiumsInOut(bool moneyIn, uint256 value);

  modifier onlyAssetManager() {
    require(
      msg.sender == address(_config.assetManager()),
      "Only assetManager can call this function"
    );
    _;
  }

  modifier onlyRole(bytes32 role) {
    _config.checkRole(role, msg.sender);
    _;
  }

  modifier onlyRole2(bytes32 role1, bytes32 role2) {
    _config.checkRole2(role1, role2, msg.sender);
    _;
  }

  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor(
    IPolicyPoolConfig config_,
    IPolicyNFT policyNFT_,
    IERC20Metadata currency_
  ) {
    _config = config_;
    _policyNFT = policyNFT_;
    _currency = currency_;
  }

  function initialize() public initializer {
    __UUPSUpgradeable_init();
    __Pausable_init();
    __PolicyPool_init_unchained();
  }

  // solhint-disable-next-line func-name-mixedcase
  function __PolicyPool_init_unchained() internal initializer {
    _config.connect();
    require(
      _config.assetManager() == IAssetManager(address(0)),
      "AssetManager can't be set before PolicyPool initialization"
    );
    _policyNFT.connect();
    /*
    _activePurePremiums = 0;
    _activePremiums = 0;
    _borrowedActivePP = 0;
    _wonPurePremiums = 0;
    */
  }

  // solhint-disable-next-line no-empty-blocks
  function _authorizeUpgrade(address) internal override onlyRole2(GUARDIAN_ROLE, LEVEL1_ROLE) {}

  function pause() public onlyRole(GUARDIAN_ROLE) {
    _pause();
  }

  function unpause() public onlyRole2(GUARDIAN_ROLE, LEVEL1_ROLE) {
    _unpause();
  }

  function config() external view virtual override returns (IPolicyPoolConfig) {
    return _config;
  }

  function currency() external view virtual override returns (IERC20Metadata) {
    return _currency;
  }

  function policyNFT() external view virtual override returns (address) {
    return address(_policyNFT);
  }

  function purePremiums() external view returns (uint256) {
    return _activePurePremiums + _wonPurePremiums - _borrowedActivePP;
  }

  function activePremiums() external view returns (uint256) {
    return _activePremiums;
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

  // #if_succeeds_disabled {:msg "eToken added as active"} _eTokens.get(eToken) == DataTypes.ETokenStatus.active;
  function addEToken(IEToken eToken) external onlyRole(LEVEL1_ROLE) {
    require(_eTokens.length() < MAX_ETOKENS, "Maximum number of ETokens reached");
    require(!_eTokens.contains(eToken), "eToken already in the pool");
    require(address(eToken) != address(0), "eToken can't be zero");
    require(
      IPolicyPoolComponent(address(eToken)).policyPool() == this,
      "EToken not linked to this pool"
    );

    _eTokens.set(eToken, DataTypes.ETokenStatus.active);
    emit ETokenStatusChanged(eToken, DataTypes.ETokenStatus.active);
  }

  function removeEToken(IEToken eToken) external onlyRole(LEVEL3_ROLE) {
    require(_eTokens.get(eToken) == DataTypes.ETokenStatus.deprecated, "EToken not deprecated");
    require(eToken.totalSupply() == 0, "EToken has liquidity, can't be removed");
    emit ETokenStatusChanged(eToken, DataTypes.ETokenStatus.inactive);
  }

  function changeETokenStatus(IEToken eToken, DataTypes.ETokenStatus newStatus)
    external
    onlyRole2(GUARDIAN_ROLE, LEVEL1_ROLE)
  {
    require(_eTokens.contains(eToken), "Risk Module not found");
    require(
      newStatus != DataTypes.ETokenStatus.suspended || _config.hasRole(GUARDIAN_ROLE, msg.sender),
      "Only GUARDIAN can suspend eTokens"
    );
    _eTokens.set(eToken, newStatus);
    emit ETokenStatusChanged(eToken, newStatus);
  }

  function getETokenStatus(IEToken eToken) external view returns (DataTypes.ETokenStatus) {
    return _eTokens.get(eToken);
  }

  function setAssetManager(IAssetManager newAssetManager) external override {
    require(msg.sender == address(_config), "Only the PolicyPoolConfig can change assetManager");
    if (address(_config.assetManager()) != address(0)) {
      _config.assetManager().deinvestAll(); // deInvest all assets
      _currency.approve(address(_config.assetManager()), 0); // revoke currency management approval
    }
    if (address(newAssetManager) != address(0)) {
      _currency.approve(address(newAssetManager), type(uint256).max);
    }
  }

  /// #if_succeeds
  ///    {:msg "must take balance from sender"}
  ///    _currency.balanceOf(msg.sender) == old(_currency.balanceOf(msg.sender) - amount);
  function deposit(IEToken eToken, uint256 amount) external override whenNotPaused {
    (bool found, DataTypes.ETokenStatus etkStatus) = _eTokens.tryGet(eToken);
    require(found && etkStatus == DataTypes.ETokenStatus.active, "eToken is not active");
    _currency.safeTransferFrom(msg.sender, address(this), amount);
    eToken.deposit(msg.sender, amount);
  }

  function withdraw(IEToken eToken, uint256 amount)
    external
    override
    whenNotPaused
    returns (uint256)
  {
    (bool found, DataTypes.ETokenStatus etkStatus) = _eTokens.tryGet(eToken);
    require(
      found &&
        (
          (etkStatus == DataTypes.ETokenStatus.active ||
            etkStatus == DataTypes.ETokenStatus.deprecated)
        ),
      "eToken not found or withdraws not allowed"
    );
    address provider = msg.sender;
    uint256 withdrawed = eToken.withdraw(provider, amount);
    if (withdrawed > 0) _transferTo(provider, withdrawed);
    return withdrawed;
  }

  function newPolicy(Policy.PolicyData memory policy_, address customer)
    external
    override
    whenNotPaused
    returns (uint256)
  {
    IRiskModule rm = policy_.riskModule;
    require(address(rm) == msg.sender, "Only the RM can create new policies");
    _config.checkAcceptsNewPolicy(rm);
    _currency.safeTransferFrom(customer, address(this), policy_.premium);
    uint256 policyId = _policyNFT.safeMint(customer);
    Policy.PolicyData storage policy = _policies[policyId] = policy_;
    policy.id = policyId;
    if (policy.rmScr() > 0) _currency.safeTransferFrom(rm.wallet(), address(this), policy.rmScr());
    _activePurePremiums += policy.purePremium;
    _activePremiums += policy.premium;
    _lockScr(policy);
    emit NewPolicy(rm, policy.id);
    return policy.id;
  }

  function _lockScr(Policy.PolicyData storage policy) internal {
    uint256 ocean = 0;
    DataTypes.ETokenToWadMap storage policyFunds = _policiesFunds[policy.id];

    // Initially I iterate over all eTokens and accumulate ocean of eligible ones
    // saves the ocean in policyFunds, later will _distributeScr
    for (uint256 i = 0; i < _eTokens.length(); i++) {
      (IEToken etk, DataTypes.ETokenStatus etkStatus) = _eTokens.at(i);
      if (etkStatus != DataTypes.ETokenStatus.active) continue;
      if (!etk.accepts(address(policy.riskModule), policy.expiration)) continue;
      uint256 etkOcean = etk.oceanForNewScr();
      if (etkOcean == 0) continue;
      ocean += etkOcean;
      policyFunds.set(etk, etkOcean);
    }
    _distributeScr(policy.scr, policy.interestRate(), ocean, policyFunds);
  }

  /**
   * @dev Distributes SCR amount in policyFunds according to ocean per token
   * @param scr  SCR to distribute
   * @param ocean  Total ocean available in the ETokens for this SCR
   * @param policyFunds  Input: loaded with ocean available for this SCR (sum=ocean)
                         Ouput: loaded with locked SRC (sum=scr)
   */
  function _distributeScr(
    uint256 scr,
    uint256 interestRate,
    uint256 ocean,
    DataTypes.ETokenToWadMap storage policyFunds
  ) internal {
    require(ocean >= scr, "Not enought ocean to cover the policy");
    uint256 scrNotLocked = scr;

    for (uint256 i = 0; i < policyFunds.length(); i++) {
      uint256 etkScr;
      (IEToken etk, uint256 etkOcean) = policyFunds.at(i);
      if (i < policyFunds.length() - 1) etkScr = scr.wadMul(etkOcean).wadDiv(ocean);
      else etkScr = scrNotLocked;
      etk.lockScr(interestRate, etkScr);
      policyFunds.set(etk, etkScr);
      scrNotLocked -= etkScr;
    }
  }

  function _balance() internal view returns (uint256) {
    return _currency.balanceOf(address(this));
  }

  function _transferTo(address destination, uint256 amount) internal {
    if (amount == 0) return;
    if (_config.assetManager() != IAssetManager(address(0)) && _balance() < amount) {
      _config.assetManager().refillWallet(amount);
    }
    // Calculate again the balance and check if enought, if not call unsolvency_hook
    if (_config.insolvencyHook() != IInsolvencyHook(address(0)) && _balance() < amount) {
      _config.insolvencyHook().outOfCash(amount - _balance());
    }
    _currency.safeTransfer(destination, amount);
  }

  function _payFromPool(uint256 toPay) internal returns (uint256) {
    // 1. take from won_pure_premiums
    if (toPay <= _wonPurePremiums) {
      _wonPurePremiums -= toPay;
      return 0;
    }
    if (_wonPurePremiums > 0) {
      toPay -= _wonPurePremiums;
      _wonPurePremiums = 0;
    }
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
    if (purePremiumWon == 0) return;
    if (_borrowedActivePP >= purePremiumWon) {
      _borrowedActivePP -= purePremiumWon;
    } else {
      if (_borrowedActivePP > 0) {
        purePremiumWon -= _borrowedActivePP;
        _borrowedActivePP = 0;
      }
      _wonPurePremiums += purePremiumWon;
    }
  }

  function _processResolution(
    Policy.PolicyData storage policy,
    bool customerWon,
    uint256 payout
  ) internal returns (uint256, uint256) {
    uint256 borrowFromScr = 0;
    uint256 purePremiumWon;
    uint256 aux;

    if (customerWon) {
      _transferTo(_policyNFT.ownerOf(policy.id), payout);
      uint256 returnToRm;
      (aux, purePremiumWon, returnToRm) = policy.splitPayout(payout);
      if (returnToRm > 0) _transferTo(policy.riskModule.wallet(), returnToRm);
      borrowFromScr = _payFromPool(aux);
    } else {
      // Pay RM and Ensuro
      _transferTo(policy.riskModule.wallet(), policy.premiumForRm + policy.rmScr());
      _transferTo(_config.treasury(), policy.premiumForEnsuro);
      purePremiumWon = policy.purePremium;
      // cover first _borrowedActivePP
      if (_borrowedActivePP > _activePurePremiums) {
        aux = Math.min(_borrowedActivePP - _activePurePremiums, purePremiumWon);
        _borrowedActivePP -= aux;
        purePremiumWon -= aux;
      }
    }
    return (borrowFromScr, purePremiumWon);
  }

  function expirePolicy(uint256 policyId) external whenNotPaused {
    Policy.PolicyData storage policy = _policies[policyId];
    require(policy.id == policyId && policyId != 0, "Policy not found");
    require(policy.expiration <= block.timestamp, "Policy not expired yet");
    return _resolvePolicy(policyId, 0, true);
  }

  function resolvePolicy(uint256 policyId, uint256 payout) external override whenNotPaused {
    return _resolvePolicy(policyId, payout, false);
  }

  function resolvePolicyFullPayout(uint256 policyId, bool customerWon)
    external
    override
    whenNotPaused
  {
    return _resolvePolicy(policyId, customerWon ? _policies[policyId].payout : 0, false);
  }

  function _resolvePolicy(
    uint256 policyId,
    uint256 payout,
    bool expired
  ) internal {
    Policy.PolicyData storage policy = _policies[policyId];
    require(policy.id == policyId && policyId != 0, "Policy not found");
    IRiskModule rm = policy.riskModule;
    require(expired || address(rm) == msg.sender, "Only the RM can resolve policies");
    _config.checkAcceptsResolvePolicy(rm);
    require(payout <= policy.payout, "Actual payout can't be more than policy payout");

    bool customerWon = payout > 0;

    _activePremiums -= policy.premium;
    _activePurePremiums -= policy.purePremium;

    (uint256 borrowFromScr, uint256 purePremiumWon) = _processResolution(
      policy,
      customerWon,
      payout
    );

    if (customerWon) {
      uint256 borrowFromScrLeft;
      borrowFromScrLeft = _updatePolicyFundsCustWon(policy, borrowFromScr);
      if (borrowFromScrLeft > NEGLIGIBLE_AMOUNT)
        borrowFromScrLeft = _takeLoanFromAnyEtk(borrowFromScrLeft);
      require(
        borrowFromScrLeft <= NEGLIGIBLE_AMOUNT,
        "Don't know where to take the rest of the money"
      );
    } else {
      purePremiumWon = _updatePolicyFundsCustLost(policy, purePremiumWon);
    }

    _storePurePremiumWon(purePremiumWon); // it's possible in some cases purePremiumWon > 0 && customerWon

    emit PolicyResolved(policy.riskModule, policy.id, payout);
    delete _policies[policy.id];
    delete _policiesFunds[policy.id];
  }

  function _interestAdjustment(Policy.PolicyData storage policy)
    internal
    view
    returns (bool, uint256)
  {
    // Calculate interest accrual adjustment
    uint256 aux = policy.accruedInterest();
    if (policy.premiumForLps >= aux) return (true, policy.premiumForLps - aux);
    else return (false, aux - policy.premiumForLps);
  }

  function _updatePolicyFundsCustWon(Policy.PolicyData storage policy, uint256 borrowFromScr)
    internal
    returns (uint256)
  {
    uint256 borrowFromScrLeft = 0;
    uint256 interestRate = policy.interestRate();
    (bool positive, uint256 adjustment) = _interestAdjustment(policy);

    // Iterate policyFunds - unlockScr / adjust / take loan
    DataTypes.ETokenToWadMap storage policyFunds = _policiesFunds[policy.id];
    for (uint256 i = 0; i < policyFunds.length(); i++) {
      (IEToken etk, uint256 etkScr) = policyFunds.at(i);
      etk.unlockScr(interestRate, etkScr);
      etkScr = etkScr.wadDiv(policy.scr);
      // etkScr now represents the share of SCR that's covered by this etk (variable reuse)
      etk.discreteEarning(adjustment.wadMul(etkScr), positive);
      if (borrowFromScr > 0) {
        uint256 aux;
        aux = borrowFromScr.wadMul(etkScr);
        borrowFromScrLeft += aux - etk.lendToPool(aux, true);
      }
    }
    return borrowFromScrLeft;
  }

  // Almost duplicated code from _updatePolicyFundsCustWon but separated to avoid stack depth error
  function _updatePolicyFundsCustLost(Policy.PolicyData storage policy, uint256 purePremiumWon)
    internal
    returns (uint256)
  {
    uint256 interestRate = policy.interestRate();
    (bool positive, uint256 adjustment) = _interestAdjustment(policy);

    // Iterate policyFunds - unlockScr / adjust / repay loan
    DataTypes.ETokenToWadMap storage policyFunds = _policiesFunds[policy.id];
    for (uint256 i = 0; i < policyFunds.length(); i++) {
      (IEToken etk, uint256 etkScr) = policyFunds.at(i);
      etk.unlockScr(interestRate, etkScr);
      etkScr = etkScr.wadDiv(policy.scr);
      // etkScr now represents the share of SCR that's covered by this etk (variable reuse)
      etk.discreteEarning(adjustment.wadMul(etkScr), positive);
      if (purePremiumWon > 0 && etk.getPoolLoan() > 0) {
        uint256 aux;
        // if debt with token, repay from purePremium
        aux = policy.purePremium.wadMul(etkScr);
        aux = Math.min(purePremiumWon, Math.min(etk.getPoolLoan(), aux));
        etk.repayPoolLoan(aux);
        purePremiumWon -= aux;
      }
    }
    return purePremiumWon;
  }

  /*
   * Called when the payout to be taken from policyFunds wasn't enought.
   * Then I take loan from the others tokens
   */
  function _takeLoanFromAnyEtk(uint256 loanLeft) internal returns (uint256) {
    for (uint256 i = 0; i < _eTokens.length(); i++) {
      (IEToken etk, DataTypes.ETokenStatus etkStatus) = _eTokens.at(i);
      if (etkStatus != DataTypes.ETokenStatus.active) continue;
      loanLeft -= etk.lendToPool(loanLeft, false);
      if (loanLeft <= NEGLIGIBLE_AMOUNT) break;
    }
    return loanLeft;
  }

  /**
   *
   * Repays a loan taken with the eToken with the money in the premium pool.
   * The repayment should happen without calling this method when customer losses and eToken is one of the
   * policyFunds. But sometimes we need to take loans from tokens not linked to the policy.
   *
   * returns The amount repaid
   *
   * Requirements:
   *
   * - `eToken` must be `active` or `deprecated`
   */
  function repayETokenLoan(IEToken eToken) external whenNotPaused returns (uint256) {
    (bool found, DataTypes.ETokenStatus etkStatus) = _eTokens.tryGet(eToken);
    require(
      found &&
        (etkStatus == DataTypes.ETokenStatus.active ||
          etkStatus == DataTypes.ETokenStatus.deprecated),
      "eToken is not active"
    );
    uint256 poolLoan = eToken.getPoolLoan();
    uint256 toPayLater = _payFromPool(poolLoan);
    eToken.repayPoolLoan(poolLoan - toPayLater);
    return poolLoan - toPayLater;
  }

  /**
   *
   * Endpoint to receive "free money" and inject that money into the premium pool.
   *
   * Can be used for example if the PolicyPool subscribes an excess loss policy with other company.
   *
   */
  function receiveGrant(uint256 amount) external override {
    _currency.safeTransferFrom(msg.sender, address(this), amount);
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
   * - onlyRole(WITHDRAW_WON_PREMIUMS_ROLE)
   * - _wonPurePremiums > 0
   */
  function withdrawWonPremiums(uint256 amount)
    external
    onlyRole(WITHDRAW_WON_PREMIUMS_ROLE)
    returns (uint256)
  {
    if (amount > _wonPurePremiums) amount = _wonPurePremiums;
    require(amount > 0, "No premiums to withdraw");
    _wonPurePremiums -= amount;
    _transferTo(_config.treasury(), amount);
    emit WonPremiumsInOut(false, amount);
    return amount;
  }

  function rebalancePolicy(uint256 policyId) external onlyRole(REBALANCE_ROLE) whenNotPaused {
    Policy.PolicyData storage policy = _policies[policyId];
    require(policy.id == policyId && policyId != 0, "Policy not found");
    DataTypes.ETokenToWadMap storage policyFunds = _policiesFunds[policyId];
    uint256 ocean = 0;

    // Iterates all the tokens
    // If locked - unlocks - finally stores the available ocean in policyFunds
    for (uint256 i = 0; i < _eTokens.length(); i++) {
      (IEToken etk, DataTypes.ETokenStatus etkStatus) = _eTokens.at(i);
      uint256 etkOcean = 0;
      (bool locked, uint256 etkScr) = policyFunds.tryGet(etk);
      if (locked) {
        etk.unlockScr(policy.interestRate(), etkScr);
      }
      if (
        etkStatus == DataTypes.ETokenStatus.active &&
        etk.accepts(address(policy.riskModule), policy.expiration)
      ) etkOcean = etk.oceanForNewScr();
      if (etkOcean == 0) {
        if (locked) policyFunds.remove(etk);
      } else {
        policyFunds.set(etk, etkOcean);
        ocean += etkOcean;
      }
    }

    _distributeScr(policy.scr, policy.interestRate(), ocean, policyFunds);
    emit PolicyRebalanced(policy.riskModule, policy.id);
  }

  function getInvestable() external view override returns (uint256) {
    uint256 borrowedFromEtk = 0;
    for (uint256 i = 0; i < _eTokens.length(); i++) {
      (
        IEToken etk, /* DataTypes.ETokenStatus etkStatus */

      ) = _eTokens.at(i);
      // TODO: define if not active are investable or not
      borrowedFromEtk += etk.getPoolLoan();
    }
    uint256 premiums = _activePremiums + _wonPurePremiums - _borrowedActivePP;
    if (premiums > borrowedFromEtk) return premiums - borrowedFromEtk;
    else return 0;
  }

  function totalETokenSupply() public view override returns (uint256) {
    uint256 ret = 0;
    for (uint256 i = 0; i < _eTokens.length(); i++) {
      (
        IEToken etk, /* DataTypes.ETokenStatus etkStatus */

      ) = _eTokens.at(i);
      // TODO: define if not active are investable or not
      ret += etk.totalSupply();
    }
    return ret;
  }

  function assetEarnings(uint256 amount, bool positive)
    external
    override
    onlyAssetManager
    whenNotPaused
  {
    if (positive) {
      // earnings
      _storePurePremiumWon(amount);
    } else {
      // losses
      _payFromPool(amount); // return value should be 0 if not, losses are more than capital available
    }
  }

  function getPolicy(uint256 policyId) external view override returns (Policy.PolicyData memory) {
    return _policies[policyId];
  }

  function getPolicyFundCount(uint256 policyId) external view returns (uint256) {
    return _policiesFunds[policyId].length();
  }

  function getPolicyFundAt(uint256 policyId, uint256 index)
    external
    view
    returns (IEToken, uint256)
  {
    return _policiesFunds[policyId].at(index);
  }

  function getPolicyFund(uint256 policyId, IEToken etoken) external view returns (uint256) {
    (bool success, uint256 amount) = _policiesFunds[policyId].tryGet(etoken);
    if (success) return amount;
    else return 0;
  }

  function getETokenCount() external view override returns (uint256) {
    return _eTokens.length();
  }

  function getETokenAt(uint256 index) external view override returns (IEToken) {
    (IEToken etk, DataTypes.ETokenStatus etkStatus) = _eTokens.at(index);
    if (etkStatus != DataTypes.ETokenStatus.inactive) return etk;
    else return IEToken(address(0));
  }
}
