// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {AddressUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/AddressUpgradeable.sol";
import {ERC165Checker} from "@openzeppelin/contracts/utils/introspection/ERC165Checker.sol";
import {ERC721Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import {IAccessManager} from "./interfaces/IAccessManager.sol";
import {IEToken} from "./interfaces/IEToken.sol";
import {IPolicyHolderV2} from "./interfaces/IPolicyHolderV2.sol";
import {IPolicyHolder} from "./interfaces/IPolicyHolder.sol";
import {IPolicyPool} from "./interfaces/IPolicyPool.sol";
import {IPolicyPoolComponent} from "./interfaces/IPolicyPoolComponent.sol";
import {IPremiumsAccount} from "./interfaces/IPremiumsAccount.sol";
import {IRiskModule} from "./interfaces/IRiskModule.sol";
import {Policy} from "./Policy.sol";

import {WadRayMath} from "./dependencies/WadRayMath.sol";

/**
 * @title Ensuro PolicyPool contract
 * @dev This is the main contract of the protocol, it stores the eTokens (liquidity pools) and has the operations
 *      to interact with them. This is also the contract that receives and sends the underlying asset (currency).
 *      Also this contract keeps track of accumulated premiums in different stages:
 *      - activePurePremiums
 *      - wonPurePremiums (surplus)
 *      - borrowedActivePP (deficit borrowed from activePurePremiums)
 *      This contract also implements the ERC721 standard, because it mints and NFT for each policy created. The
 *      property of the NFT represents the one that will receive the payout.
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
contract PolicyPool is IPolicyPool, PausableUpgradeable, UUPSUpgradeable, ERC721Upgradeable {
  using WadRayMath for uint256;
  using Policy for Policy.PolicyData;
  using SafeERC20 for IERC20Metadata;

  bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
  bytes32 public constant LEVEL1_ROLE = keccak256("LEVEL1_ROLE");
  bytes32 public constant LEVEL2_ROLE = keccak256("LEVEL2_ROLE");

  uint256 internal constant HOLDER_GAS_LIMIT = 150000;

  /**
   * @dev {AccessManager} that handles the access permissions for the PolicyPool and its components.
   */
  /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
  IAccessManager internal immutable _access;

  /**
   * @dev {ERC20} token used in PolicyPool as currency. Usually it will be a stablecoin such as USDC.
   */
  /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
  IERC20Metadata internal immutable _currency;

  /**
   * @dev Address of Ensuro's treasury that receives the protocol fees.
   */
  address internal _treasury; // address of Ensuro treasury

  /**
   * @dev This enum tracks the different status that a component ({PremiumsAccount}, {EToken} or {RiskModule} can have.
   */
  enum ComponentStatus {
    /**
     * @dev inactive status = 0 means the component doesn't exists - All operations rejected
     */
    inactive,
    /**
     * @dev active means the component is fully functional, all the component operations are allowed.
     *      deposit / withdraw for eTokens
     *      newPolicy / resolvePolicy for riskModules
     *      policyCreated / policyExpired / policyResolvedWithPayout for premiumsAccount
     */
    active,
    /**
     * @dev deprecated means the component is in process of being deactivated. Only some operations are allowed:
     *      withdraw for eTokens
     *      resolvePolicy / expirePolicy for riskModules
     *      policyExpired / policyResolvedWithPayout for premiumsAccount
     */
    deprecated,
    /**
     * @dev suspended means the component is temporarily deactivated. All the operations are rejected. Only GUARDIAN
     *      can suspend.
     */
    suspended
  }

  /**
   * @dev Enum of the different kind of top level components that can be plugged into the pool. Each one corresponds
   * with the {EToken}, {RiskModule} and {PremiumsAccount} respectively.
   */
  enum ComponentKind {
    unknown,
    eToken,
    riskModule,
    premiumsAccount
  }

  /**
   * @dev Struct to keep the state and type of the components installed. The `kind` never changes. The `status`
   * initially is `active` and can be changes with {PolicyPool-changeComponentStatus} and {PolicyPool-removeComponent}.
   */
  struct Component {
    ComponentStatus status;
    ComponentKind kind;
  }

  /**
   * @dev Mapping of installed components (see {EToken}, {RiskModule}, {PremiumsAccount}) in the PolicyPool.
   */
  mapping(IPolicyPoolComponent => Component) private _components;

  /**
   * @dev Mapping that stores the active policies (the policyId is the key). It just saves the hash of the policies,
   * the full {Policy-PolicyData} struct has to be sent for each operation (hash is used to verify).
   */
  mapping(uint256 => bytes32) internal _policies;

  /**
   * @dev Base URI for the minted policy NFTs.
   */
  string internal _nftBaseURI;

  /**
   * @dev Constructor error when address(0) is sent as `access()`
   */
  error NoZeroAccess();

  /**
   * @dev Constructor error when address(0) is sent as `currency()`
   */
  error NoZeroCurrency();

  /**
   * @dev Constructor error (or setTreasury) when address(0) is sent as `treasury()`
   */
  error NoZeroTreasury();

  /**
   * @dev Initialization error when empty name for the ERC721 is sent
   */
  error NoEmptyName();

  /**
   * @dev Initialization error when empty symbol for the ERC721 is sent
   */
  error NoEmptySymbol();

  /**
   * @dev Upgrade error when the new implementation contract tries to change the `access()`
   */
  error UpgradeCannotChangeAccess();

  /**
   * @dev Upgrade error when the new implementation contract tries to change the `currency()`
   */
  error UpgradeCannotChangeCurrency();

  /**
   * @dev Error when trying to add a component that was already added to the PolicyPool
   */
  error ComponentAlreadyInThePool();

  /**
   * @dev Error when trying to add a component that isn't linked to this pool (`.policyPool() != this`)
   */
  error ComponentNotLinkedToThisPool();

  /**
   * @dev Error when a component is not of the right kind, it might happen if a component declared as
   *      ComponentKind.eToken doesn't support the IEToken interface (or similar) or when in a given operation
   *      we expect a component to be a risk module and the stored kind is different.
   */
  error ComponentNotTheRightKind(IPolicyPoolComponent component, ComponentKind expectedKind);

  /**
   * @dev Error when a component is expected to be deprecated for the operation (see `removeComponent`) and it isn't.
   */
  error ComponentNotDeprecated();

  /**
   * @dev Error when trying to remove a component that is still in use. The "in use" definition can change from one
   *      component to the other. For eToken in use means `totalSupply() != 0`. For PremiumsAccount means
   *      `purePremiums() != 0`. For RiskModule means `activeExposure() != 0`.
   */
  error ComponentInUseCannotRemove(ComponentKind kind, uint256 amount);

  /**
   * @dev Error when a component is not found in the pool (status = 0 = inactive)
   */
  error ComponentNotFound();

  /**
   * @dev Error when a component is not found in the pool or is not active (status != active)
   */
  error ComponentNotFoundOrNotActive();

  /**
   * @dev Error when a component is not active or deprecated. Happens on some operations like eToken withdrawals or
   *      policy resolutions that accept the component might be active or deprecated and isn't on any of those states.
   */
  error ComponentMustBeActiveOrDeprecated();

  /**
   * @dev Error when a method intented to be called by riskModule (and by policy's risk module) is called by someone
   *      else.
   */
  error OnlyRiskModuleAllowed();

  /**
   * @dev Error raised when IPolicyHolder doesn't return the expected selector answer when notified of policy payout,
   *      reception or replacement.
   */
  error InvalidNotificationResponse(bytes4 response);

  /**
   * @dev Event emitted when the treasury changes
   *
   * @param action The type of governance action (setTreasury or setBaseURI for now)
   * @param value  The address of the new treasury or the address of the caller (for setBaseURI)
   */
  event ComponentChanged(IAccessManager.GovernanceActions indexed action, address value);

  /**
   * @dev Event emitted when a new component added/removed to the pool or the status changes.
   *
   * @param component The address of the component, it can be an {EToken}, {RiskModule} or {PremiumsAccount}
   * @param kind Value indicating the kind of component. See {ComponentKind}
   * @param newStatus The status of the component after the operation. See {ComponentStatus}
   */
  event ComponentStatusChanged(IPolicyPoolComponent indexed component, ComponentKind kind, ComponentStatus newStatus);

  /**
   * @dev Event emitted when a IPolicyHolder reverts on the expiration notification. The operation doesn't reverts
   *
   * @param policyId The id of the policy being expired
   * @param holder The address of the contract that owns the policy
   */
  event ExpirationNotificationFailed(uint256 indexed policyId, IPolicyHolder holder);
  /**
   * @dev Modifier that checks the caller has a given role
   */
  modifier onlyRole(bytes32 role) {
    _access.checkRole(role, _msgSender());
    _;
  }

  /**
   * @dev Modifier that checks the caller has any of the given roles
   */
  modifier onlyRole2(bytes32 role1, bytes32 role2) {
    _access.checkRole2(role1, role2, _msgSender());
    _;
  }

  /**
   * @dev Instantiates a Policy Pool. Sets immutable fields.
   *
   * @param access_ The address of the {AccessManager} that manages the access permissions for the pool governance
   * operations.
   * @param currency_ The {ERC20} token that's used as a currency in the protocol. Usually a stablecoin such as USDC.
   */
  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor(IAccessManager access_, IERC20Metadata currency_) {
    if (address(access_) == address(0)) revert NoZeroAccess();
    if (address(currency_) == address(0)) revert NoZeroCurrency();
    _disableInitializers();
    _access = access_;
    _currency = currency_;
  }

  /**
   * @dev Initializes a Policy Pool
   *
   * @param name_ The name of the ERC721 token.
   * @param symbol_ The symbol of the ERC721 token.
   * @param treasury_ The address of the treasury that will receive the protocol fees.
   */
  function initialize(string memory name_, string memory symbol_, address treasury_) public initializer {
    if (bytes(name_).length == 0) revert NoEmptyName();
    if (bytes(symbol_).length == 0) revert NoEmptySymbol();
    __UUPSUpgradeable_init();
    __ERC721_init(name_, symbol_);
    __Pausable_init();
    __PolicyPool_init_unchained(treasury_);
  }

  /**
   * @dev See {IERC165-supportsInterface}.
   */
  function supportsInterface(bytes4 interfaceId) public view virtual override returns (bool) {
    return super.supportsInterface(interfaceId) || interfaceId == type(IPolicyPool).interfaceId;
  }

  // solhint-disable-next-line func-name-mixedcase
  function __PolicyPool_init_unchained(address treasury_) internal onlyInitializing {
    _setTreasury(treasury_);
  }

  function _authorizeUpgrade(address newImpl) internal view override onlyRole2(GUARDIAN_ROLE, LEVEL1_ROLE) {
    IPolicyPool newPool = IPolicyPool(newImpl);
    if (newPool.access() != _access) revert UpgradeCannotChangeAccess();
    if (newPool.currency() != _currency) revert UpgradeCannotChangeCurrency();
  }

  /**
   * @dev Pauses the contract. When the contract is paused, several operations are rejected: deposits, withdrawals, new
   * policies, policy resolution and expiration, nft transfers.
   *
   * Requirements:
   * - Must be executed by a user with the {GUARDIAN_ROLE}.
   */
  function pause() public onlyRole(GUARDIAN_ROLE) {
    _pause();
  }

  /**
   * @dev Unpauses the contract. All the operations disabled when the contract was paused are re-enabled.
   *
   * Requirements:
   * - Must be called by a user with either the {GUARDIAN_ROLE} or a {LEVEL1_ROLE}.
   */
  function unpause() public onlyRole2(GUARDIAN_ROLE, LEVEL1_ROLE) {
    _unpause();
  }

  function access() external view virtual override returns (IAccessManager) {
    return _access;
  }

  function currency() external view virtual override returns (IERC20Metadata) {
    return _currency;
  }

  function _setTreasury(address treasury_) internal {
    if (treasury_ == address(0)) revert NoZeroTreasury();
    _treasury = treasury_;
    emit ComponentChanged(IAccessManager.GovernanceActions.setTreasury, _treasury);
  }

  /**
   * @dev Changes the address of the treasury, the one that receives the protocol fees.
   *
   * Requirements:
   * - Must be called by a user with the {LEVEL1_ROLE}.
   *
   * Events:
   * - Emits {ComponentChanged} with action = setTreasury and the address of the new treasury.
   */
  function setTreasury(address treasury_) external onlyRole(LEVEL1_ROLE) {
    _setTreasury(treasury_);
  }

  /**
   * @dev Returns the address of the treasury, the one that receives the protocol fees.
   */
  function treasury() external view override returns (address) {
    return _treasury;
  }

  /**
   * @dev Adds a new component (either an {EToken}, {RiskModule} or {PremiumsAccount}) to the protocol. The component
   * status will be `active`.
   *
   * Requirements:
   * - Must be called by a user with the {LEVEL1_ROLE}
   * - The component wasn't added before.
   *
   * Events:
   * - Emits {ComponentStatusChanged} with status active.
   *
   * @param component The address of component contract. Must be an {EToken}, {RiskModule} or {PremiumsAccount} linked
   * to this specific {PolicyPool} and matching the `kind` specified in the next paramter.
   * @param kind The type of component to be added.
   */
  function addComponent(IPolicyPoolComponent component, ComponentKind kind) external onlyRole(LEVEL1_ROLE) {
    Component storage comp = _components[component];
    if (comp.status != ComponentStatus.inactive) revert ComponentAlreadyInThePool();
    if (component.policyPool() != this) revert ComponentNotLinkedToThisPool();

    if (
      (kind == ComponentKind.eToken && !component.supportsInterface(type(IEToken).interfaceId)) ||
      (kind == ComponentKind.premiumsAccount && !component.supportsInterface(type(IPremiumsAccount).interfaceId)) ||
      (kind == ComponentKind.riskModule && !component.supportsInterface(type(IRiskModule).interfaceId))
    ) revert ComponentNotTheRightKind(component, kind);

    comp.status = ComponentStatus.active;
    comp.kind = kind;
    if (kind == ComponentKind.premiumsAccount) {
      IPremiumsAccount pa = IPremiumsAccount(address(component));
      IEToken etk = pa.juniorEtk();
      if (address(etk) != address(0)) {
        etk.addBorrower(address(pa));
      }
      etk = pa.seniorEtk();
      if (address(etk) != address(0)) {
        etk.addBorrower(address(pa));
      }
    }
    emit ComponentStatusChanged(component, kind, ComponentStatus.active);
  }

  /**
   * @dev Removes a component from the protocol. The component needs to be in `deprecated` status before doing this
   * operation.
   *
   * Requirements:
   * - Must be called by a user with the {LEVEL1_ROLE}
   * - The component status is `deprecated`.
   *
   * Events:
   * - Emits {ComponentStatusChanged} with status inactive.
   *
   * @param component The address of component contract. Must be a component added before.
   */
  function removeComponent(IPolicyPoolComponent component) external onlyRole(LEVEL1_ROLE) {
    Component storage comp = _components[component];
    if (comp.status != ComponentStatus.deprecated) revert ComponentNotDeprecated();
    if (comp.kind == ComponentKind.eToken) {
      if (IEToken(address(component)).totalSupply() != 0)
        revert ComponentInUseCannotRemove(comp.kind, IEToken(address(component)).totalSupply());
    } else if (comp.kind == ComponentKind.riskModule) {
      if (IRiskModule(address(component)).activeExposure() != 0)
        revert ComponentInUseCannotRemove(comp.kind, IRiskModule(address(component)).activeExposure());
    } else if (comp.kind == ComponentKind.premiumsAccount) {
      IPremiumsAccount pa = IPremiumsAccount(address(component));
      if (pa.purePremiums() != 0) revert ComponentInUseCannotRemove(comp.kind, pa.purePremiums());
      IEToken etk = pa.juniorEtk();
      if (address(etk) != address(0)) {
        etk.removeBorrower(address(pa));
      }
      etk = pa.seniorEtk();
      if (address(etk) != address(0)) {
        etk.removeBorrower(address(pa));
      }
    }
    emit ComponentStatusChanged(component, comp.kind, ComponentStatus.inactive);
    delete _components[component];
  }

  /**
   * @dev Changes the status of a component.
   *
   * Requirements:
   * - Must be called by a user with the {LEVEL1_ROLE} if the new status is `active` or `deprecated`.
   * - Must be called by a user with the {GUARDIAN_ROLE} if the new status is `suspended`.
   *
   * Events:
   * - Emits {ComponentStatusChanged} with the new status.
   *
   * @param component The address of component contract. Must be a component added before.
   * @param newStatus The new status, must be either `active`, `deprecated` or `suspended`.
   */
  function changeComponentStatus(
    IPolicyPoolComponent component,
    ComponentStatus newStatus
  ) external onlyRole2(GUARDIAN_ROLE, LEVEL1_ROLE) {
    Component storage comp = _components[component];
    if (comp.status == ComponentStatus.inactive) revert ComponentNotFound();
    if (newStatus == ComponentStatus.active || newStatus == ComponentStatus.deprecated) {
      _access.checkRole(LEVEL1_ROLE, _msgSender());
    } else {
      // ComponentStatus.suspended requires GUARDIAN_ROLE
      _access.checkRole(GUARDIAN_ROLE, _msgSender());
    }
    comp.status = newStatus;
    emit ComponentStatusChanged(component, comp.kind, newStatus);
  }

  /**
   * @dev Returns the status of a component.
   *
   * @param component The address of the component
   * @return The status of the component. See {ComponentStatus}
   */
  function getComponentStatus(IPolicyPoolComponent component) external view returns (ComponentStatus) {
    return _components[component].status;
  }

  function _componentStatus(address component, ComponentKind kind) internal view returns (ComponentStatus) {
    Component storage comp = _components[IPolicyPoolComponent(component)];
    if (comp.kind != kind) revert ComponentNotTheRightKind(IPolicyPoolComponent(component), kind);
    return comp.status;
  }

  function _requireCompActive(address component, ComponentKind kind) internal view {
    if (_componentStatus(component, kind) != ComponentStatus.active) revert ComponentNotFoundOrNotActive();
  }

  function _requireCompActiveOrDeprecated(address component, ComponentKind kind) internal view {
    ComponentStatus status = _componentStatus(component, kind);
    if (status != ComponentStatus.active && status != ComponentStatus.deprecated)
      revert ComponentMustBeActiveOrDeprecated();
  }

  function deposit(IEToken eToken, uint256 amount) external override whenNotPaused {
    _requireCompActive(address(eToken), ComponentKind.eToken);
    uint256 balanceBefore = _currency.balanceOf(address(eToken));
    _currency.safeTransferFrom(_msgSender(), address(eToken), amount);
    eToken.deposit(_msgSender(), _currency.balanceOf(address(eToken)) - balanceBefore);
  }

  function withdraw(IEToken eToken, uint256 amount) external override whenNotPaused returns (uint256) {
    _requireCompActiveOrDeprecated(address(eToken), ComponentKind.eToken);
    return eToken.withdraw(_msgSender(), amount);
  }

  function newPolicy(
    Policy.PolicyData memory policy,
    address payer,
    address policyHolder,
    uint96 internalId
  ) external override whenNotPaused returns (uint256) {
    // Checks
    IRiskModule rm = policy.riskModule;
    if (address(rm) != _msgSender()) revert OnlyRiskModuleAllowed();
    _requireCompActive(address(rm), ComponentKind.riskModule);
    IPremiumsAccount pa = rm.premiumsAccount();
    _requireCompActive(address(pa), ComponentKind.premiumsAccount);

    // Effects
    policy.id = makePolicyId(rm, internalId);
    require(_policies[policy.id] == bytes32(0), "Policy already exists");
    _policies[policy.id] = policy.hash();
    _safeMint(policyHolder, policy.id, "");

    // Interactions
    pa.policyCreated(policy);

    // Distribute the premium
    _currency.safeTransferFrom(payer, address(pa), policy.purePremium);
    if (policy.srCoc > 0) _currency.safeTransferFrom(payer, address(pa.seniorEtk()), policy.srCoc);
    if (policy.jrCoc > 0) _currency.safeTransferFrom(payer, address(pa.juniorEtk()), policy.jrCoc);
    _currency.safeTransferFrom(payer, _treasury, policy.ensuroCommission);
    if (policy.partnerCommission > 0 && payer != rm.wallet())
      _currency.safeTransferFrom(payer, rm.wallet(), policy.partnerCommission);
    /**
     * This code does up to 5 ERC20 transfers. This can be avoided to reduce the gas cost, by implementing delayed
     * transfers. This might be considered in the future, but to avoid increasing the complexity and since so far we
     * operate on low gas-cost blockchains, we keep it as it is.
     */

    emit NewPolicy(rm, policy);
    return policy.id;
  }

  function replacePolicy(
    Policy.PolicyData memory oldPolicy,
    Policy.PolicyData memory newPolicy_,
    address payer,
    uint96 internalId
  ) external override whenNotPaused returns (uint256) {
    // Checks
    _validatePolicy(oldPolicy);
    IRiskModule rm = oldPolicy.riskModule;
    if (address(rm) != _msgSender()) revert OnlyRiskModuleAllowed();
    _requireCompActive(address(rm), ComponentKind.riskModule);
    IPremiumsAccount pa = rm.premiumsAccount();
    _requireCompActive(address(pa), ComponentKind.premiumsAccount);
    require(oldPolicy.expiration > uint40(block.timestamp), "Old policy is expired");
    require(oldPolicy.start == newPolicy_.start, "Both policies must have the same starting date");
    require(
      oldPolicy.payout <= newPolicy_.payout &&
        oldPolicy.purePremium <= newPolicy_.purePremium &&
        oldPolicy.ensuroCommission <= newPolicy_.ensuroCommission &&
        oldPolicy.jrCoc <= newPolicy_.jrCoc &&
        oldPolicy.srCoc <= newPolicy_.srCoc &&
        oldPolicy.jrScr <= newPolicy_.jrScr &&
        oldPolicy.srScr <= newPolicy_.srScr &&
        oldPolicy.partnerCommission <= newPolicy_.partnerCommission &&
        oldPolicy.expiration <= newPolicy_.expiration &&
        rm == newPolicy_.riskModule,
      "New policy must be greater or equal than old policy"
    );

    // Effects
    newPolicy_.id = makePolicyId(rm, internalId);
    require(_policies[newPolicy_.id] == bytes32(0), "Policy already exists");
    _policies[newPolicy_.id] = newPolicy_.hash();
    address policyHolder = ownerOf(oldPolicy.id);
    _safeMint(policyHolder, newPolicy_.id, "");
    delete _policies[oldPolicy.id];

    // Interactions
    pa.policyReplaced(oldPolicy, newPolicy_);

    // Distribute the premium
    uint256 aux = newPolicy_.purePremium - oldPolicy.purePremium;
    if (aux > 0) _currency.safeTransferFrom(payer, address(pa), aux);
    aux = newPolicy_.srCoc - oldPolicy.srCoc;
    if (aux > 0) _currency.safeTransferFrom(payer, address(pa.seniorEtk()), aux);
    aux = newPolicy_.jrCoc - oldPolicy.jrCoc;
    if (aux > 0) _currency.safeTransferFrom(payer, address(pa.juniorEtk()), aux);
    aux = newPolicy_.ensuroCommission - oldPolicy.ensuroCommission;
    if (aux > 0) _currency.safeTransferFrom(payer, _treasury, aux);
    aux = newPolicy_.partnerCommission - oldPolicy.partnerCommission;
    if (aux > 0 && payer != rm.wallet()) _currency.safeTransferFrom(payer, rm.wallet(), aux);
    /**
     * This code does up to 5 ERC20 transfers. This can be avoided to reduce the gas cost, by implementing delayed
     * transfers. This might be considered in the future, but to avoid increasing the complexity and since so far we
     * operate on low gas-cost blockchains, we keep it as it is.
     */

    emit NewPolicy(rm, newPolicy_);
    emit PolicyReplaced(rm, oldPolicy.id, newPolicy_.id);
    _notifyReplacement(oldPolicy.id, newPolicy_.id);
    return newPolicy_.id;
  }

  function _validatePolicy(Policy.PolicyData memory policy) internal view {
    require(policy.id != 0 && policy.hash() == _policies[policy.id], "Policy not found");
  }

  function makePolicyId(IRiskModule rm, uint96 internalId) public pure returns (uint256) {
    return (uint256(uint160(address(rm))) << 96) + internalId;
  }

  function expirePolicy(Policy.PolicyData calldata policy) external override whenNotPaused {
    require(policy.expiration <= block.timestamp, "Policy not expired yet");
    return _resolvePolicy(policy, 0, true);
  }

  function expirePolicies(Policy.PolicyData[] calldata policies) external whenNotPaused {
    for (uint256 i = 0; i < policies.length; i++) {
      require(policies[i].expiration <= block.timestamp, "Policy not expired yet");
      _resolvePolicy(policies[i], 0, true);
    }
  }

  function resolvePolicy(Policy.PolicyData calldata policy, uint256 payout) external override whenNotPaused {
    return _resolvePolicy(policy, payout, false);
  }

  function resolvePolicyFullPayout(
    Policy.PolicyData calldata policy,
    bool customerWon
  ) external override whenNotPaused {
    return _resolvePolicy(policy, customerWon ? policy.payout : 0, false);
  }

  function isActive(uint256 policyId) external view override returns (bool) {
    return _policies[policyId] != bytes32(0);
  }

  function getPolicyHash(uint256 policyId) external view override returns (bytes32) {
    return _policies[policyId];
  }

  /**
   * @dev Internal function that handles the different alternative resolutions for a policy, with or without payout and
   * expiration.
   *
   * Events:
   * - Emits {PolicyResolved} with the payout
   *
   * @param policy A policy created with {Policy-initialize}
   * @param payout The amount to paid to the policyholder
   * @param expired True for expiration resolution (`payout` must be 0)
   */
  function _resolvePolicy(Policy.PolicyData memory policy, uint256 payout, bool expired) internal {
    // Checks
    _validatePolicy(policy);
    IRiskModule rm = policy.riskModule;
    if (!expired && address(rm) != _msgSender()) revert OnlyRiskModuleAllowed();
    require(payout == 0 || policy.expiration > block.timestamp, "Can't pay expired policy");
    _requireCompActiveOrDeprecated(address(rm), ComponentKind.riskModule);

    require(payout <= policy.payout, "payout > policy.payout");

    bool customerWon = payout > 0;

    IPremiumsAccount pa = rm.premiumsAccount();
    _requireCompActiveOrDeprecated(address(pa), ComponentKind.premiumsAccount);
    // Effects
    delete _policies[policy.id];
    // Interactions
    if (customerWon) {
      address policyOwner = ownerOf(policy.id);
      pa.policyResolvedWithPayout(policyOwner, policy, payout);
    } else {
      pa.policyExpired(policy);
    }

    rm.releaseExposure(policy.payout);

    emit PolicyResolved(policy.riskModule, policy.id, payout);
    if (payout > 0) {
      _notifyPayout(policy.id, payout);
    } else {
      _notifyExpiration(policy.id);
    }
  }

  /**
   * @dev Notifies the payout with a callback if the policyholder is a contract and implementes the IPolicyHolder interface.
   * Only reverts if the policyholder contract explicitly reverts or it doesn't return the IPolicyHolder.onPayoutReceived selector.
   */
  function _notifyPayout(uint256 policyId, uint256 payout) internal {
    address customer = ownerOf(policyId);
    if (!AddressUpgradeable.isContract(customer)) return;
    if (!ERC165Checker.supportsInterface(customer, type(IPolicyHolder).interfaceId)) return;

    bytes4 retval = IPolicyHolder(customer).onPayoutReceived(_msgSender(), address(this), policyId, payout);
    if (retval != IPolicyHolder.onPayoutReceived.selector) revert InvalidNotificationResponse(retval);
  }

  /**
   * @dev Notifies the expiration with a callback if the policyholder is a contract. Never reverts.
   */
  function _notifyExpiration(uint256 policyId) internal {
    address customer = ownerOf(policyId);
    if (!AddressUpgradeable.isContract(customer)) return;
    if (!ERC165Checker.supportsInterface(customer, type(IPolicyHolder).interfaceId)) return;

    try IPolicyHolder(customer).onPolicyExpired{gas: HOLDER_GAS_LIMIT}(_msgSender(), address(this), policyId) returns (
      bytes4
    ) {
      return;
    } catch {
      emit ExpirationNotificationFailed(policyId, IPolicyHolder(customer));
      return;
    }
  }

  /**
   * @dev Notifies the replacement with a callback if the policyholder is a contract. Never reverts.
   */
  function _notifyReplacement(uint256 oldPolicyId, uint256 newPolicyId) internal {
    address customer = ownerOf(oldPolicyId);
    if (!AddressUpgradeable.isContract(customer)) return;
    if (!ERC165Checker.supportsInterface(customer, type(IPolicyHolderV2).interfaceId)) return;

    bytes4 retval = IPolicyHolderV2(customer).onPolicyReplaced(_msgSender(), address(this), oldPolicyId, newPolicyId);
    // PolicyHolder can revert and cancel the policy replacement
    if (retval != IPolicyHolderV2.onPolicyReplaced.selector) revert InvalidNotificationResponse(retval);
  }

  /**
   * @dev Base URI for computing {tokenURI}. If set, the resulting URI for each
   * token will be the concatenation of the `baseURI` and the `tokenId`. Empty
   * by default, can be modified calling {setBaseURI}.
   */
  function _baseURI() internal view virtual override returns (string memory) {
    return _nftBaseURI;
  }

  /**
   * @dev Changes the baseURI of the minted policy NFTs
   *
   * Requirements:
   * - Must be called by a user with the {LEVEL2_ROLE}.
   *
   * Events:
   * - Emits {ComponentChanged} with action = setBaseURI and the address of the caller.
   */
  function setBaseURI(string memory nftBaseURI_) external onlyRole(LEVEL2_ROLE) {
    _nftBaseURI = nftBaseURI_;
    emit ComponentChanged(IAccessManager.GovernanceActions.setBaseURI, _msgSender());
  }

  function _beforeTokenTransfer(
    address from,
    address to,
    uint256 tokenId,
    uint256 batchSize
  ) internal override whenNotPaused {
    super._beforeTokenTransfer(from, to, tokenId, batchSize);
  }

  /**
   * @dev This empty reserved space is put in place to allow future versions to add new
   * variables without shifting down storage in the inheritance chain.
   * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
   */
  uint256[46] private __gap;
}
