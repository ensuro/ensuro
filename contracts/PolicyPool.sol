// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {AddressUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/AddressUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPolicyPoolConfig} from "../interfaces/IPolicyPoolConfig.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {IPremiumsAccount} from "../interfaces/IPremiumsAccount.sol";
import {IPolicyPool} from "../interfaces/IPolicyPool.sol";
import {IRiskModule} from "../interfaces/IRiskModule.sol";
import {IPolicyPoolComponent} from "../interfaces/IPolicyPoolComponent.sol";
import {IEToken} from "../interfaces/IEToken.sol";
import {IPolicyNFT} from "../interfaces/IPolicyNFT.sol";
import {IPolicyHolder} from "../interfaces/IPolicyHolder.sol";
import {Policy} from "./Policy.sol";
import {WadRayMath} from "./WadRayMath.sol";
import {DataTypes} from "./DataTypes.sol";

/**
 * @title Ensuro PolicyPool contract
 * @dev This is the main contract of the protocol, it stores the eTokens (liquidity pools) and has the operations
 *      to interact with them. This is also the contract that receives and sends the underlying asset.
 *      Also this contract keeps track of accumulated premiums in different stages:
 *      - activePurePremiums
 *      - wonPurePremiums (surplus)
 *      - borrowedActivePP (deficit borrowed from activePurePremiums)
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
// #invariant_disabled {:msg "Borrow up to activePurePremiums"} _borrowedActivePP <= _activePurePremiums;
// #invariant_disabled {:msg "Can't borrow if not exhausted before won"} (_borrowedActivePP > 0) ==> _wonPurePremiums == 0;
contract PolicyPool is IPolicyPool, PausableUpgradeable, UUPSUpgradeable {
  using EnumerableSet for EnumerableSet.AddressSet;
  using WadRayMath for uint256;
  using Policy for Policy.PolicyData;
  using DataTypes for DataTypes.ETokenToWadMap;
  using DataTypes for DataTypes.ETokenStatusMap;
  using SafeERC20 for IERC20Metadata;

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

  mapping(uint256 => bytes32) internal _policies;
  mapping(uint256 => IEToken) internal _policySolvency;

  event NewPolicy(IRiskModule indexed riskModule, Policy.PolicyData policy);
  event PolicyRebalanced(IRiskModule indexed riskModule, uint256 indexed policyId);
  event PolicyResolved(IRiskModule indexed riskModule, uint256 indexed policyId, uint256 payout);

  event ETokenStatusChanged(IEToken indexed eToken, DataTypes.ETokenStatus newStatus);

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
    _policyNFT.connect();
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

  /// #if_succeeds
  ///    {:msg "must take balance from sender"}
  ///    _currency.balanceOf(msg.sender) == old(_currency.balanceOf(msg.sender) - amount);
  function deposit(IEToken eToken, uint256 amount) external override whenNotPaused {
    (bool found, DataTypes.ETokenStatus etkStatus) = _eTokens.tryGet(eToken);
    require(found && etkStatus == DataTypes.ETokenStatus.active, "eToken is not active");
    _currency.safeTransferFrom(msg.sender, address(eToken), amount);
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
    return eToken.withdraw(provider, amount);
  }

  function newPolicy(
    Policy.PolicyData memory policy,
    address customer,
    uint96 internalId
  ) external override whenNotPaused returns (uint256) {
    IRiskModule rm = policy.riskModule;
    require(address(rm) == msg.sender, "Only the RM can create new policies");
    _config.checkAcceptsNewPolicy(rm);
    policy.id = (uint256(uint160(address(rm))) << 96) + internalId;
    _policies[policy.id] = policy.hash();
    IPremiumsAccount pa = rm.premiumsAccount();
    pa.newPolicy(policy.purePremium);
    IEToken solvencyEtk = _lockScr(policy);
    _policyNFT.safeMint(customer, policy.id);
    _currency.safeTransferFrom(customer, address(pa), policy.purePremium);
    _currency.safeTransferFrom(customer, address(solvencyEtk), policy.premiumForLps);
    _currency.safeTransferFrom(customer, _config.treasury(), policy.premiumForEnsuro);
    if (policy.premiumForRm > 0 && customer != rm.wallet())
      _currency.safeTransferFrom(customer, rm.wallet(), policy.premiumForRm);
    emit NewPolicy(rm, policy);
    return policy.id;
  }

  function _lockScr(Policy.PolicyData memory policy) internal returns (IEToken) {
    // Initially I iterate over all eTokens and accumulate ocean of eligible ones
    // saves the ocean in policyFunds, later will _distributeScr
    for (uint256 i = 0; i < _eTokens.length(); i++) {
      (IEToken etk, DataTypes.ETokenStatus etkStatus) = _eTokens.at(i);
      if (etkStatus != DataTypes.ETokenStatus.active) continue;
      if (!etk.accepts(address(policy.riskModule), policy.expiration)) continue;
      uint256 etkOcean = etk.oceanForNewScr();
      if (etkOcean < policy.scr) continue;
      etk.lockScr(policy.interestRate(), policy.scr);
      _policySolvency[policy.id] = etk;
      return etk;
    }
    revert("Not enought ocean to cover the policy");
  }

  function _balance() internal view returns (uint256) {
    return _currency.balanceOf(address(this));
  }

  function _validatePolicy(Policy.PolicyData memory policy) internal view {
    require(policy.id != 0 && policy.hash() == _policies[policy.id], "Policy not found");
  }

  function expirePolicy(Policy.PolicyData calldata policy) external whenNotPaused {
    require(policy.expiration <= block.timestamp, "Policy not expired yet");
    return _resolvePolicy(policy, 0, true);
  }

  function resolvePolicy(Policy.PolicyData calldata policy, uint256 payout)
    external
    override
    whenNotPaused
  {
    return _resolvePolicy(policy, payout, false);
  }

  function resolvePolicyFullPayout(Policy.PolicyData calldata policy, bool customerWon)
    external
    override
    whenNotPaused
  {
    return _resolvePolicy(policy, customerWon ? policy.payout : 0, false);
  }

  function _resolvePolicy(
    Policy.PolicyData memory policy,
    uint256 payout,
    bool expired
  ) internal {
    _validatePolicy(policy);
    IRiskModule rm = policy.riskModule;
    require(expired || address(rm) == msg.sender, "Only the RM can resolve policies");
    require(payout == 0 || policy.expiration > block.timestamp, "Can't pay expired policy");
    _config.checkAcceptsResolvePolicy(rm);
    require(payout <= policy.payout, "payout > policy.payout");

    bool customerWon = payout > 0;

    // Unlock SCR and adjust eToken
    IEToken etk = _policySolvency[policy.id];
    etk.unlockScr(
      policy.interestRate(),
      policy.scr,
      int256(policy.premiumForLps) - int256(policy.accruedInterest())
    );

    if (customerWon) {
      address policyOwner = _policyNFT.ownerOf(policy.id);
      rm.premiumsAccount().policyResolvedWithPayout(policyOwner, policy.purePremium, payout, etk);
    } else {
      rm.premiumsAccount().policyExpired(policy.purePremium, etk);
    }

    rm.releaseScr(policy.scr);

    emit PolicyResolved(policy.riskModule, policy.id, payout);
    delete _policies[policy.id];
    delete _policySolvency[policy.id];
    if (payout > 0) {
      _notifyPayout(policy.id, payout);
    } else {
      _notifyExpiration(policy.id);
    }
  }

  function _notifyPayout(uint256 policyId, uint256 payout) internal {
    address customer = _policyNFT.ownerOf(policyId);
    if (!AddressUpgradeable.isContract(customer)) return;
    try
      IPolicyHolder(customer).onPayoutReceived(_msgSender(), address(this), policyId, payout)
    returns (bytes4 retval) {
      require(
        retval == IPolicyHolder.onPayoutReceived.selector,
        "Invalid return value from Policy Holder"
      );
    } catch (bytes memory reason) {
      if (reason.length == 0) {
        return; // Not implemented, it's fine
      } else {
        // solhint-disable-next-line no-inline-assembly
        assembly {
          revert(add(32, reason), mload(reason))
        }
      }
    }
  }

  function _notifyExpiration(uint256 policyId) internal {
    address customer = _policyNFT.ownerOf(policyId);
    if (!AddressUpgradeable.isContract(customer)) return;
    try IPolicyHolder(customer).onPolicyExpired(_msgSender(), address(this), policyId) returns (
      bytes4
    ) {
      return;
    } catch {
      return;
    }
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

  function getSolvencyETK(uint256 policyId) external view returns (IEToken) {
    return _policySolvency[policyId];
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
