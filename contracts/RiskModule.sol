// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IPolicyPool} from "./interfaces/IPolicyPool.sol";
import {PolicyPoolComponent} from "./PolicyPoolComponent.sol";
import {IRiskModule} from "./interfaces/IRiskModule.sol";
import {IUnderwriter} from "./interfaces/IUnderwriter.sol";
import {IPremiumsAccount} from "./interfaces/IPremiumsAccount.sol";
import {Governance} from "./Governance.sol";
import {Policy} from "./Policy.sol";

/**
 * @title Ensuro Risk Module contract
 * @dev Risk Module that keeps the configuration and is responsible for injecting policies and policy resolution
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
contract RiskModule is IRiskModule, PolicyPoolComponent {
  using Policy for Policy.PolicyData;
  using SafeCast for uint256;

  /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
  IPremiumsAccount internal immutable _premiumsAccount;

  IUnderwriter internal _underwriter;

  address internal _wallet; // Address of the RiskModule provider

  event PartnerWalletChanged(address oldWallet, address newWallet);
  event UnderwriterChanged(IUnderwriter oldUW, IUnderwriter newUW);

  error InvalidWallet(address wallet);
  error InvalidUnderwriter(IUnderwriter uw);
  error PremiumsAccountMustBePartOfThePool();
  error UpgradeCannotChangePremiumsAccount();
  error ExpirationMustBeInTheFuture(uint40 expiration, uint40 now);
  error InvalidCustomer(address customer);

  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor(IPolicyPool policyPool_, IPremiumsAccount premiumsAccount_) PolicyPoolComponent(policyPool_) {
    if (PolicyPoolComponent(address(premiumsAccount_)).policyPool() != policyPool_) {
      revert PremiumsAccountMustBePartOfThePool();
    }
    _premiumsAccount = premiumsAccount_;
  }

  /**
   * @dev Initializes the RiskModule
   * @param underwriter_ Contract in charge of decoding and validating the input and pricing the policies
   * @param wallet_ Address of the RiskModule provider
   */
  function initialize(IUnderwriter underwriter_, address wallet_) public initializer {
    __RiskModule_init(underwriter_, wallet_);
  }

  /**
   * @dev Initializes the RiskModule
   * @param underwriter_ Contract in charge of decoding and validating the input and pricing the policies
   * @param wallet_ Address of the RiskModule provider
   */
  // solhint-disable-next-line func-name-mixedcase
  function __RiskModule_init(IUnderwriter underwriter_, address wallet_) internal onlyInitializing {
    __PolicyPoolComponent_init();
    __RiskModule_init_unchained(underwriter_, wallet_);
  }

  // solhint-disable-next-line func-name-mixedcase
  function __RiskModule_init_unchained(IUnderwriter underwriter_, address wallet_) internal onlyInitializing {
    setWallet(wallet_);
    setUnderwriter(underwriter_);
  }

  function _upgradeValidations(address newImpl) internal view virtual override {
    super._upgradeValidations(newImpl);
    IRiskModule newRM = IRiskModule(newImpl);
    if (newRM.premiumsAccount() != _premiumsAccount) {
      revert UpgradeCannotChangePremiumsAccount();
    }
  }

  /**
   * @dev See {IERC165-supportsInterface}.
   */
  function supportsInterface(bytes4 interfaceId) public view virtual override returns (bool) {
    return super.supportsInterface(interfaceId) || interfaceId == type(IRiskModule).interfaceId;
  }

  function wallet() public view override returns (address) {
    return _wallet;
  }

  function setWallet(address newWallet) public {
    require(newWallet != address(0), InvalidWallet(newWallet));
    emit PartnerWalletChanged(_wallet, newWallet);
    _wallet = newWallet;
  }

  function underwriter() public view returns (IUnderwriter) {
    return _underwriter;
  }

  function setUnderwriter(IUnderwriter newUW) public {
    require(address(newUW) != address(0), InvalidUnderwriter(newUW));
    emit UnderwriterChanged(_underwriter, newUW);
    _underwriter = newUW;
  }

  function getMinimumPremium(
    uint256 payout,
    uint256 lossProb,
    uint40 start,
    uint40 expiration,
    Policy.Params memory p
  ) public pure returns (uint256) {
    return Policy.getMinimumPremium(p, payout, lossProb, expiration, start).totalPremium;
  }

  /**
   * @dev Creates a new policy. The premium will paid by msg.sender
   *
   * @param inputData Input data that will be decoded by the _underwriter to construct the parameters for the
   *                  new policy.
   * @param onBehalfOf The address that will be the owner of the created policy
   */
  function newPolicy(bytes calldata inputData, address onBehalfOf) external returns (Policy.PolicyData memory policy) {
    (
      uint256 payout,
      uint256 premium,
      uint256 lossProb,
      uint40 expiration,
      uint96 internalId,
      Policy.Params memory params_
    ) = _underwriter.priceNewPolicy(address(this), inputData);

    uint40 now_ = uint40(block.timestamp);
    if (premium == type(uint256).max) {
      premium = getMinimumPremium(payout, lossProb, now_, expiration, params_);
    }
    require(expiration > now_, ExpirationMustBeInTheFuture(expiration, now_));
    require(onBehalfOf != address(0), InvalidCustomer(onBehalfOf));
    policy = Policy.initialize(params_, premium, payout, lossProb, expiration, now_);
    policy.id = _policyPool.newPolicy(policy, msg.sender, onBehalfOf, internalId);
    return policy;
  }

  /**
   * @dev Replaces a policy with a new one, with the same owner
   *
   * @param inputData Input data that will be decoded by the _underwriter to construct the oldPolicy and the
   *                  parameters for the new policy.
   */
  function replacePolicy(bytes calldata inputData) internal virtual returns (Policy.PolicyData memory policy) {
    (
      Policy.PolicyData memory oldPolicy,
      uint256 payout,
      uint256 premium,
      uint256 lossProb,
      uint40 expiration,
      uint96 internalId,
      Policy.Params memory params_
    ) = _underwriter.pricePolicyReplacement(address(this), inputData);

    if (premium == type(uint256).max) {
      premium = getMinimumPremium(payout, lossProb, oldPolicy.start, expiration, params_);
    }
    if (expiration < uint40(block.timestamp)) revert ExpirationMustBeInTheFuture(expiration, uint40(block.timestamp));
    policy = Policy.initialize(params_, premium, payout, lossProb, expiration, oldPolicy.start);

    policy.id = _policyPool.replacePolicy(oldPolicy, policy, msg.sender, internalId);

    return policy;
  }

  function premiumsAccount() external view override returns (IPremiumsAccount) {
    return _premiumsAccount;
  }

  /**
   * @dev This empty reserved space is put in place to allow future versions to add new
   * variables without shifting down storage in the inheritance chain.
   * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
   */
  uint256[46] private __gap;
}
