// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {ERC165Checker} from "@openzeppelin/contracts/utils/introspection/ERC165Checker.sol";
import {ERC721Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import {IEToken} from "./interfaces/IEToken.sol";
import {IPolicyHolder} from "./interfaces/IPolicyHolder.sol";
import {IPolicyPool} from "./interfaces/IPolicyPool.sol";
import {IPolicyPoolComponent} from "./interfaces/IPolicyPoolComponent.sol";
import {IPremiumsAccount} from "./interfaces/IPremiumsAccount.sol";
import {IRiskModule} from "./interfaces/IRiskModule.sol";
import {Policy} from "./Policy.sol";

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
  using Policy for Policy.PolicyData;
  using SafeERC20 for IERC20Metadata;
  using SafeCast for uint256;

  uint256 internal constant HOLDER_GAS_LIMIT = 150000;

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
  mapping(IPolicyPoolComponent => Component) internal _components;

  /**
   * @dev Mapping that stores the active policies (the policyId is the key). It just saves the hash of the policies,
   * the full {Policy-PolicyData} struct has to be sent for each operation (hash is used to verify).
   */
  mapping(uint256 => bytes32) internal _policies;

  struct Exposure {
    uint128 active;
    uint128 limit;
  }

  /**
   * @dev Base URI for the minted policy NFTs.
   */
  string internal _nftBaseURI;

  /**
   * @dev Mapping of current exposures and limits for each risk module.
   */
  mapping(IRiskModule => Exposure) internal _exposureByRm;

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

  error PolicyAlreadyExists(uint256 policyId);
  error PolicyAlreadyExpired(uint256 policyId);
  error PolicyNotFound(uint256 policyId);
  error PolicyNotExpired(uint256 policyId, uint40 expiration, uint256 now);
  error InvalidPolicyReplacement(Policy.PolicyData oldPolicy, Policy.PolicyData newPolicy);
  error InvalidPolicyCancellation(
    Policy.PolicyData oldPolicy,
    uint256 purePremiumRefund,
    uint256 jrCocRefund,
    uint256 srCocRefund
  );
  error PayoutExceedsLimit(uint256 payout, uint256 policyPayout);
  error ExposureLimitExceeded(uint128 activeExposure, uint128 exposureLimit);
  error InvalidReceiver(address receiver);

  /**
   * @dev Event emitted when the treasury (who receives ensuroCommission) changes
   *
   * @param oldTreasury The address of the treasury before the change
   * @param newTreasury  The address of the treasury after the change
   */
  event TreasuryChanged(address oldTreasury, address newTreasury);

  /**
   * @dev Event emitted when the baseURI (for policy NFTs) changes
   *
   * @param oldBaseURI The baseURI before the change
   * @param newBaseURI The baseURI after the change
   */
  event BaseURIChanged(string oldBaseURI, string newBaseURI);

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
   * @dev Event emitted when the exposure limit for a given risk module is changed
   *
   * @param riskModule The risk module whose limit will be changed
   * @param oldLimit Exposure limit before the change
   * @param newLimit Exposure limit after the change
   */
  event ExposureLimitChanged(IRiskModule indexed riskModule, uint128 oldLimit, uint128 newLimit);

  /**
   * @dev Event emitted for every deposit into an eToken
   *
   * @param eToken The eToken receiving the funds
   * @param sender The sender of the funds (the user calling `deposit` or `depositWithPermit`)
   * @param owner The user that will receive the minted eTokens
   * @param amount Amount in `currency()` paid for the eTokens (equal to the amount of eTokens received)
   */
  event Deposit(IEToken indexed eToken, address indexed sender, address indexed owner, uint256 amount);

  /**
   * @dev Event emitted for every withdrawal from an eToken
   *
   * @param eToken The eToken where the withdrawal will be done
   * @param sender The user calling the withdraw method. Must be the owner or have spending approval from it.
   * @param receiver The user that receives the resulting funds (`currency()`)
   * @param owner The owner of the burned eTokens
   * @param amount Amount in `currency()` that will be received by `receiver`.
   */
  event Withdraw(
    IEToken indexed eToken,
    address indexed sender,
    address indexed receiver,
    address owner,
    uint256 amount
  );

  /**
   * @dev Instantiates a Policy Pool. Sets immutable fields.
   *
   * @param access_ The address of the {AccessManager} that manages the access permissions for the pool governance
   * operations.
   * @param currency_ The {ERC20} token that's used as a currency in the protocol. Usually a stablecoin such as USDC.
   */
  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor(IERC20Metadata currency_) {
    if (address(currency_) == address(0)) revert NoZeroCurrency();
    _disableInitializers();
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

  // solhint-disable-next-line no-empty-blocks
  function _authorizeUpgrade(address newImpl) internal view override {}

  /**
   * @dev Pauses the contract. When the contract is paused, several operations are rejected: deposits, withdrawals, new
   * policies, policy resolution and expiration, nft transfers.
   */
  function pause() public {
    _pause();
  }

  /**
   * @dev Unpauses the contract. All the operations disabled when the contract was paused are re-enabled.
   */
  function unpause() public {
    _unpause();
  }

  function currency() external view virtual override returns (IERC20Metadata) {
    return _currency;
  }

  function _setTreasury(address treasury_) internal {
    if (treasury_ == address(0)) revert NoZeroTreasury();
    emit TreasuryChanged(_treasury, treasury_);
    _treasury = treasury_;
  }

  /**
   * @dev Changes the address of the treasury, the one that receives the protocol fees.
   *
   * Events:
   * - Emits {TreasuryChanged}
   */
  function setTreasury(address treasury_) external {
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
   * Events:
   * - Emits {ComponentStatusChanged} with status active.
   *
   * @param component The address of component contract. Must be an {EToken}, {RiskModule} or {PremiumsAccount} linked
   * to this specific {PolicyPool} and matching the `kind` specified in the next paramter.
   * @param kind The type of component to be added.
   */
  function addComponent(IPolicyPoolComponent component, ComponentKind kind) external {
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
   * Events:
   * - Emits {ComponentStatusChanged} with status inactive.
   *
   * @param component The address of component contract. Must be a component added before.
   */
  function removeComponent(IPolicyPoolComponent component) external {
    Component storage comp = _components[component];
    if (comp.status != ComponentStatus.deprecated) revert ComponentNotDeprecated();
    if (comp.kind == ComponentKind.eToken) {
      if (IERC20Metadata(address(component)).totalSupply() != 0)
        revert ComponentInUseCannotRemove(comp.kind, IERC20Metadata(address(component)).totalSupply());
    } else if (comp.kind == ComponentKind.riskModule) {
      if (_exposureByRm[IRiskModule(address(component))].active != 0)
        revert ComponentInUseCannotRemove(comp.kind, _exposureByRm[IRiskModule(address(component))].active);
    } else {
      // (comp.kind == ComponentKind.premiumsAccount)
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
   * Events:
   * - Emits {ComponentStatusChanged} with the new status.
   *
   * @param component The address of component contract. Must be a component added before.
   * @param newStatus The new status, must be either `active`, `deprecated` or `suspended`.
   */
  function changeComponentStatus(IPolicyPoolComponent component, ComponentStatus newStatus) external {
    Component storage comp = _components[component];
    if (comp.status == ComponentStatus.inactive) revert ComponentNotFound();
    // TODO: re-add custom access checks?
    // Only LEVEL1_ROLE canCall if newStatus = active or deprecated
    // Only GUARDIAN_ROLE canCall if newStatus = suspended
    /*
    if (newStatus == ComponentStatus.active || newStatus == ComponentStatus.deprecated) {
      _access.checkRole(LEVEL1_ROLE, _msgSender());
    } else {
      // ComponentStatus.suspended requires GUARDIAN_ROLE
      _access.checkRole(GUARDIAN_ROLE, _msgSender());
    }
    */
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

  function _deposit(IEToken eToken, uint256 amount, address receiver) internal {
    require(receiver != address(0), InvalidReceiver(receiver));
    _requireCompActive(address(eToken), ComponentKind.eToken);
    _currency.safeTransferFrom(_msgSender(), address(eToken), amount);
    eToken.deposit(amount, _msgSender(), receiver);
    emit Deposit(eToken, _msgSender(), receiver, amount);
  }

  function deposit(IEToken eToken, uint256 amount, address receiver) external override whenNotPaused {
    _deposit(eToken, amount, receiver);
  }

  function depositWithPermit(
    IEToken eToken,
    uint256 amount,
    address receiver,
    uint256 deadline,
    uint8 v,
    bytes32 r,
    bytes32 s
  ) external override whenNotPaused {
    // solhint-disable-next-line no-empty-blocks
    try IERC20Permit(address(_currency)).permit(_msgSender(), address(this), amount, deadline, v, r, s) {} catch {}
    // Check https://github.com/OpenZeppelin/openzeppelin-contracts/blob/1cf13771092c83a060eaef0f8809493fb4c04eb1/contracts/token/ERC20/extensions/IERC20Permit.sol#L16
    // for explanation of this try/catch pattern
    _deposit(eToken, amount, receiver);
  }

  function withdraw(
    IEToken eToken,
    uint256 amount,
    address receiver,
    address owner
  ) external override whenNotPaused returns (uint256 amountWithdrawn) {
    require(receiver != address(0), InvalidReceiver(receiver));
    _requireCompActiveOrDeprecated(address(eToken), ComponentKind.eToken);
    amountWithdrawn = eToken.withdraw(amount, _msgSender(), owner, receiver);
    emit Withdraw(eToken, _msgSender(), receiver, owner, amountWithdrawn);
  }

  function newPolicy(
    Policy.PolicyData memory policy,
    address payer,
    address policyHolder,
    uint96 internalId
  ) external override whenNotPaused returns (uint256) {
    // Checks
    IRiskModule rm = IRiskModule(_msgSender());
    _requireCompActive(address(rm), ComponentKind.riskModule);
    IPremiumsAccount pa = rm.premiumsAccount();
    _requireCompActive(address(pa), ComponentKind.premiumsAccount);

    // Effects
    policy.id = makePolicyId(rm, internalId);
    policy.start = uint40(block.timestamp);
    require(_policies[policy.id] == bytes32(0), PolicyAlreadyExists(policy.id));
    _policies[policy.id] = policy.hash();
    _safeMint(policyHolder, policy.id, "");
    _changeExposure(rm, true, policy.payout);

    // Interactions
    pa.policyCreated(policy);

    // Distribute the premium
    _currency.safeTransferFrom(payer, address(pa), policy.purePremium);
    (IEToken jrEtk, IEToken srEtk) = pa.etks();
    if (policy.srCoc > 0) _currency.safeTransferFrom(payer, address(srEtk), policy.srCoc);
    if (policy.jrCoc > 0) _currency.safeTransferFrom(payer, address(jrEtk), policy.jrCoc);
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

  // solhint-disable-next-line function-max-lines
  function replacePolicy(
    Policy.PolicyData calldata oldPolicy,
    Policy.PolicyData memory newPolicy_,
    address payer,
    uint96 internalId
  ) external override whenNotPaused returns (uint256) {
    // Checks
    _validatePolicy(oldPolicy);
    IRiskModule rm = IRiskModule(_msgSender());
    if (extractRiskModule(oldPolicy.id) != rm) revert OnlyRiskModuleAllowed();
    _requireCompActive(address(rm), ComponentKind.riskModule);
    IPremiumsAccount pa = rm.premiumsAccount();
    _requireCompActive(address(pa), ComponentKind.premiumsAccount);
    require(
      oldPolicy.expiration > uint40(block.timestamp) && newPolicy_.expiration >= uint40(block.timestamp),
      PolicyAlreadyExpired(oldPolicy.id)
    );
    require(
      oldPolicy.start == newPolicy_.start &&
        oldPolicy.purePremium <= newPolicy_.purePremium &&
        oldPolicy.ensuroCommission <= newPolicy_.ensuroCommission &&
        oldPolicy.jrCoc <= newPolicy_.jrCoc &&
        oldPolicy.srCoc <= newPolicy_.srCoc &&
        oldPolicy.partnerCommission <= newPolicy_.partnerCommission,
      InvalidPolicyReplacement(oldPolicy, newPolicy_)
    );
    /**
     * payout, jrScr, srScr, expiration can change in any direction
     */

    // Effects
    newPolicy_.id = makePolicyId(rm, internalId);
    require(_policies[newPolicy_.id] == bytes32(0), PolicyAlreadyExists(newPolicy_.id));
    _policies[newPolicy_.id] = newPolicy_.hash();
    address policyHolder = ownerOf(oldPolicy.id);
    _safeMint(policyHolder, newPolicy_.id, "");
    if (newPolicy_.payout > oldPolicy.payout) _changeExposure(rm, true, newPolicy_.payout - oldPolicy.payout);
    else _changeExposure(rm, false, oldPolicy.payout - newPolicy_.payout);
    delete _policies[oldPolicy.id];

    // Interactions
    pa.policyReplaced(oldPolicy, newPolicy_);

    // Distribute the premium
    _transferIfNonZero(payer, address(pa), newPolicy_.purePremium, oldPolicy.purePremium);
    (IEToken jrEtk, IEToken srEtk) = pa.etks();
    _transferIfNonZero(payer, address(srEtk), newPolicy_.srCoc, oldPolicy.srCoc);
    _transferIfNonZero(payer, address(jrEtk), newPolicy_.jrCoc, oldPolicy.jrCoc);
    _transferIfNonZero(payer, _treasury, newPolicy_.ensuroCommission, oldPolicy.ensuroCommission);
    address rmWallet = rm.wallet();
    if (payer != rmWallet)
      _transferIfNonZero(payer, rmWallet, newPolicy_.partnerCommission, oldPolicy.partnerCommission);
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

  function cancelPolicy(
    Policy.PolicyData calldata policyToCancel,
    uint256 purePremiumRefund,
    uint256 jrCocRefund,
    uint256 srCocRefund
  ) external override whenNotPaused {
    // Checks
    _validatePolicy(policyToCancel);
    IRiskModule rm = IRiskModule(_msgSender());
    if (extractRiskModule(policyToCancel.id) != rm) revert OnlyRiskModuleAllowed();
    _requireCompActiveOrDeprecated(address(rm), ComponentKind.riskModule);
    IPremiumsAccount pa = rm.premiumsAccount();
    _requireCompActiveOrDeprecated(address(pa), ComponentKind.premiumsAccount);
    require(policyToCancel.expiration > uint40(block.timestamp), PolicyAlreadyExpired(policyToCancel.id));
    require(
      purePremiumRefund <= policyToCancel.purePremium &&
        jrCocRefund <= policyToCancel.jrCoc &&
        srCocRefund <= policyToCancel.srCoc,
      InvalidPolicyCancellation(policyToCancel, purePremiumRefund, jrCocRefund, srCocRefund)
    );

    // Effects
    address policyHolder = ownerOf(policyToCancel.id);
    _changeExposure(rm, false, policyToCancel.payout);
    delete _policies[policyToCancel.id];

    // Interactions
    pa.policyCancelled(policyToCancel, purePremiumRefund, jrCocRefund, srCocRefund, policyHolder);

    emit PolicyCancelled(rm, policyToCancel.id, purePremiumRefund, jrCocRefund, srCocRefund);
    _notifyCancellation(policyToCancel.id, purePremiumRefund, jrCocRefund, srCocRefund);
  }

  function _transferIfNonZero(address payer, address target, uint256 new_, uint256 old_) internal {
    uint256 aux = new_ - old_;
    if (aux != 0) {
      _currency.safeTransferFrom(payer, target, aux);
    }
  }

  function _validatePolicy(Policy.PolicyData memory policy) internal view {
    require(policy.id != 0 && policy.hash() == _policies[policy.id], PolicyNotFound(policy.id));
  }

  function makePolicyId(IRiskModule rm, uint96 internalId) public pure returns (uint256) {
    return (uint256(uint160(address(rm))) << 96) + internalId;
  }

  function extractRiskModule(uint256 policyId) public pure returns (IRiskModule) {
    return IRiskModule(address(uint160(policyId >> 96)));
  }

  function expirePolicy(Policy.PolicyData calldata policy) external override whenNotPaused {
    if (policy.expiration > block.timestamp) revert PolicyNotExpired(policy.id, policy.expiration, block.timestamp);
    return _resolvePolicy(policy, 0, true);
  }

  function expirePolicies(Policy.PolicyData[] calldata policies) external whenNotPaused {
    for (uint256 i = 0; i < policies.length; ++i) {
      if (policies[i].expiration > block.timestamp)
        revert PolicyNotExpired(policies[i].id, policies[i].expiration, block.timestamp);
      _resolvePolicy(policies[i], 0, true);
    }
  }

  function resolvePolicy(Policy.PolicyData calldata policy, uint256 payout) external override whenNotPaused {
    return _resolvePolicy(policy, payout, false);
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
    IRiskModule rm = extractRiskModule(policy.id);
    if (!expired && address(rm) != _msgSender()) revert OnlyRiskModuleAllowed();
    require(payout == 0 || policy.expiration > block.timestamp, PolicyAlreadyExpired(policy.id));
    _requireCompActiveOrDeprecated(address(rm), ComponentKind.riskModule);

    require(payout <= policy.payout, PayoutExceedsLimit(payout, policy.payout));

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

    _changeExposure(rm, false, policy.payout);

    emit PolicyResolved(rm, policy.id, payout);
    if (payout > 0) {
      _notifyPayout(policy.id, payout);
    } else {
      _notifyExpiration(policy.id);
    }
  }

  function _changeExposure(IRiskModule rm, bool increase, uint256 change) internal {
    Exposure storage exposure = _exposureByRm[rm];
    if (increase) {
      exposure.active += change.toUint128();
      require(exposure.active <= exposure.limit, ExposureLimitExceeded(exposure.active, exposure.limit));
    } else {
      exposure.active -= change.toUint128();
    }
  }

  function setExposureLimit(IRiskModule rm, uint256 newLimit) external {
    Exposure storage exposure = _exposureByRm[rm];
    uint128 newLimit128 = newLimit.toUint128();
    require(exposure.active < newLimit128, ExposureLimitExceeded(exposure.active, newLimit128));
    emit ExposureLimitChanged(rm, exposure.limit, newLimit128);
    exposure.limit = newLimit128;
  }

  function getExposure(IRiskModule rm) external view returns (uint256 active, uint256 limit) {
    Exposure storage exposure = _exposureByRm[rm];
    active = exposure.active;
    limit = exposure.limit;
  }

  /**
   * @dev Notifies the payout with a callback if the policyholder is a contract and implementes the IPolicyHolder interface.
   * Only reverts if the policyholder contract explicitly reverts or it doesn't return the IPolicyHolder.onPayoutReceived selector.
   */
  function _notifyPayout(uint256 policyId, uint256 payout) internal {
    address customer = ownerOf(policyId);
    if (!ERC165Checker.supportsInterface(customer, type(IPolicyHolder).interfaceId)) return;

    bytes4 retval = IPolicyHolder(customer).onPayoutReceived(_msgSender(), address(this), policyId, payout);
    if (retval != IPolicyHolder.onPayoutReceived.selector) revert InvalidNotificationResponse(retval);
  }

  /**
   * @dev Notifies the expiration with a callback if the policyholder is a contract. Never reverts.
   */
  function _notifyExpiration(uint256 policyId) internal {
    address customer = ownerOf(policyId);
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
    if (!ERC165Checker.supportsInterface(customer, type(IPolicyHolder).interfaceId)) return;

    bytes4 retval = IPolicyHolder(customer).onPolicyReplaced(_msgSender(), address(this), oldPolicyId, newPolicyId);
    // PolicyHolder can revert and cancel the policy replacement
    if (retval != IPolicyHolder.onPolicyReplaced.selector) revert InvalidNotificationResponse(retval);
  }

  /**
   * @dev Notifies the replacement with a callback if the policyholder is a contract. Never reverts.
   */
  function _notifyCancellation(
    uint256 cancelledPolicyId,
    uint256 purePremiumRefund,
    uint256 jrCocRefund,
    uint256 srCocRefund
  ) internal {
    address customer = ownerOf(cancelledPolicyId);
    if (!ERC165Checker.supportsInterface(customer, type(IPolicyHolder).interfaceId)) return;

    bytes4 retval = IPolicyHolder(customer).onPolicyCancelled(
      _msgSender(),
      address(this),
      cancelledPolicyId,
      purePremiumRefund,
      jrCocRefund,
      srCocRefund
    );
    // PolicyHolder can revert and cancel the policy replacement
    if (retval != IPolicyHolder.onPolicyCancelled.selector) revert InvalidNotificationResponse(retval);
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
   * Events:
   * - Emits {BaseURIChanged}
   */
  function setBaseURI(string calldata nftBaseURI_) external {
    emit BaseURIChanged(_nftBaseURI, nftBaseURI_);
    _nftBaseURI = nftBaseURI_;
  }

  function _update(address to, uint256 tokenId, address auth) internal override whenNotPaused returns (address) {
    return super._update(to, tokenId, auth);
  }

  /**
   * @dev This empty reserved space is put in place to allow future versions to add new
   * variables without shifting down storage in the inheritance chain.
   * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
   */
  uint256[45] private __gap;
}
