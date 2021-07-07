// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Enumerable} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import {Pausable} from "@openzeppelin/contracts/security/Pausable.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {IPolicyPool} from '../interfaces/IPolicyPool.sol';
import {IRiskModule} from '../interfaces/IRiskModule.sol';
import {IPolicyPoolComponent} from '../interfaces/IPolicyPoolComponent.sol';
import {IEToken} from '../interfaces/IEToken.sol';
import {Policy} from './Policy.sol';
import {WadRayMath} from './WadRayMath.sol';
import {Math} from '@openzeppelin/contracts/utils/math/Math.sol';
import {DataTypes} from './DataTypes.sol';

/// #invariant {:msg "Borrow up to activePurePremiums"} _borrowedActivePP <= _activePurePremiums;
/// #invariant {:msg "Can't borrow if not exhausted before won"} (_borrowedActivePP > 0) ==> _wonPurePremiums == 0;
contract PolicyPool is IPolicyPool, ERC721, ERC721Enumerable, Pausable, AccessControl {
  using EnumerableSet for EnumerableSet.AddressSet;
  using WadRayMath for uint256;
  using SafeERC20 for IERC20;
  using Policy for Policy.PolicyData;
  using DataTypes for DataTypes.ETokenToWadMap;
  using DataTypes for DataTypes.RiskModuleStatusMap;
  using DataTypes for DataTypes.ETokenStatusMap;

  bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
  bytes32 public constant ENSURO_DAO_ROLE = keccak256("ENSURO_DAO_ROLE");
  bytes32 public constant REBALANCE_ROLE = keccak256("REBALANCE_ROLE");

  uint256 public constant MAX_ETOKENS = 10;

  /// #if_updated {:msg "Only set on creation"} msg.sig == bytes4(0);
  IERC20 internal _currency;

  DataTypes.RiskModuleStatusMap internal _riskModules;
  DataTypes.ETokenStatusMap internal _eTokens;

  mapping (uint256 => Policy.PolicyData) internal _policies;
  mapping (uint256 => DataTypes.ETokenToWadMap) internal _policiesFunds;
  /// #if_updated {:msg "Id that only goes up by one"} _policyCount == old(_policyCount + 1);
  uint256 internal _policyCount;   // Growing id for policies

  uint256 internal _activePremiums;    // sum of premiums of active policies - In Wad
  uint256 internal _activePurePremiums;    // sum of pure-premiums of active policies - In Wad
  uint256 internal _borrowedActivePP;    // amount borrowed from active pure premiums to pay defaulted policies
  uint256 internal _wonPurePremiums;     // amount of pure premiums won from non-defaulted policies

  address internal _treasury;            // address of Ensuro treasury
  address internal _assetManager;        // asset manager (TBD)

  event NewPolicy(IRiskModule indexed riskModule, uint256 policyId);
  event PolicyRebalanced(IRiskModule indexed riskModule, uint256 indexed policyId);
  event PolicyResolved(IRiskModule indexed riskModule, uint256 indexed policyId, uint256 payout);

  event RiskModuleStatusChanged(IRiskModule indexed riskModule, DataTypes.RiskModuleStatus newStatus);

  event ETokenStatusChanged(IEToken indexed eToken, DataTypes.ETokenStatus newStatus);
  event AssetManagerChanged(address indexed assetManager);

  event Withdrawal(IEToken indexed eToken, address indexed provider, uint256 value);

  modifier onlyAssetManager {
    require(_msgSender() == _assetManager, "Only assetManager can call this function");
    _;
  }

  constructor(
    string memory name_,
    string memory symbol_,
    IERC20 curreny_,
    address treasury_,
    address assetManager_

  ) ERC721(name_, symbol_) {
    _setupRole(DEFAULT_ADMIN_ROLE, msg.sender);
    _setupRole(PAUSER_ROLE, msg.sender);
    _currency = curreny_;
    /*
    _policyCount = 0;
    _activePurePremiums = 0;
    _activePremiums = 0;
    _borrowedActivePP = 0;
    _wonPurePremiums = 0;
    */
    _treasury = treasury_;
    _assetManager = assetManager_;
  }

  function pause() public {
    require(hasRole(PAUSER_ROLE, msg.sender));
    _pause();
  }

  function unpause() public {
    require(hasRole(PAUSER_ROLE, msg.sender));
    _unpause();
  }

  function _beforeTokenTransfer(address from, address to, uint256 tokenId)
    internal
    whenNotPaused
    override(ERC721, ERC721Enumerable)
  {
    super._beforeTokenTransfer(from, to, tokenId);
  }

  function supportsInterface(bytes4 interfaceId)
    public
    view
    override(ERC721, ERC721Enumerable, AccessControl)
    returns (bool)
  {
    return super.supportsInterface(interfaceId);
  }

  function currency() external view virtual override returns (IERC20) {
    return _currency;
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

  function addRiskModule(IRiskModule riskModule) external onlyRole(ENSURO_DAO_ROLE) {
    require(!_riskModules.contains(riskModule), "Risk Module already in the pool");
    require(address(riskModule) != address(0), "riskModule can't be zero");
    require(IPolicyPoolComponent(address(riskModule)).policyPool() == this, "RiskModule not linked to this pool");
    _riskModules.set(riskModule, DataTypes.RiskModuleStatus.active);
    emit RiskModuleStatusChanged(riskModule, DataTypes.RiskModuleStatus.active);
  }

  /// #if_success _riskModules[riskModule] == DataTypes.RiskModuleStatus.inactive;
  function removeRiskModule(IRiskModule riskModule) external onlyRole(ENSURO_DAO_ROLE) {
    require(_riskModules.contains(riskModule), "Risk Module not found");
    require(riskModule.totalScr() == 0, "Can't remove a module with active policies");
    _riskModules.remove(riskModule);
    emit RiskModuleStatusChanged(riskModule, DataTypes.RiskModuleStatus.inactive);
  }

  /// #if_success _riskModules[riskModule] == newStatus;
  function changeRiskModuleStatus(IRiskModule riskModule, DataTypes.RiskModuleStatus newStatus)
        external onlyRole(ENSURO_DAO_ROLE) {
    require(_riskModules.contains(riskModule), "Risk Module not found");
    _riskModules.set(riskModule, newStatus);
    emit RiskModuleStatusChanged(riskModule, newStatus);
  }

  /// #if_success {:msg "eToken added as active"} _eTokens[eToken] == DataTypes.ETokenStatus.active;
  function addEToken(IEToken eToken) external onlyRole(ENSURO_DAO_ROLE) {
    require(_eTokens.length() < MAX_ETOKENS, "Maximum number of ETokens reached");
    require(!_eTokens.contains(eToken), "eToken already in the pool");
    require(address(eToken) != address(0), "eToken can't be zero");
    require(IPolicyPoolComponent(address(eToken)).policyPool() == this, "EToken not linked to this pool");

    _eTokens.set(eToken, DataTypes.ETokenStatus.active);
    emit ETokenStatusChanged(eToken, DataTypes.ETokenStatus.active);
  }

  // TODO: removeEToken
  // TODO: changeETokenStatus

  function setAssetManager(address assetManager_) external onlyRole(ENSURO_DAO_ROLE) {
    _assetManager = assetManager_;
    emit AssetManagerChanged(_assetManager);
  }

  function assetManager() external view virtual override returns (address) {
    return _assetManager;
  }

  /// #if_success
  ///    {:msg "must take balance from sender"}
  ///    _currency.balanceOf(_msgSender()) == old(_currency.balanceOf(_msgSender()) + amount)
  function deposit(IEToken eToken, uint256 amount) external {
    (bool found, DataTypes.ETokenStatus etkStatus) = _eTokens.tryGet(eToken);
    require(found && etkStatus == DataTypes.ETokenStatus.active, "eToken is not active");
    _currency.safeTransferFrom(_msgSender(), address(this), amount);
    eToken.deposit(_msgSender(), amount);
  }

  function withdraw(IEToken eToken, uint256 amount) external returns (uint256) {
    (bool found, DataTypes.ETokenStatus etkStatus) = _eTokens.tryGet(eToken);
    require(found && (
      (etkStatus == DataTypes.ETokenStatus.active || etkStatus == DataTypes.ETokenStatus.deprecated)
    ), "eToken not found or withdraws not allowed");
    address provider = _msgSender();
    uint256 withdrawed = eToken.withdraw(provider, amount);
    if (withdrawed > 0)
      _transferTo(provider, withdrawed);
    emit Withdrawal(eToken, provider, withdrawed);
    return withdrawed;
  }

  function newPolicy(Policy.PolicyData memory policy_, address customer) external override returns (uint256) {
    IRiskModule rm = policy_.riskModule;
    require(address(rm) == _msgSender(), "Only the RM can create new policies");
    (bool success, DataTypes.RiskModuleStatus rmStatus) = _riskModules.tryGet(rm);
    require(success && rmStatus == DataTypes.RiskModuleStatus.active, "RM module not found or not active");
    _policyCount += 1;
    _currency.safeTransferFrom(customer, address(this), policy_.premium);
    Policy.PolicyData storage policy = _policies[_policyCount] = policy_;
    policy.id = _policyCount;
    _safeMint(customer, policy.id);
    if (policy.rmScr() > 0)
      _currency.safeTransferFrom(rm.wallet(), address(this), policy.rmScr());
    _activePurePremiums +=  policy.purePremium;
    _activePremiums +=  policy.premium;
    _lockScr(policy);
    emit NewPolicy(rm, policy.id);
    return policy.id;
  }

  function _lockScr(Policy.PolicyData storage policy) internal {
    uint256 ocean = 0;
    DataTypes.ETokenToWadMap storage policyFunds = _policiesFunds[policy.id];

    // Initially I iterate over all eTokens and accumulate ocean of eligible ones
    // saves the ocean in policyFunds, later will
    for (uint256 i = 0; i < _eTokens.length(); i++) {
      (IEToken etk, DataTypes.ETokenStatus etkStatus) = _eTokens.at(i);
      if (etkStatus != DataTypes.ETokenStatus.active)
        continue;
      if (!etk.accepts(policy.expiration))
        continue;
      uint256 etkOcean = etk.oceanForNewScr();
      if (etkOcean == 0)
        continue;
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
  function _distributeScr(uint256 scr, uint256 interestRate, uint256 ocean,
                          DataTypes.ETokenToWadMap storage policyFunds) internal {
    require(ocean >= scr, "Not enought ocean to cover the policy");
    uint256 scr_not_locked = scr;

    for (uint256 i = 0; i < policyFunds.length(); i++) {
      uint256 etkScr;
      (IEToken etk, uint256 etkOcean) = policyFunds.at(i);
      if (i < policyFunds.length() - 1)
        etkScr = scr.wadMul(etkOcean).wadDiv(ocean);
      else
        etkScr = scr_not_locked;
      etk.lockScr(interestRate, etkScr);
      policyFunds.set(etk, etkScr);
      scr_not_locked -= etkScr;
    }
  }

  function _transferTo(address destination, uint256 amount) internal {
    // TODO asset management
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
    if (purePremiumWon == 0)
      return;
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
    Policy.PolicyData storage policy, bool customerWon, uint256 payout
  ) internal returns (uint256, uint256) {
    uint256 borrowFromScr;
    uint256 purePremiumWon;
    uint256 aux;

    if (customerWon) {
      uint256 returnToRm;
      (aux, purePremiumWon, returnToRm) = policy.splitPayout(payout);
      borrowFromScr = _payFromPool(aux);
      _transferTo(ownerOf(policy.id), payout);
      if (returnToRm > 0)
        _transferTo(policy.riskModule.wallet(), returnToRm);
    } else {
      // Pay RM and Ensuro
      _transferTo(policy.riskModule.wallet(), policy.premiumForRm + policy.rmScr());
      _transferTo(_treasury, policy.premiumForEnsuro);
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

  function resolvePolicy(uint256 policyId, uint256 payout) external override {
    return _resolvePolicy(policyId, payout);
  }

  function resolvePolicy(uint256 policyId, bool customerWon) external override {
    return _resolvePolicy(policyId, customerWon ? _policies[policyId].payout : 0);
  }

  function _resolvePolicy(uint256 policyId, uint256 payout) internal {
    Policy.PolicyData storage policy = _policies[policyId];
    require(policy.id == policyId && policyId != 0, "Policy not found");
    IRiskModule rm = policy.riskModule;
    require(address(rm) == _msgSender(), "Only the RM can resolve policies");
    DataTypes.RiskModuleStatus rmStatus = _riskModules.get(rm);
    require(
      rmStatus == DataTypes.RiskModuleStatus.active || rmStatus == DataTypes.RiskModuleStatus.deprecated,
      "Module must be active or deprecated to process resolutions"
    );
    require(payout <= policy.payout, "Actual payout can't be more than policy payout");

    bool customerWon = payout > 0;

    _activePremiums -= policy.premium;
    _activePurePremiums -= policy.purePremium;

    uint256 aux = policy.accruedInterest();
    bool positive = policy.premiumForLps >= aux;
    uint256 adjustment;
    if (positive)
      adjustment = policy.premiumForLps - aux;
    else
      adjustment = aux - policy.premiumForLps;

    (uint256 borrowFromScr, uint256 purePremiumWon) = _processResolution(policy, customerWon, payout);

    DataTypes.ETokenToWadMap storage policyFunds = _policiesFunds[policy.id];

    for (uint256 i = 0; i < policyFunds.length(); i++) {
      (IEToken etk, uint256 etkScr) = policyFunds.at(i);
      etk.unlockScr(policy.interestRate(), etkScr);
      etkScr = etkScr.wadDiv(policy.scr);  // Using the same variable, but now represents the share of SCR
                                           // that's covered by this etk
      etk.discreteEarning(adjustment.wadMul(etkScr), positive);
      if (!customerWon && purePremiumWon > 0 && etk.getPoolLoan() > 0) {
        // if debt with token, repay from purePremium
        aux = policy.purePremium.wadMul(etkScr);
        aux = Math.min(purePremiumWon, Math.min(etk.getPoolLoan(), aux));
        etk.repayPoolLoan(aux);
        purePremiumWon -= aux;
      } else {
        if (borrowFromScr > 0) {
          etk.lendToPool(borrowFromScr.wadMul(etkScr));
        }
      }
    }

    _storePurePremiumWon(purePremiumWon);
    // policy.rm.removePolicy...
    emit PolicyResolved(policy.riskModule, policy.id, payout);
    delete _policies[policy.id];
    delete _policiesFunds[policy.id];
  }

  function rebalancePolicy(uint256 policyId) external onlyRole(REBALANCE_ROLE) {
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
      if (etkStatus == DataTypes.ETokenStatus.active && etk.accepts(policy.expiration))
        etkOcean = etk.oceanForNewScr();
      if (etkOcean == 0) {
        if (locked)
          policyFunds.remove(etk);
      } else {
        policyFunds.set(etk, etkOcean);
        ocean += etkOcean;
      }
    }

    _distributeScr(policy.scr, policy.interestRate(), ocean, policyFunds);
    emit PolicyRebalanced(policy.riskModule, policy.id);
  }

  function getInvestable() external view returns (uint256) {
    uint256 borrowedFromEtk = 0;
    for (uint256 i = 0; i < _eTokens.length(); i++) {
      (IEToken etk, /* DataTypes.ETokenStatus etkStatus */) = _eTokens.at(i);
      // TODO: define if not active are investable or not
      borrowedFromEtk += etk.getPoolLoan();
    }
    uint256 premiums = _activePremiums + _wonPurePremiums - _borrowedActivePP;
    if (premiums > borrowedFromEtk)
      return premiums - borrowedFromEtk;
    else
      return 0;
  }

  function assetEarnings(uint256 amount, bool positive) external onlyAssetManager {
    if (positive) {
      // earnings
      _storePurePremiumWon(amount);
    } else {
      // losses
      _payFromPool(amount); // return value should be 0 if not, losses are more than capital available
    }
  }

  function getPolicy(uint256 policyId) external override view returns (Policy.PolicyData memory) {
    return _policies[policyId];
  }

  function getPolicyFundCount(uint256 policyId) external view returns (uint256) {
    return _policiesFunds[policyId].length();
  }

  function getPolicyFundAt(uint256 policyId, uint256 index) external view returns (IEToken, uint256) {
     return _policiesFunds[policyId].at(index);
  }

  function getPolicyFund(uint256 policyId, IEToken etoken) external view returns (uint256) {
     (bool success, uint256 amount) = _policiesFunds[policyId].tryGet(etoken);
     if (success)
       return amount;
     else
       return 0;
  }

}
