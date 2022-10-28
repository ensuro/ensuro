// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.16;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {AddressUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/AddressUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ERC721Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IAccessManager} from "./interfaces/IAccessManager.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";
import {IPremiumsAccount} from "./interfaces/IPremiumsAccount.sol";
import {IPolicyPool} from "./interfaces/IPolicyPool.sol";
import {IRiskModule} from "./interfaces/IRiskModule.sol";
import {IPolicyPoolComponent} from "./interfaces/IPolicyPoolComponent.sol";
import {IEToken} from "./interfaces/IEToken.sol";
import {IPolicyHolder} from "./interfaces/IPolicyHolder.sol";
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
  bytes32 public constant LEVEL3_ROLE = keccak256("LEVEL3_ROLE");

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
   * @dev Event emitted every time a new policy is added to the pool. Contains all the data about the policy that is
   * later required for doing operations with the policy like resolution or expiration.
   *
   * @param riskModule The risk module that created the policy
   * @param policy The {Policy-PolicyData} struct with all the immutable fields of the policy.
   */
  event NewPolicy(IRiskModule indexed riskModule, Policy.PolicyData policy);

  /**
   * @dev Event emitted every time a policy is removed from the pool. If the policy expired, the `payout` is 0,
   * otherwise is the amount transferred to the policyholder.
   *
   * @param riskModule The risk module where that created the policy initially.
   * @param policyId The unique id of the policy
   * @param payout The payout that has been paid to the policy holder. 0 when the policy expired.
   */
  event PolicyResolved(IRiskModule indexed riskModule, uint256 indexed policyId, uint256 payout);

  /**
   * @dev Event emitted when the treasury changes
   *
   * @param action The type of governance action (just setTreasury in this contract for now)
   * @param value  The address of the new treasury
   */
  event ComponentChanged(IAccessManager.GovernanceActions indexed action, address value);

  /**
   * @dev Event emitted when a new component added/removed to the pool or the status changes.
   *
   * @param component The address of the component, it can be an {EToken}, {RiskModule} or {PremiumsAccount}
   * @param kind Value indicating the kind of component. See {ComponentKind}
   * @param newStatus The status of the component after the operation. See {ComponentStatus}
   */
  event ComponentStatusChanged(
    IPolicyPoolComponent indexed component,
    ComponentKind kind,
    ComponentStatus newStatus
  );

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
    require(address(access_) != address(0), "PolicyPool: access cannot be zero address");
    require(address(currency_) != address(0), "PolicyPool: currency cannot be zero address");
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
  function initialize(
    string memory name_,
    string memory symbol_,
    address treasury_
  ) public initializer {
    require(bytes(name_).length > 0, "PolicyPool: name cannot be empty");
    require(bytes(symbol_).length > 0, "PolicyPool: symbol cannot be empty");
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

  function _authorizeUpgrade(address newImpl)
    internal
    view
    override
    onlyRole2(GUARDIAN_ROLE, LEVEL1_ROLE)
  {
    IPolicyPool newPool = IPolicyPool(newImpl);
    require(newPool.access() == _access, "Can't upgrade changing the access manager");
    require(newPool.currency() == _currency, "Can't upgrade changing the currency");
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
    require(treasury_ != address(0), "PolicyPool: treasury cannot be the zero address");
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
  function addComponent(IPolicyPoolComponent component, ComponentKind kind)
    external
    onlyRole(LEVEL1_ROLE)
  {
    Component storage comp = _components[component];
    require(comp.status == ComponentStatus.inactive, "Component already in the pool");
    require(component.policyPool() == this, "Component not linked to this pool");

    require(
      (kind == ComponentKind.eToken && component.supportsInterface(type(IEToken).interfaceId)) ||
        (kind == ComponentKind.premiumsAccount &&
          component.supportsInterface(type(IPremiumsAccount).interfaceId)) ||
        (kind == ComponentKind.riskModule &&
          component.supportsInterface(type(IRiskModule).interfaceId)),
      "PolicyPool: Not the right kind"
    );

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
    require(comp.status == ComponentStatus.deprecated, "Component not deprecated");
    if (comp.kind == ComponentKind.eToken) {
      require(
        IEToken(address(component)).totalSupply() == 0,
        "EToken has liquidity, can't be removed"
      );
    } else if (comp.kind == ComponentKind.riskModule) {
      require(
        IRiskModule(address(component)).activeExposure() == 0,
        "Can't remove a module with active policies"
      );
    } else if (comp.kind == ComponentKind.premiumsAccount) {
      IPremiumsAccount pa = IPremiumsAccount(address(component));
      require(pa.purePremiums() == 0, "Can't remove a PremiumsAccount with premiums");
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
  function changeComponentStatus(IPolicyPoolComponent component, ComponentStatus newStatus)
    external
    onlyRole2(GUARDIAN_ROLE, LEVEL1_ROLE)
  {
    Component storage comp = _components[component];
    require(comp.status != ComponentStatus.inactive, "Component not found");
    require(
      (newStatus == ComponentStatus.active && _access.hasRole(LEVEL1_ROLE, _msgSender())) ||
        (newStatus == ComponentStatus.suspended && _access.hasRole(GUARDIAN_ROLE, _msgSender())) ||
        (newStatus == ComponentStatus.deprecated && _access.hasRole(LEVEL1_ROLE, _msgSender())),
      "Only GUARDIAN can suspend / Only LEVEL1 can activate/deprecate"
    );
    comp.status = newStatus;
    emit ComponentStatusChanged(component, comp.kind, newStatus);
  }

  /**
   * @dev Returns the status of a component.
   *
   * @param component The address of the component
   * @return The status of the component. See {ComponentStatus}
   */
  function getComponentStatus(IPolicyPoolComponent component)
    external
    view
    returns (ComponentStatus)
  {
    return _components[component].status;
  }

  function _etkStatus(IEToken eToken) internal view returns (ComponentStatus) {
    Component storage comp = _components[IPolicyPoolComponent(address(eToken))];
    require(comp.kind == ComponentKind.eToken, "Component is not an eToken");
    return comp.status;
  }

  function _rmStatus(IRiskModule riskModule) internal view returns (ComponentStatus) {
    Component storage comp = _components[IPolicyPoolComponent(address(riskModule))];
    require(comp.kind == ComponentKind.riskModule, "Component is not a RiskModule");
    return comp.status;
  }

  function _paStatus(IPremiumsAccount premiumsAccount) internal view returns (ComponentStatus) {
    Component storage comp = _components[IPolicyPoolComponent(address(premiumsAccount))];
    require(comp.kind == ComponentKind.premiumsAccount, "Component is not a PremiumsAccount");
    return comp.status;
  }

  function deposit(IEToken eToken, uint256 amount) external override whenNotPaused {
    require(_etkStatus(eToken) == ComponentStatus.active, "eToken is not active");
    uint256 balanceBefore = _currency.balanceOf(address(eToken));
    _currency.safeTransferFrom(_msgSender(), address(eToken), amount);
    eToken.deposit(_msgSender(), _currency.balanceOf(address(eToken)) - balanceBefore);
  }

  function withdraw(IEToken eToken, uint256 amount)
    external
    override
    whenNotPaused
    returns (uint256)
  {
    ComponentStatus etkStatus = _etkStatus(eToken);
    require(
      etkStatus == ComponentStatus.active || etkStatus == ComponentStatus.deprecated,
      "eToken not found or withdraws not allowed"
    );
    address provider = _msgSender();
    return eToken.withdraw(provider, amount);
  }

  function newPolicy(
    Policy.PolicyData memory policy,
    address payer,
    address policyHolder,
    uint96 internalId
  ) external override whenNotPaused returns (uint256) {
    // Checks
    IRiskModule rm = policy.riskModule;
    require(address(rm) == _msgSender(), "Only the RM can create new policies");
    require(_rmStatus(rm) == ComponentStatus.active, "RM module not found or not active");
    IPremiumsAccount pa = rm.premiumsAccount();
    require(_paStatus(pa) == ComponentStatus.active, "PremiumsAccount not found or not active");

    // Effects
    policy.id = (uint256(uint160(address(rm))) << 96) + internalId;
    require(_policies[policy.id] == bytes32(0), "Policy already exists");
    _policies[policy.id] = policy.hash();

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
    _safeMint(policyHolder, policy.id, "");

    emit NewPolicy(rm, policy);
    return policy.id;
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

  function isActive(uint256 policyId) external view override returns (bool) {
    return _policies[policyId] != bytes32(0);
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
  function _resolvePolicy(
    Policy.PolicyData memory policy,
    uint256 payout,
    bool expired
  ) internal {
    // Checks
    _validatePolicy(policy);
    IRiskModule rm = policy.riskModule;
    require(expired || address(rm) == _msgSender(), "Only the RM can resolve policies");
    require(payout == 0 || policy.expiration > block.timestamp, "Can't pay expired policy");
    ComponentStatus compStatus = _rmStatus(rm);
    require(
      compStatus == ComponentStatus.active || compStatus == ComponentStatus.deprecated,
      "Module must be active or deprecated to process resolutions"
    );
    require(payout <= policy.payout, "payout > policy.payout");

    bool customerWon = payout > 0;

    IPremiumsAccount pa = rm.premiumsAccount();
    compStatus = _paStatus(pa);
    require(
      compStatus == ComponentStatus.active || compStatus == ComponentStatus.deprecated,
      "PremiumsAccount must be active or deprecated to process resolutions"
    );
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
   * @dev Notifies the payout with a callback if the policyholder is a contract. Only reverts if the policyholder
   * contract explicitly reverts. Doesn't reverts is the callback is not implemented.
   */
  function _notifyPayout(uint256 policyId, uint256 payout) internal {
    address customer = ownerOf(policyId);
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
    address customer = ownerOf(policyId);
    if (!AddressUpgradeable.isContract(customer)) return;
    try IPolicyHolder(customer).onPolicyExpired(_msgSender(), address(this), policyId) returns (
      bytes4
    ) {
      return;
    } catch {
      return;
    }
  }

  function _beforeTokenTransfer(
    address from,
    address to,
    uint256 tokenId
  ) internal override whenNotPaused {
    super._beforeTokenTransfer(from, to, tokenId);
  }

  /**
   * @dev This empty reserved space is put in place to allow future versions to add new
   * variables without shifting down storage in the inheritance chain.
   * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
   */
  uint256[47] private __gap;
}
