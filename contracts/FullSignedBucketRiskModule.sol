// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {IPolicyPool} from "./interfaces/IPolicyPool.sol";
import {IPremiumsAccount} from "./interfaces/IPremiumsAccount.sol";
import {Policy} from "./Policy.sol";
import {SignedBucketRiskModule} from "./SignedBucketRiskModule.sol";

/**
 * @title FullSignedBucket Risk Module
 * @dev Variation of SignedBucketRiskModule that also supports the creation of policies receiving all the
        parameters that affect the price (not just the lossProb). And validates the signature.
        It requires a new permission, the FULL_PRICER_ROLE.
  * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
contract FullSignedBucketRiskModule is SignedBucketRiskModule {
  bytes32 internal constant FULL_PRICER_ROLE = keccak256("FULL_PRICER_ROLE");

  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor(
    IPolicyPool policyPool_,
    IPremiumsAccount premiumsAccount_
  ) SignedBucketRiskModule(policyPool_, premiumsAccount_) {}

  function _paramsAsUint256(PackedParams memory overrideParams) internal pure returns (uint256) {
    return
      (uint256(overrideParams.moc) << 240) |
      (uint256(overrideParams.jrCollRatio) << 224) |
      (uint256(overrideParams.collRatio) << 208) |
      (uint256(overrideParams.ensuroPpFee) << 192) |
      (uint256(overrideParams.ensuroCocFee) << 176) |
      (uint256(overrideParams.jrRoc) << 160) |
      (uint256(overrideParams.srRoc) << 144);
  }

  function _checkFullSignature(
    uint256 payout,
    uint256 premium,
    uint256 lossProb,
    uint40 expiration,
    bytes32 policyData,
    PackedParams memory params,
    bytes32 quoteSignatureR,
    bytes32 quoteSignatureVS,
    uint40 quoteValidUntil
  ) internal view {
    if (quoteValidUntil < block.timestamp) revert QuoteExpired();

    /**
     * Checks the quote has been signed by an authorized user
     * The "quote" is computed as hash of the following fields (encodePacked):
     * - address(this): the address of this RiskModule
     * - payout, premium, lossProb, expiration: the base parameters of the policy
     * - policyData: a hash of the private details of the policy. The calculation should include some
     *   unique id (quoteId), so each policyData identifies a policy.
     * - params: packed as a uint256
     * - quoteValidUntil: the maximum validity of the quote
     */
    bytes32 quoteHash = ECDSA.toEthSignedMessageHash(
      abi.encodePacked(
        address(this),
        payout,
        premium,
        lossProb,
        expiration,
        policyData,
        _paramsAsUint256(params),
        quoteValidUntil
      )
    );
    address signer = ECDSA.recover(quoteHash, quoteSignatureR, quoteSignatureVS);
    _policyPool.access().checkComponentRole(address(this), FULL_PRICER_ROLE, signer, false);
  }

  /**
   * @dev Creates a new Policy using a full signed quote that overrides params.
   *      The caller is the payer of the policy.
   *
   * Requirements:
   * - The caller approved the spending of the premium to the PolicyPool
   * - The quote has been signed by an address with the component role PRICER_ROLE
   *
   * Emits:
   * - {PolicyPool.NewPolicy}
   * - {NewSignedPolicy}
   *
   * @param payout The exposure (maximum payout) of the policy
   * @param premium The premium that will be paid by the payer
   * @param lossProb The probability of having to pay the maximum payout (wad)
   * @param expiration The expiration of the policy (timestamp)
   * @param onBehalfOf The policy holder
   * @param policyData A hash of the private details of the policy. The last 96 bits will be used as internalId
   * @param params The parameters for the policy creation (coll ratios, RoCs, fees, etc.)
   * @param quoteSignatureR The signature of the quote. R component (EIP-2098 signature)
   * @param quoteSignatureVS The signature of the quote. VS component (EIP-2098 signature)
   * @param quoteValidUntil The expiration of the quote
   * @return createdPolicy Returns the created policy
   */
  function newPolicyFullParams(
    uint256 payout,
    uint256 premium,
    uint256 lossProb,
    uint40 expiration,
    address onBehalfOf,
    bytes32 policyData,
    PackedParams memory params,
    bytes32 quoteSignatureR,
    bytes32 quoteSignatureVS,
    uint40 quoteValidUntil
  ) external whenNotPaused onlyComponentRole(POLICY_CREATOR_ROLE) returns (Policy.PolicyData memory createdPolicy) {
    _checkFullSignature(
      payout,
      premium,
      lossProb,
      expiration,
      policyData,
      params,
      quoteSignatureR,
      quoteSignatureVS,
      quoteValidUntil
    );
    createdPolicy = _newPolicyWithParams(
      payout,
      premium,
      lossProb,
      expiration,
      _msgSender(),
      onBehalfOf,
      _makeInternalId(policyData),
      _unpackParams(params)
    );
    emit NewSignedPolicy(createdPolicy.id, policyData);
  }

  /**
   * @dev Replace a policy with a new one, reusing the premium and the capital locked
   *
   * Requirements:
   * - The caller approved the spending of the premium to the PolicyPool
   * - The quote has been signed by an address with the component role PRICER_ROLE
   * - The caller has been granted component role REPLACER_ROLE or creation is open
   *
   * Emits:
   * - {PolicyPool.PolicyReplaced}
   * - {PolicyPool.NewPolicy}
   *
   * @param oldPolicy The policy to be replaced
   * @param payout The exposure (maximum payout) of the new policy
   * @param premium The premium that will be paid by the caller
   * @param lossProb The probability of having to pay the maximum payout (wad)
   * @param expiration The expiration of the policy (timestamp)
   * @param policyData A hash of the private details of the policy. The last 96 bits will be used as internalId
   * @param params The parameters for the policy creation (coll ratios, RoCs, fees, etc.)
   * @param quoteSignatureR The signature of the quote. R component (EIP-2098 signature)
   * @param quoteSignatureVS The signature of the quote. VS component (EIP-2098 signature)
   * @param quoteValidUntil The expiration of the quote
   * @return Returns the id of the created policy
   */
  function replacePolicyFullParams(
    Policy.PolicyData calldata oldPolicy,
    uint256 payout,
    uint256 premium,
    uint256 lossProb,
    uint40 expiration,
    bytes32 policyData,
    PackedParams memory params,
    bytes32 quoteSignatureR,
    bytes32 quoteSignatureVS,
    uint40 quoteValidUntil
  ) external whenNotPaused onlyComponentRole(REPLACER_ROLE) returns (uint256) {
    _checkFullSignature(
      payout,
      premium,
      lossProb,
      expiration,
      policyData,
      params,
      quoteSignatureR,
      quoteSignatureVS,
      quoteValidUntil
    );
    return
      _replacePolicy(
        oldPolicy,
        payout,
        premium,
        lossProb,
        expiration,
        _msgSender(),
        _makeInternalId(policyData),
        _unpackParams(params)
      ).id;
  }

  /**
   * @dev This empty reserved space is put in place to allow future versions to add new
   * variables without shifting down storage in the inheritance chain.
   * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
   */
  uint256[50] private __gap;
}
