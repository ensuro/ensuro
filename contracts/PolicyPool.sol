// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {AddressUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/AddressUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IAccessManager} from "./interfaces/IAccessManager.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {IPremiumsAccount} from "./interfaces/IPremiumsAccount.sol";
import {IPolicyPool} from "./interfaces/IPolicyPool.sol";
import {IRiskModule} from "./interfaces/IRiskModule.sol";
import {IPolicyPoolComponent} from "./interfaces/IPolicyPoolComponent.sol";
import {IEToken} from "./interfaces/IEToken.sol";
import {IPolicyNFT} from "./interfaces/IPolicyNFT.sol";
import {IPolicyHolder} from "./interfaces/IPolicyHolder.sol";
import {Policy} from "./Policy.sol";
import {WadRayMath} from "./WadRayMath.sol";

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
contract PolicyPool is IPolicyPool, PausableUpgradeable, UUPSUpgradeable {
  using EnumerableSet for EnumerableSet.AddressSet;
  using WadRayMath for uint256;
  using Policy for Policy.PolicyData;
  using SafeERC20 for IERC20Metadata;

  bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
  bytes32 public constant LEVEL1_ROLE = keccak256("LEVEL1_ROLE");
  bytes32 public constant LEVEL2_ROLE = keccak256("LEVEL2_ROLE");
  bytes32 public constant LEVEL3_ROLE = keccak256("LEVEL3_ROLE");

  /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
  IAccessManager internal immutable _access;
  /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
  IERC20Metadata internal immutable _currency;
  /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
  IPolicyNFT internal immutable _policyNFT;

  address internal _treasury; // address of Ensuro treasury

  enum ComponentStatus {
    inactive, // doesn't exists - All operations rejected
    active, // deposit / withdraw / lockScr / unlockScr / newPolicy / resolvePolicy OK
    deprecated, // withdraw OK, unlockScr OK, deposit rejected, no new policies
    suspended // all operations temporarily rejected
  }

  /**
   * @dev Mapping of installed eTokens (see {EToken}) in the PolicyPool. For each one it keep an state
   * {ComponentStatus}.
   */
  mapping(IEToken => ComponentStatus) private _eTokens;

  /**
   * @dev Mapping of installed risk modules (see {RiskModule}) in the PolicyPool. For each one it keep an state
   * {ComponentStatus}.
   */
  mapping(IRiskModule => ComponentStatus) private _riskModules;

  /**
   * @dev Mapping that stores the active policies (the policyId is the key). It just saves the hash of the policies,
   * the full {Policy-PolicyData} struct has to be sent for each operation (hash is used to verify).
   */
  mapping(uint256 => bytes32) internal _policies;

  /**
   * @dev Event emitted every time a new policy is added to the pool. Contains all the data about the policy that is
   * later required for doing operations with the policy like resolution or expiration.
   */
  event NewPolicy(IRiskModule indexed riskModule, Policy.PolicyData policy);

  /**
   * @dev Event emitted every time a policy is removed from the pool. If the policy expired, the `payout` is 0,
   * otherwise is the amount transferred to the policyholder.
   */
  event PolicyResolved(IRiskModule indexed riskModule, uint256 indexed policyId, uint256 payout);

  /**
   * @dev Event emitted when a new eToken is added to the pool or the status changes. See {ComponentStatus}.
   */
  event ETokenStatusChanged(IEToken indexed eToken, ComponentStatus newStatus);

  /**
   * @dev Event emitted when a new RiskModule is added to the pool or the status changes. See {ComponentStatus}.
   */
  event RiskModuleStatusChanged(IRiskModule indexed riskModule, ComponentStatus newStatus);

  /**
   * @dev Event emitted when a new PremiumsAccount is added to the pool or the status changes. TODO
   */
  event PremiumsAccountStatusChanged(
    IPremiumsAccount indexed premiumsAccount,
    ComponentStatus newStatus
  );

  event ComponentChanged(IAccessManager.GovernanceActions indexed action, address value);

  modifier onlyRole(bytes32 role) {
    _access.checkRole(role, msg.sender);
    _;
  }

  modifier onlyRole2(bytes32 role1, bytes32 role2) {
    _access.checkRole2(role1, role2, msg.sender);
    _;
  }

  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor(
    IAccessManager access_,
    IPolicyNFT policyNFT_,
    IERC20Metadata currency_
  ) {
    _access = access_;
    _policyNFT = policyNFT_;
    _currency = currency_;
  }

  function initialize(address treasury_) public initializer {
    __UUPSUpgradeable_init();
    __Pausable_init();
    __PolicyPool_init_unchained(treasury_);
  }

  // solhint-disable-next-line func-name-mixedcase
  function __PolicyPool_init_unchained(address treasury_) internal initializer {
    _policyNFT.connect();
    _treasury = treasury_;
  }

  // solhint-disable-next-line no-empty-blocks
  function _authorizeUpgrade(address) internal override onlyRole2(GUARDIAN_ROLE, LEVEL1_ROLE) {}

  function pause() public onlyRole(GUARDIAN_ROLE) {
    _pause();
  }

  function unpause() public onlyRole2(GUARDIAN_ROLE, LEVEL1_ROLE) {
    _unpause();
  }

  function access() external view virtual override returns (IAccessManager) {
    return _access;
  }

  function currency() external view virtual override returns (IERC20Metadata) {
    return _currency;
  }

  function policyNFT() external view virtual override returns (address) {
    return address(_policyNFT);
  }

  function setTreasury(address treasury_) external onlyRole(LEVEL1_ROLE) {
    _treasury = treasury_;
    emit ComponentChanged(IAccessManager.GovernanceActions.setTreasury, _treasury);
  }

  function treasury() external view override returns (address) {
    return _treasury;
  }

  function addEToken(IEToken eToken) external onlyRole(LEVEL1_ROLE) {
    ComponentStatus status = _eTokens[eToken];
    require(status == ComponentStatus.inactive, "eToken already in the pool");
    require(
      IPolicyPoolComponent(address(eToken)).policyPool() == this,
      "EToken not linked to this pool"
    );

    _eTokens[eToken] = ComponentStatus.active;
    emit ETokenStatusChanged(eToken, ComponentStatus.active);
  }

  function removeEToken(IEToken eToken) external onlyRole(LEVEL3_ROLE) {
    ComponentStatus status = _eTokens[eToken];
    require(status == ComponentStatus.deprecated, "EToken not deprecated");
    require(eToken.totalSupply() == 0, "EToken has liquidity, can't be removed");
    delete _eTokens[eToken];
    emit ETokenStatusChanged(eToken, ComponentStatus.inactive);
  }

  function changeETokenStatus(IEToken eToken, ComponentStatus newStatus)
    external
    onlyRole2(GUARDIAN_ROLE, LEVEL1_ROLE)
  {
    ComponentStatus status = _eTokens[eToken];
    require(status != ComponentStatus.inactive, "EToken not found");
    require(
      (newStatus == ComponentStatus.active && _access.hasRole(LEVEL1_ROLE, msg.sender)) ||
        (newStatus == ComponentStatus.suspended && _access.hasRole(GUARDIAN_ROLE, msg.sender)) ||
        (newStatus == ComponentStatus.deprecated && _access.hasRole(LEVEL1_ROLE, msg.sender)),
      "Only GUARDIAN can suspend / Only LEVEL1 can activate/deprecate"
    );
    _eTokens[eToken] = newStatus;
    emit ETokenStatusChanged(eToken, newStatus);
  }

  function getETokenStatus(IEToken eToken) external view returns (ComponentStatus) {
    return _eTokens[eToken];
  }

  function addRiskModule(IRiskModule riskModule) external onlyRole(LEVEL1_ROLE) {
    require(
      _riskModules[riskModule] == ComponentStatus.inactive,
      "Risk Module already in the pool"
    );
    require(
      IPolicyPoolComponent(address(riskModule)).policyPool() == this,
      "RiskModule not linked to this pool"
    );
    _riskModules[riskModule] = ComponentStatus.active;
    emit RiskModuleStatusChanged(riskModule, ComponentStatus.active);
  }

  function removeRiskModule(IRiskModule riskModule) external onlyRole(LEVEL2_ROLE) {
    require(_riskModules[riskModule] != ComponentStatus.inactive, "Risk Module not found");
    require(riskModule.activeExposure() == 0, "Can't remove a module with active policies");
    delete _riskModules[riskModule];
    emit RiskModuleStatusChanged(riskModule, ComponentStatus.inactive);
  }

  function changeRiskModuleStatus(IRiskModule riskModule, ComponentStatus newStatus)
    external
    onlyRole2(GUARDIAN_ROLE, LEVEL1_ROLE)
  {
    require(_riskModules[riskModule] != ComponentStatus.inactive, "Risk Module not found");
    require(
      (newStatus == ComponentStatus.active && _access.hasRole(LEVEL1_ROLE, msg.sender)) ||
        (newStatus == ComponentStatus.suspended && _access.hasRole(GUARDIAN_ROLE, msg.sender)) ||
        (newStatus == ComponentStatus.deprecated && _access.hasRole(LEVEL1_ROLE, msg.sender)),
      "Only GUARDIAN can suspend / Only LEVEL1 can activate/deprecate"
    );
    _riskModules[riskModule] = newStatus;
    emit RiskModuleStatusChanged(riskModule, newStatus);
  }

  function getRiskModuleStatus(IRiskModule riskModule) external view returns (ComponentStatus) {
    return _riskModules[riskModule];
  }

  function addPremiumsAccount(IPremiumsAccount pa) external onlyRole(LEVEL1_ROLE) {
    // TODO: keep PremiumsAccount status?
    require(
      IPolicyPoolComponent(address(pa)).policyPool() == this,
      "PremiumsAccount not linked to this pool"
    );
    IEToken etk = pa.juniorEtk();
    if (address(etk) != address(0)) {
      etk.addBorrower(address(pa));
    }
    etk = pa.seniorEtk();
    if (address(etk) != address(0)) {
      etk.addBorrower(address(pa));
    }
    emit PremiumsAccountStatusChanged(pa, ComponentStatus.active);
    // TODO: functions for deactivating premiumsAccount (and remove them as borrower)
  }

  function deposit(IEToken eToken, uint256 amount) external override whenNotPaused {
    ComponentStatus etkStatus = _eTokens[eToken];
    require(etkStatus == ComponentStatus.active, "eToken is not active");
    _currency.safeTransferFrom(msg.sender, address(eToken), amount);
    eToken.deposit(msg.sender, amount);
  }

  function withdraw(IEToken eToken, uint256 amount)
    external
    override
    whenNotPaused
    returns (uint256)
  {
    ComponentStatus etkStatus = _eTokens[eToken];
    require(
      etkStatus == ComponentStatus.active || etkStatus == ComponentStatus.deprecated,
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
    require(_riskModules[rm] == ComponentStatus.active, "RM module not found or not active");
    policy.id = (uint256(uint160(address(rm))) << 96) + internalId;
    _policies[policy.id] = policy.hash();
    IPremiumsAccount pa = rm.premiumsAccount();
    pa.policyCreated(policy);
    _policyNFT.safeMint(customer, policy.id);

    // Distribute the premium
    _currency.safeTransferFrom(customer, address(pa), policy.purePremium);
    if (policy.srCoc > 0)
      _currency.safeTransferFrom(customer, address(pa.seniorEtk()), policy.srCoc);
    if (policy.jrCoc > 0)
      _currency.safeTransferFrom(customer, address(pa.juniorEtk()), policy.jrCoc);
    _currency.safeTransferFrom(customer, _treasury, policy.ensuroCommission);
    if (policy.partnerCommission > 0 && customer != rm.wallet())
      _currency.safeTransferFrom(customer, rm.wallet(), policy.partnerCommission);
    // TODO: this code does up to 5 ERC20 transfers. How we can avoid this? Delayed transfers?

    emit NewPolicy(rm, policy);
    return policy.id;
  }

  function _balance() internal view returns (uint256) {
    return _currency.balanceOf(address(this));
  }

  function _validatePolicy(Policy.PolicyData memory policy) internal view {
    require(policy.id != 0 && policy.hash() == _policies[policy.id], "Policy not found");
  }

  function expirePolicy(Policy.PolicyData calldata policy) external override whenNotPaused {
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

  /**
   * @dev Internal function that handles the different alternative resolutions for a policy, with or without payout and
   * expiration.
   *
   * @param policy A policy created with {Policy-initialize}
   * @param payout The amount to paid to the policyholder
   * @param expired True for expiration resolution (`payout` must be 0)
   */
  function _resolvePolicy(
    Policy.PolicyData memory policy,
    uint256 payout,
    bool expired
  ) internal {
    _validatePolicy(policy);
    IRiskModule rm = policy.riskModule;
    require(expired || address(rm) == msg.sender, "Only the RM can resolve policies");
    require(payout == 0 || policy.expiration > block.timestamp, "Can't pay expired policy");
    require(
      _riskModules[rm] == ComponentStatus.active || _riskModules[rm] == ComponentStatus.deprecated,
      "Module must be active or deprecated to process resolutions"
    );
    require(payout <= policy.payout, "payout > policy.payout");

    bool customerWon = payout > 0;

    if (customerWon) {
      address policyOwner = _policyNFT.ownerOf(policy.id);
      rm.premiumsAccount().policyResolvedWithPayout(policyOwner, policy, payout);
    } else {
      rm.premiumsAccount().policyExpired(policy);
    }

    rm.releaseExposure(policy.payout);

    emit PolicyResolved(policy.riskModule, policy.id, payout);
    delete _policies[policy.id];
    if (payout > 0) {
      _notifyPayout(policy.id, payout);
    } else {
      _notifyExpiration(policy.id);
    }
  }

  /**
   * @dev Notifies the payout with a callback if the policyholder is a contract. Only reverts if the policyholder
   * contract explicitly reverts. Doesn't reverts is the callback is not implemented.
   */
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

  /**
   * @dev Notifies the expiration with a callback if the policyholder is a contract. Never reverts.
   */
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
}
