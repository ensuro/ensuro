// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.16;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {WadRayMath} from "./dependencies/WadRayMath.sol";
import {IPolicyPool} from "./interfaces/IPolicyPool.sol";
import {PolicyPoolComponent} from "./PolicyPoolComponent.sol";
import {IRiskModule} from "./interfaces/IRiskModule.sol";
import {IPremiumsAccount} from "./interfaces/IPremiumsAccount.sol";
import {IAccessManager} from "./interfaces/IAccessManager.sol";
import {Policy} from "./Policy.sol";

/**
 * @title Ensuro Risk Module base contract
 * @dev Risk Module that keeps the configuration and is responsible for pricing and policy resolution
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
abstract contract RiskModule is IRiskModule, PolicyPoolComponent {
  using Policy for Policy.PolicyData;
  using WadRayMath for uint256;
  using SafeCast for uint256;

  uint256 internal constant SECONDS_IN_YEAR_WAD = 31536000e18; /* 365 * 24 * 3600 * 10e18 */
  uint16 internal constant HOURS_PER_YEAR = 8760; /* 24 * 365 */

  uint256 internal constant FOUR_DECIMAL_TO_WAD = 1e14;
  uint16 internal constant HUNDRED_PERCENT = 1e4;
  uint16 internal constant MIN_MOC = 5e3;
  uint16 internal constant MAX_MOC = 4e4;

  // For parameters that can be changed by the risk module provider
  bytes32 public constant RM_PROVIDER_ROLE = keccak256("RM_PROVIDER_ROLE");

  /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
  IPremiumsAccount internal immutable _premiumsAccount;

  string private _name;

  struct PackedParams {
    uint16 moc; // Margin Of Conservativism - factor that multiplies lossProb - 4 decimals
    uint16 jrCollRatio; // Collateralization Ratio to compute Junior solvency as % of payout - 4 decimals
    uint16 collRatio; // Collateralization Ratio to compute solvency requirement as % of payout - 4 decimals
    uint16 ensuroPpFee; // % of pure premium that will go for Ensuro treasury - 4 decimals
    uint16 ensuroCocFee; // % of CoC that will go for Ensuro treasury - 4 decimals
    uint16 jrRoc; // Return on Capital paid to Junior LPs - Annualized Percentage - 4 decimals
    uint16 srRoc; // Return on Capital paid to Senior LPs - Annualized Percentage - 4 decimals
    uint32 maxPayoutPerPolicy; // Max Payout per Policy - 2 decimals
    uint32 exposureLimit; // Max exposure (sum of payouts) to be allocated to this module - 0 decimals
    uint16 maxDuration; // Max policy duration (in hours)
  }

  PackedParams internal _params;

  uint256 internal _activeExposure; // in wad - Current exposure of active policies

  address internal _wallet; // Address of the RiskModule provider

  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor(
    IPolicyPool policyPool_,
    IPremiumsAccount premiumsAccount_
  ) PolicyPoolComponent(policyPool_) {
    require(
      PolicyPoolComponent(address(premiumsAccount_)).policyPool() == policyPool_,
      "The PremiumsAccount must be part of the Pool"
    );
    _premiumsAccount = premiumsAccount_;
  }

  /**
   * @dev Initializes the RiskModule
   * @param name_ Name of the Risk Module
   * @param collRatio_ Collateralization ratio to compute solvency requirement as % of payout (in wad)
   * @param ensuroPpFee_ % of pure premium that will go for Ensuro treasury (in wad)
   * @param srRoc_ return on capital paid to LPs (annualized percentage - in wad)
   * @param maxPayoutPerPolicy_ Maximum payout per policy (in wad)
   * @param exposureLimit_ Max exposure (sum of payouts) to be allocated to this module (in wad)
   * @param wallet_ Address of the RiskModule provider
   */
  // solhint-disable-next-line func-name-mixedcase
  function __RiskModule_init(
    string memory name_,
    uint256 collRatio_,
    uint256 ensuroPpFee_,
    uint256 srRoc_,
    uint256 maxPayoutPerPolicy_,
    uint256 exposureLimit_,
    address wallet_
  ) internal onlyInitializing {
    __PolicyPoolComponent_init();
    __RiskModule_init_unchained(
      name_,
      collRatio_,
      ensuroPpFee_,
      srRoc_,
      maxPayoutPerPolicy_,
      exposureLimit_,
      wallet_
    );
  }

  // solhint-disable-next-line func-name-mixedcase
  function __RiskModule_init_unchained(
    string memory name_,
    uint256 collRatio_,
    uint256 ensuroPpFee_,
    uint256 srRoc_,
    uint256 maxPayoutPerPolicy_,
    uint256 exposureLimit_,
    address wallet_
  ) internal onlyInitializing {
    _name = name_;
    _params = PackedParams({
      moc: HUNDRED_PERCENT,
      jrCollRatio: 0,
      collRatio: _wadTo4(collRatio_),
      ensuroPpFee: _wadTo4(ensuroPpFee_),
      ensuroCocFee: 0,
      jrRoc: 0,
      srRoc: _wadTo4(srRoc_),
      maxPayoutPerPolicy: _amountToX(2, maxPayoutPerPolicy_),
      exposureLimit: _amountToX(0, exposureLimit_),
      maxDuration: HOURS_PER_YEAR
    });
    _activeExposure = 0;
    _wallet = wallet_;
    _validateParameters();
  }

  function _upgradeValidations(address newImpl) internal view virtual override {
    super._upgradeValidations(newImpl);
    IRiskModule newRM = IRiskModule(newImpl);
    require(
      newRM.premiumsAccount() == _premiumsAccount,
      "Can't upgrade changing the PremiumsAccount"
    );
  }

  /**
   * @dev See {IERC165-supportsInterface}.
   */
  function supportsInterface(bytes4 interfaceId) public view virtual override returns (bool) {
    return super.supportsInterface(interfaceId) || interfaceId == type(IRiskModule).interfaceId;
  }

  // runs validation on RiskModule parameters
  function _validateParameters() internal view virtual override {
    // _maxPayoutPerPolicy no limits
    require(
      exposureLimit() >= _activeExposure,
      "Validation: exposureLimit can't be less than actual activeExposure"
    );
    require(_wallet != address(0), "Validation: Wallet can't be zero address");
    _validatePackedParams(_params);
  }

  function _validateParams(Params memory params_) internal pure {
    require(_wadTo4(params_.jrCollRatio) <= HUNDRED_PERCENT, "Validation: jrCollRatio must be <=1");
    require(
      _wadTo4(params_.collRatio) <= HUNDRED_PERCENT && params_.collRatio > 0,
      "Validation: collRatio must be <=1"
    );
    require(
      _wadTo4(params_.collRatio) >= _wadTo4(params_.jrCollRatio),
      "Validation: collRatio >= jrCollRatio"
    );
    require(
      _wadTo4(params_.moc) <= MAX_MOC && params_.moc >= MIN_MOC,
      "Validation: moc must be [0.5, 4]"
    );
    require(
      _wadTo4(params_.ensuroPpFee) <= HUNDRED_PERCENT,
      "Validation: ensuroPpFee must be <= 1"
    );
    require(
      _wadTo4(params_.ensuroCocFee) <= HUNDRED_PERCENT,
      "Validation: ensuroCocFee must be <= 1"
    );
    require(_wadTo4(params_.srRoc) <= HUNDRED_PERCENT, "Validation: srRoc must be <= 1 (100%)");
    require(_wadTo4(params_.jrRoc) <= HUNDRED_PERCENT, "Validation: jrRoc must be <= 1 (100%)");
  }

  function _validatePackedParams(PackedParams storage params_) internal view {
    _validateParams(_unpackParams(params_));
    require(
      params_.exposureLimit > 0 && params_.maxPayoutPerPolicy > 0,
      "Exposure and MaxPayout must be >0"
    );
  }

  function name() public view override returns (string memory) {
    return _name;
  }

  // solhint-disable-next-line func-name-mixedcase
  function _4toWad(uint16 value) internal pure returns (uint256) {
    // 4 decimals to Wad (18 decimals)
    return uint256(value) * FOUR_DECIMAL_TO_WAD;
  }

  function _wadTo4(uint256 value) internal pure returns (uint16) {
    // Wad to 4 decimals
    return (value / FOUR_DECIMAL_TO_WAD).toUint16();
  }

  // solhint-disable-next-line func-name-mixedcase
  function _XtoAmount(uint8 decimals, uint32 value) internal view returns (uint256) {
    // X decimals to currency decimals (6 for USDC)
    return uint256(value) * 10 ** (currency().decimals() - decimals);
  }

  function _amountToX(uint8 decimals, uint256 value) internal view returns (uint32) {
    // currency decimals to X decimals (assuming X < currency decimals)
    return (value / 10 ** (currency().decimals() - decimals)).toUint32();
  }

  function maxPayoutPerPolicy() public view override returns (uint256) {
    return _XtoAmount(2, _params.maxPayoutPerPolicy);
  }

  function exposureLimit() public view override returns (uint256) {
    return _XtoAmount(0, _params.exposureLimit);
  }

  function maxDuration() public view override returns (uint256) {
    return _params.maxDuration;
  }

  function activeExposure() public view override returns (uint256) {
    return _activeExposure;
  }

  function wallet() public view override returns (address) {
    return _wallet;
  }

  function setParam(
    Parameter param,
    uint256 newValue
  ) external onlyGlobalOrComponentRole3(LEVEL1_ROLE, LEVEL2_ROLE, LEVEL3_ROLE) {
    bool tweak = !hasPoolRole(LEVEL2_ROLE) && !hasPoolRole(LEVEL1_ROLE);
    if (param == Parameter.moc) {
      require(!tweak || _isTweakWad(_4toWad(_params.moc), newValue, 1e17), "Tweak exceeded");
      _params.moc = _wadTo4(newValue);
    } else if (param == Parameter.jrCollRatio) {
      require(
        !tweak || _isTweakWad(_4toWad(_params.jrCollRatio), newValue, 1e17),
        "Tweak exceeded"
      );
      _params.jrCollRatio = _wadTo4(newValue);
    } else if (param == Parameter.collRatio) {
      require(!tweak || _isTweakWad(_4toWad(_params.collRatio), newValue, 1e17), "Tweak exceeded");
      _params.collRatio = _wadTo4(newValue);
    } else if (param == Parameter.ensuroPpFee) {
      require(
        !tweak || _isTweakWad(_4toWad(_params.ensuroPpFee), newValue, 1e17),
        "Tweak exceeded"
      );
      _params.ensuroPpFee = _wadTo4(newValue);
    } else if (param == Parameter.ensuroCocFee) {
      require(
        !tweak || _isTweakWad(_4toWad(_params.ensuroCocFee), newValue, 1e17),
        "Tweak exceeded"
      );
      _params.ensuroCocFee = _wadTo4(newValue);
    } else if (param == Parameter.jrRoc) {
      require(!tweak || _isTweakWad(_4toWad(_params.jrRoc), newValue, 1e17), "Tweak exceeded");
      _params.jrRoc = _wadTo4(newValue);
    } else if (param == Parameter.srRoc) {
      require(!tweak || _isTweakWad(_4toWad(_params.srRoc), newValue, 1e17), "Tweak exceeded");
      _params.srRoc = _wadTo4(newValue);
    } else if (param == Parameter.maxPayoutPerPolicy) {
      require(!tweak || _isTweakWad(maxPayoutPerPolicy(), newValue, 1e17), "Tweak exceeded");
      _params.maxPayoutPerPolicy = _amountToX(2, newValue);
    } else if (param == Parameter.exposureLimit) {
      require(newValue >= _activeExposure, "Can't set exposureLimit less than active exposure");
      require(!tweak || _isTweakWad(exposureLimit(), newValue, 1e17), "Tweak exceeded");
      require(
        newValue <= exposureLimit() || hasPoolRole(LEVEL1_ROLE),
        "Tweak exceeded: Increase requires LEVEL1_ROLE"
      );
      _params.exposureLimit = _amountToX(0, newValue);
    } else if (param == Parameter.maxDuration) {
      require(!tweak, "Tweak exceeded");
      _params.maxDuration = newValue.toUint16();
    }
    _parameterChanged(
      IAccessManager.GovernanceActions(
        uint256(IAccessManager.GovernanceActions.setMoc) + uint256(param)
      ),
      newValue,
      tweak
    );
  }

  function params() public view virtual override returns (Params memory ret) {
    return _unpackParams(_params);
  }

  function _unpackParams(PackedParams storage params_) internal view returns (Params memory ret) {
    return
      Params({
        moc: _4toWad(params_.moc),
        jrCollRatio: _4toWad(params_.jrCollRatio),
        collRatio: _4toWad(params_.collRatio),
        ensuroPpFee: _4toWad(params_.ensuroPpFee),
        ensuroCocFee: _4toWad(params_.ensuroCocFee),
        jrRoc: _4toWad(params_.jrRoc),
        srRoc: _4toWad(params_.srRoc)
      });
  }

  function setWallet(address wallet_) external onlyComponentRole(RM_PROVIDER_ROLE) {
    require(wallet_ != address(0), "RiskModule: wallet cannot be the zero address");
    _wallet = wallet_;
    _parameterChanged(IAccessManager.GovernanceActions.setWallet, uint256(uint160(wallet_)), false);
  }

  function getMinimumPremium(
    uint256 payout,
    uint256 lossProb,
    uint40 expiration
  ) public view virtual returns (uint256) {
    return _getMinimumPremium(payout, lossProb, expiration, params());
  }

  function _getMinimumPremium(
    uint256 payout,
    uint256 lossProb,
    uint40 expiration,
    Params memory p
  ) internal view returns (uint256) {
    uint256 purePremium = payout.wadMul(lossProb.wadMul(p.moc));
    uint256 jrScr = payout.wadMul(p.jrCollRatio);
    if (jrScr > purePremium) {
      jrScr -= purePremium;
    } else {
      jrScr = 0;
    }
    uint256 srScr = payout.wadMul(p.collRatio);
    if (srScr > (purePremium + jrScr)) {
      srScr -= purePremium + jrScr;
    } else {
      srScr = 0;
    }
    uint256 jrCoc = jrScr.wadMul(
      (p.jrRoc * (expiration - block.timestamp)).wadDiv(SECONDS_IN_YEAR_WAD)
    );
    uint256 srCoc = srScr.wadMul(
      (p.srRoc * (expiration - block.timestamp)).wadDiv(SECONDS_IN_YEAR_WAD)
    );
    uint256 ensuroCommission = purePremium.wadMul(p.ensuroPpFee) +
      (jrCoc + srCoc).wadMul(p.ensuroCocFee);
    return purePremium + ensuroCommission + (jrCoc + srCoc);
  }

  /**
   * @dev Called from child contracts to create policies (after they validated the pricing)
   *
   * @param payout The exposure (maximum payout) of the policy
   * @param premium The premium that will be paid by the policyHolder
   * @param lossProb The probability of having to pay the maximum payout (wad)
   * @param payer The account that pays for the premium
   * @param expiration The expiration of the policy (timestamp)
   * @param onBehalfOf The policy holder
   * @param internalId An id that's unique within this module and it will be used to identify the policy
   */
  function _newPolicy(
    uint256 payout,
    uint256 premium,
    uint256 lossProb,
    uint40 expiration,
    address payer,
    address onBehalfOf,
    uint96 internalId
  ) internal virtual whenNotPaused returns (Policy.PolicyData memory) {
    return
      _newPolicyWithParams(
        payout,
        premium,
        lossProb,
        expiration,
        payer,
        onBehalfOf,
        internalId,
        params()
      );
  }

  /**
   * @dev Called from child contracts to create policies (after they validated the pricing), receives custom params
   *
   * @param payout The exposure (maximum payout) of the policy
   * @param premium The premium that will be paid by the policyHolder
   * @param lossProb The probability of having to pay the maximum payout (wad)
   * @param payer The account that pays for the premium
   * @param expiration The expiration of the policy (timestamp)
   * @param onBehalfOf The policy holder
   * @param internalId An id that's unique within this module and it will be used to identify the policy
   */
  function _newPolicyCustomParams(
    uint256 payout,
    uint256 premium,
    uint256 lossProb,
    uint40 expiration,
    address payer,
    address onBehalfOf,
    uint96 internalId,
    Params memory params_
  ) internal whenNotPaused returns (Policy.PolicyData memory) {
    return
      _newPolicyWithParams(
        payout,
        premium,
        lossProb,
        expiration,
        payer,
        onBehalfOf,
        internalId,
        params_
      );
  }

  /**
   * @dev Internal method without whenNotPaused, MUST be called from other function that has this modifier
   */
  function _newPolicyWithParams(
    uint256 payout,
    uint256 premium,
    uint256 lossProb,
    uint40 expiration,
    address payer,
    address onBehalfOf,
    uint96 internalId,
    Params memory params_
  ) internal returns (Policy.PolicyData memory) {
    if (premium == type(uint256).max) {
      premium = getMinimumPremium(payout, lossProb, expiration);
    }
    require(premium < payout, "Premium must be less than payout");
    uint40 now_ = uint40(block.timestamp);
    require(expiration > now_, "Expiration must be in the future");
    require(((expiration - now_) / 3600) < _params.maxDuration, "Policy exceeds max duration");
    require(onBehalfOf != address(0), "Customer can't be zero address");
    require(
      _policyPool.currency().allowance(payer, address(_policyPool)) >= premium,
      "You must allow ENSURO to transfer the premium"
    );
    require(
      payer == _msgSender() || _policyPool.currency().allowance(payer, _msgSender()) >= premium,
      "Payer must allow caller to transfer the premium"
    );
    require(payout <= maxPayoutPerPolicy(), "RiskModule: Payout is more than maximum per policy");
    Policy.PolicyData memory policy = Policy.initialize(
      this,
      params_,
      premium,
      payout,
      lossProb,
      expiration
    );
    _activeExposure += policy.payout;
    require(_activeExposure <= exposureLimit(), "RiskModule: Exposure limit exceeded");
    uint256 policyId = _policyPool.newPolicy(policy, payer, onBehalfOf, internalId);
    policy.id = policyId;
    return policy;
  }

  function releaseExposure(uint256 payout) external override onlyPolicyPool {
    // In the Python protype this function is called `remove_policy` and receives
    // all the policy. Since we just need the amount, for performance reasons
    // we just send the amount and the method is called releaseExposure
    _activeExposure -= payout;
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
