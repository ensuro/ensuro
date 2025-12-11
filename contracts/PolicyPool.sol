// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {ERC165Checker} from "@openzeppelin/contracts/utils/introspection/ERC165Checker.sol";
import {ERC721Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {MulticallUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/MulticallUpgradeable.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";

import {IEToken} from "./interfaces/IEToken.sol";
import {IPolicyHolder} from "./interfaces/IPolicyHolder.sol";
import {IPolicyPool} from "./interfaces/IPolicyPool.sol";
import {IPolicyPoolComponent} from "./interfaces/IPolicyPoolComponent.sol";
import {IPremiumsAccount} from "./interfaces/IPremiumsAccount.sol";
import {IRiskModule} from "./interfaces/IRiskModule.sol";
import {Policy} from "./Policy.sol";

/**
 * @title Ensuro PolicyPool contract
 * @notice This is the main contract of the protocol.
 * @dev There's a single instance of PolicyPool contract for a given deployment of the protocol.
 * It stores the registry of components (eTokens, PremiumsAccounts, and RiskModules). It also tracks the active
 * exposure and exposure limit per risk module.
 *
 * This is also the contract that receives and sends the underlying asset (currency, typically USDC).
 * The currency spending approvals should be done to this protocol for deposits or premium payments.
 *
 * This contract implements the ERC721 standard, because it mints and NFT for each policy created. The
 * property of the NFT represents the one that will receive the payout.
 *
 * The active policies are tracked in _policies as hashes, but for gas optimization we just store the hash
 * of the policy struct, and the struct needs to be stored off-chain and provided on every subsequent call.
 *
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
contract PolicyPool is IPolicyPool, PausableUpgradeable, UUPSUpgradeable, ERC721Upgradeable, MulticallUpgradeable {
  using Policy for Policy.PolicyData;
  using SafeERC20 for IERC20Metadata;
  using SafeCast for uint256;

  uint256 internal constant HOLDER_GAS_LIMIT = 150000;

  /**
   * @notice {ERC20} token used in PolicyPool as currency. Usually it will be a stablecoin such as USDC.
   */
  /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
  IERC20Metadata internal immutable _currency;

  /**
   * @notice Address of Ensuro's treasury that receives the protocol fees.
   */
  address internal _treasury; // address of Ensuro treasury

  /**
   * @notice Different statuses that a component ({PremiumsAccount}, {EToken} or {RiskModule} can have.
   */
  enum ComponentStatus {
    /**
     * @notice inactive status = 0 means the component doesn't exists - All operations rejected
     */
    inactive,
    /**
     * @notice active means the component is fully functional, all the component operations are allowed.
     *         deposit / withdraw for eTokens
     *         newPolicy / resolvePolicy for riskModules
     *         policyCreated / policyExpired / policyResolvedWithPayout for premiumsAccount
     */
    active,
    /**
     * @notice deprecated means the component is in process of being deactivated. Only some operations are allowed:
     *         withdraw for eTokens
     *         resolvePolicy / expirePolicy for riskModules
     *         policyExpired / policyResolvedWithPayout for premiumsAccount
     */
    deprecated,
    /**
     * @notice suspended means the component is temporarily deactivated. All the operations are rejected. Only GUARDIAN
     *         can suspend.
     */
    suspended
  }

  /**
   * @notice Enum of the different kind of top level components that can be plugged into the pool. Each one corresponds
   * with the {EToken}, {RiskModule} and {PremiumsAccount} respectively.
   */
  enum ComponentKind {
    unknown,
    eToken,
    riskModule,
    premiumsAccount
  }

  /**
   * @notice Struct to keep the state and type of the components installed
   * @dev The `kind` never changes. The `status` initially is `active` and can be changes with
   * {PolicyPool-changeComponentStatus} and {PolicyPool-removeComponent}.
   */
  struct Component {
    ComponentStatus status;
    ComponentKind kind;
  }

  /**
   * @notice Mapping of installed components (see {EToken}, {RiskModule}, {PremiumsAccount}) in the PolicyPool.
   */
  mapping(IPolicyPoolComponent => Component) internal _components;

  /**
   * @notice Mapping that stores the active policies (the policyId is the key).
   * @dev It just saves the hash of the policies, the full {Policy-PolicyData} struct has to be sent for each
   * operation (hash is used to verify).
   */
  mapping(uint256 => bytes32) internal _policies;

  struct Exposure {
    uint128 active;
    uint128 limit;
  }

  /**
   * @notice Base URI for the minted policy NFTs.
   */
  string internal _nftBaseURI;

  /**
   * @notice Mapping of current exposures and limits for each risk module.
   */
  mapping(IRiskModule => Exposure) internal _exposureByRm;

  /**
   * @notice Constructor error when address(0) is sent as `access()`
   */
  error NoZeroAccess();

  /**
   * @notice Constructor error when address(0) is sent as `currency()`
   */
  error NoZeroCurrency();

  /**
   * @notice Constructor error (or setTreasury) when address(0) is sent as `treasury()`
   */
  error NoZeroTreasury();

  /**
   * @notice Initialization error when empty name for the ERC721 is sent
   */
  error NoEmptyName();

  /**
   * @notice Initialization error when empty symbol for the ERC721 is sent
   */
  error NoEmptySymbol();

  /// @notice Thrown when trying to change the currency during an upgrade
  error UpgradeCannotChangeCurrency();

  /**
   * @notice Error when trying to add a component that was already added to the PolicyPool
   */
  error ComponentAlreadyInThePool();

  /**
   * @notice Error when trying to add a component that isn't linked to this pool (`.policyPool() != this`)
   */
  error ComponentNotLinkedToThisPool();

  /**
   * @notice Raised when a component is not of the right kind
   * @dev It might happen if a component declared as ComponentKind.eToken doesn't support the IEToken interface (or
   * similar) or when in a given operation we expect a component to be a risk module and the stored kind is different.
   */
  error ComponentNotTheRightKind(IPolicyPoolComponent component, ComponentKind expectedKind);

  /**
   * @notice Error when a component is not deprecated for the operation (see `removeComponent`), when it must.
   */
  error ComponentNotDeprecated();

  /**
   * @notice Error when trying to remove a component that is still in use.
   * @dev The "in use" definition can change from one component to the other. For eToken in use means
   * `totalSupply() != 0`. For PremiumsAccount means `purePremiums() != 0`. For RiskModule means
   * `activeExposure() != 0`.
   */
  error ComponentInUseCannotRemove(ComponentKind kind, uint256 amount);

  /**
   * @notice Error when a component is not found in the pool (status = 0 = inactive)
   */
  error ComponentNotFound();

  /**
   * @notice Error when a component is not found in the pool or is not active (status != active)
   */
  error ComponentNotFoundOrNotActive();

  /// @notice Thrown when attempting to set a component status to `inactive` via changeComponentStatus, use removeComponent() instead.
  error InvalidComponentStatus();

  /**
   * @notice Error when a component is not active or deprecated. Happens on some operations like eToken withdrawals or
   * policy resolutions that accept the component might be active or deprecated and isn't on any of those states.
   */
  error ComponentMustBeActiveOrDeprecated();

  /**
   * @notice Error when a method intented to be called by riskModule (and by policy's risk module) is called by
   * someone else.
   */
  error OnlyRiskModuleAllowed();

  /**
   * @notice Raised when IPolicyHolder doesn't return the expected selector answer when notified of policy payout,
   * replacement or cancellation.
   */
  error InvalidNotificationResponse(bytes4 response);

  /// @notice Thrown when attempting to create a policy with an ID that already exists
  error PolicyAlreadyExists(uint256 policyId);

  /// @notice Thrown when attempting to process an action (other than expiration) on a policy after its expiration date
  error PolicyAlreadyExpired(uint256 policyId);

  /// @notice Thrown when attempting to execute an action on a policy that does not exist (or was already expired)
  error PolicyNotFound(uint256 policyId);

  /**
   * @notice Thrown when attempting to expire a policy, but the policy is still active (policy.expiration >
   * block.timestamp)
   *
   * @param policyId The ID of the policy that is not yet expired
   * @param expiration The timestamp when the policy expires
   * @param now The current block timestamp
   */
  error PolicyNotExpired(uint256 policyId, uint40 expiration, uint256 now);

  /**
   * @notice Thrown when attempting to replace a policy with an invalid replacement
   * @dev This could occur if the policies have a different start, or if any of the premium components of the
   *      newPolicy are lower than the same component of the original policy.
   *
   * @param oldPolicy The original policy data
   * @param newPolicy The proposed replacement policy data
   */
  error InvalidPolicyReplacement(Policy.PolicyData oldPolicy, Policy.PolicyData newPolicy);

  /**
   * @notice Thrown when attempting to cancel a policy with invalid refunds
   * @dev The refunds amounts can never exceed the original premium components.
   *
   * @param policyToCancel The data of the policy being cancelled
   * @param purePremiumRefund The amount to refund from pure premium charged
   * @param jrCocRefund The amount to refund from jrCoc charged
   * @param srCocRefund The amount to refund from srCoc charged
   */
  error InvalidPolicyCancellation(
    Policy.PolicyData policyToCancel,
    uint256 purePremiumRefund,
    uint256 jrCocRefund,
    uint256 srCocRefund
  );

  /// @notice Thrown when a requested payout exceeds the policy's maximum payout limit
  error PayoutExceedsLimit(uint256 payout, uint256 policyPayout);

  /// @notice Thrown when an action would cause the active exposure to exceed the configured limit
  error ExposureLimitExceeded(uint128 activeExposure, uint128 exposureLimit);

  /// @notice Thrown when an invalid receiver address (address(0)) is provided as received of deposit or withdraw
  error InvalidReceiver(address receiver);

  /**
   * @notice Event emitted when the treasury (who receives ensuroCommission) changes
   *
   * @param oldTreasury The address of the treasury before the change
   * @param newTreasury  The address of the treasury after the change
   */
  event TreasuryChanged(address oldTreasury, address newTreasury);

  /**
   * @notice Event emitted when the baseURI (for policy NFTs) changes
   *
   * @param oldBaseURI The baseURI before the change
   * @param newBaseURI The baseURI after the change
   */
  event BaseURIChanged(string oldBaseURI, string newBaseURI);

  /**
   * @notice Event emitted when a new component added/removed to the pool or the status changes.
   *
   * @param component The address of the component, it can be an {EToken}, {RiskModule} or {PremiumsAccount}
   * @param kind Value indicating the kind of component. See {ComponentKind}
   * @param newStatus The status of the component after the operation. See {ComponentStatus}
   */
  event ComponentStatusChanged(IPolicyPoolComponent indexed component, ComponentKind kind, ComponentStatus newStatus);

  /**
   * @notice Event emitted when a IPolicyHolder reverts on the expiration notification. The operation doesn't reverts
   *
   * @param policyId The id of the policy being expired
   * @param holder The address of the contract that owns the policy
   */
  event ExpirationNotificationFailed(uint256 indexed policyId, IPolicyHolder holder);

  /**
   * @notice Event emitted when the exposure limit for a given risk module is changed
   *
   * @param riskModule The risk module whose limit will be changed
   * @param oldLimit Exposure limit before the change
   * @param newLimit Exposure limit after the change
   */
  event ExposureLimitChanged(IRiskModule indexed riskModule, uint128 oldLimit, uint128 newLimit);

  /**
   * @notice Event emitted for every deposit into an eToken
   *
   * @param eToken The eToken receiving the funds
   * @param sender The sender of the funds (the user calling `deposit` or `depositWithPermit`)
   * @param owner The user that will receive the minted eTokens
   * @param amount Amount in `currency()` paid for the eTokens (equal to the amount of eTokens received)
   */
  event Deposit(IEToken indexed eToken, address indexed sender, address indexed owner, uint256 amount);

  /**
   * @notice Event emitted for every withdrawal from an eToken
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
    __ERC721_init(name_, symbol_);
    __Pausable_init();
    __PolicyPool_init_unchained(treasury_);
  }

  /// @inheritdoc IERC165
  function supportsInterface(bytes4 interfaceId) public view virtual override returns (bool) {
    return super.supportsInterface(interfaceId) || interfaceId == type(IPolicyPool).interfaceId;
  }

  // solhint-disable-next-line func-name-mixedcase
  function __PolicyPool_init_unchained(address treasury_) internal onlyInitializing {
    _setTreasury(treasury_);
  }

  function _authorizeUpgrade(address newImpl) internal view override {
    IPolicyPool newPool = IPolicyPool(newImpl);
    if (newPool.currency() != _currency) revert UpgradeCannotChangeCurrency();
  }

  /**
   * @notice Pauses the contract.
   * @dev When the contract is paused, several operations are rejected: deposits, withdrawals, new
   * policies, policy resolution and expiration, nft transfers.
   */
  function pause() public {
    _pause();
  }

  /**
   * @notice Unpauses the contract.
   * @dev All the operations disabled when the contract was paused are re-enabled.
   */
  function unpause() public {
    _unpause();
  }

  /// @inheritdoc IPolicyPool
  function currency() external view virtual override returns (IERC20Metadata) {
    return _currency;
  }

  function _setTreasury(address treasury_) internal {
    if (treasury_ == address(0)) revert NoZeroTreasury();
    emit TreasuryChanged(_treasury, treasury_);
    _treasury = treasury_;
  }

  /**
   * @notice Changes the address of the treasury, the one that receives the protocol fees.
   *
   * @custom:emits TreasuryChanged with the previous and current treasury
   */
  function setTreasury(address treasury_) external {
    _setTreasury(treasury_);
  }

  /// @inheritdoc IPolicyPool
  function treasury() external view override returns (address) {
    return _treasury;
  }

  /**
   * @notice Adds a new component (either an {EToken}, {RiskModule} or {PremiumsAccount}) to the protocol.
   * @dev The component status will be `active`.
   *
   * @custom:emits ComponentStatusChanged with status active.
   * @custom:throws ComponentNotTheRightKind When there's a mismatch between the specified kind and supported interface
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
   * @notice Removes a component from the protocol
   * @dev The component needs to be in `deprecated` status before doing this operation.
   *
   * @custom:emits ComponentStatusChanged with status inactive.
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
   * @notice Changes the status of a component.
   *
   * @custom:emits ComponentStatusChanged with the new status.
   * @custom:throws InvalidComponentStatus() when newStatus is inactive (use removeComponent() instead)
   * @param component The address of component contract. Must be a component added before.
   * @param newStatus The new status, must be either `active`, `deprecated` or `suspended`.
   */
  function changeComponentStatus(IPolicyPoolComponent component, ComponentStatus newStatus) external {
    Component storage comp = _components[component];
    require(comp.status != ComponentStatus.inactive, ComponentNotFound());
    require(newStatus != ComponentStatus.inactive, InvalidComponentStatus());
    comp.status = newStatus;
    emit ComponentStatusChanged(component, comp.kind, newStatus);
  }

  /**
   * @notice Returns the status of a component.
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

  /// @inheritdoc IPolicyPool
  function deposit(IEToken eToken, uint256 amount, address receiver) external override whenNotPaused {
    _deposit(eToken, amount, receiver);
  }

  /// @inheritdoc IPolicyPool
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

  /// @inheritdoc IPolicyPool
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

  /// @inheritdoc IPolicyPool
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

  /// @inheritdoc IPolicyPool
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
    // payout, jrScr, srScr, expiration can change in any direction

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

  /// @inheritdoc IPolicyPool
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

  /**
   * @notice Generates a policyId, combining the riskModule (first 20 bytes) with the internalId (last 12 bytes)
   *
   * @param rm The risk module
   * @param internalId An identifier for the policy that is unique within a given risk module
   * @return The policy id, that will be used as the tokenId for the minted policy NFT
   */
  function makePolicyId(IRiskModule rm, uint96 internalId) public pure returns (uint256) {
    return (uint256(uint160(address(rm))) << 96) + internalId;
  }

  /**
   * @notice Extracts the risk module address from a policyId (first 20 bytes)
   */
  function extractRiskModule(uint256 policyId) public pure returns (IRiskModule) {
    return IRiskModule(address(uint160(policyId >> 96)));
  }

  /// @inheritdoc IPolicyPool
  function expirePolicy(Policy.PolicyData calldata policy) external override whenNotPaused {
    if (policy.expiration > block.timestamp) revert PolicyNotExpired(policy.id, policy.expiration, block.timestamp);
    return _resolvePolicy(policy, 0, true);
  }

  /// @inheritdoc IPolicyPool
  function resolvePolicy(Policy.PolicyData calldata policy, uint256 payout) external override whenNotPaused {
    return _resolvePolicy(policy, payout, false);
  }

  /// @inheritdoc IPolicyPool
  function isActive(uint256 policyId) external view override returns (bool) {
    return _policies[policyId] != bytes32(0);
  }

  /// @inheritdoc IPolicyPool
  function getPolicyHash(uint256 policyId) external view override returns (bytes32) {
    return _policies[policyId];
  }

  /**
   * @notice Internal function that handles the different alternative resolutions for a policy.
   * @dev Alternatives: with or without payout and expiration.
   *
   * @custom:emits PolicyResolved with the payout amount
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

  /**
   * @notice  Changes the maximum cumulative loss limit (exposure limit) for a given risk module
   * @dev     This function allows updating the exposure limit for a risk module.
   *          The new limit must be greater than or equal to the current active exposure.
   *
   * @param   rm  The risk module interface for which to update the exposure limit
   * @param   newLimit  The new exposure limit to set (will be converted to uint128)
   * @custom:throws ExposureLimitExceeded if the new limit is less than the current active exposure
   * @custom:emits  ExposureLimitChanged with parameters: (risk module, old limit, new limit)
   */
  function setExposureLimit(IRiskModule rm, uint256 newLimit) external {
    Exposure storage exposure = _exposureByRm[rm];
    uint128 newLimit128 = newLimit.toUint128();
    require(exposure.active <= newLimit128, ExposureLimitExceeded(exposure.active, newLimit128));
    emit ExposureLimitChanged(rm, exposure.limit, newLimit128);
    exposure.limit = newLimit128;
  }

  /**
   * @notice  Retrieves the current exposure data for a specific risk module
   * @dev     Returns both the active exposure (current cumulative losses)
   * and the configured exposure limit for the given risk module.
   *
   * @param   rm  The risk module interface to query exposure data for
   * @return  active  The current active exposure (cumulative losses) for the risk module
   * @return  limit   The configured maximum exposure limit for the risk module
   */
  function getExposure(IRiskModule rm) external view returns (uint256 active, uint256 limit) {
    Exposure storage exposure = _exposureByRm[rm];
    active = exposure.active;
    limit = exposure.limit;
  }

  /**
   * @notice Notifies the payout with a callback
   * @dev Only if the policyholder implements the IPolicyHolder interface.
   * Reverts if the policyholder contract explicitly reverts or it doesn't return the
   * IPolicyHolder.onPayoutReceived selector.
   */
  function _notifyPayout(uint256 policyId, uint256 payout) internal {
    address customer = ownerOf(policyId);
    if (!ERC165Checker.supportsInterface(customer, type(IPolicyHolder).interfaceId)) return;

    bytes4 retval = IPolicyHolder(customer).onPayoutReceived(_msgSender(), address(this), policyId, payout);
    if (retval != IPolicyHolder.onPayoutReceived.selector) revert InvalidNotificationResponse(retval);
  }

  /**
   * @notice Notifies the expiration with a callback
   * @dev Only if the policyholder implements the IPolicyHolder interface. Never reverts. The onPolicyExpired has
   * a gas limit = HOLDER_GAS_LIMIT
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
   * @notice Notifies the replacement with a callback
   * @dev Only if the policyholder implements the IPolicyHolder interface.
   * Reverts if the policyholder contract explicitly reverts or it doesn't return the
   * IPolicyHolder.onPolicyReplaced selector.
   */
  function _notifyReplacement(uint256 oldPolicyId, uint256 newPolicyId) internal {
    address customer = ownerOf(oldPolicyId);
    if (!ERC165Checker.supportsInterface(customer, type(IPolicyHolder).interfaceId)) return;

    bytes4 retval = IPolicyHolder(customer).onPolicyReplaced(_msgSender(), address(this), oldPolicyId, newPolicyId);
    // PolicyHolder can revert and cancel the policy replacement
    if (retval != IPolicyHolder.onPolicyReplaced.selector) revert InvalidNotificationResponse(retval);
  }

  /**
   * @notice Notifies the cancellation with a callback
   * @dev Only if the policyholder implements the IPolicyHolder interface.
   * Reverts if the policyholder contract explicitly reverts or it doesn't return the
   * IPolicyHolder.onPolicyCancelled selector.
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
    // PolicyHolder can revert and cancel the policy cancellation
    if (retval != IPolicyHolder.onPolicyCancelled.selector) revert InvalidNotificationResponse(retval);
  }

  /**
   * @notice Base URI for computing {tokenURI}.
   * @dev If set, the resulting URI for each token will be the concatenation of the `baseURI` and the `tokenId`. Empty
   * by default, can be modified calling {setBaseURI}.
   */
  function _baseURI() internal view virtual override returns (string memory) {
    return _nftBaseURI;
  }

  /**
   * @notice Changes the baseURI of the minted policy NFTs
   *
   * @custom:emits BaseURIChanged With the new and old URIs
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
