// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {Policy} from "../Policy.sol";
import {IUnderwriter} from "../interfaces/IUnderwriter.sol";
import {AccessManagedProxy} from "@ensuro/access-managed-proxy/contracts/AccessManagedProxy.sol";

/**
 * @title FullSignedUW
 * @notice Underwriter that just decodes what it receives and checks it was signed by an authorized account.
 *      The signer needs to have the specific selectors granted in the target RM
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
contract FullSignedUW is IUnderwriter {
  using Policy for Policy.PolicyData;

  bytes4 internal constant FULL_PRICE_NEW_POLICY = bytes4(keccak256("FULL_PRICE_NEW_POLICY"));
  bytes4 internal constant FULL_PRICE_REPLACE_POLICY = bytes4(keccak256("FULL_PRICE_REPLACE_POLICY"));
  bytes4 internal constant FULL_PRICE_CANCEL_POLICY = bytes4(keccak256("FULL_PRICE_CANCEL_POLICY"));
  uint256 private constant NEW_POLICY_DATA_SIZE = 5 * 32 + 7 * 32 /* Params */;
  uint256 private constant REPLACE_POLICY_DATA_SIZE = NEW_POLICY_DATA_SIZE + 12 * 32 /* Policy */;
  uint256 private constant CANCEL_POLICY_DATA_SIZE = 12 * 32 /* Policy */ + 3 * 32;
  uint256 private constant SIGNATURE_SIZE = 65;

  /**
   * @notice Thrown when the recovered signer is not authorized to perform the requested pricing operation on `rm`.
   * @dev `selector` is the permission/role identifier checked through the RM's AccessManager (one of `FULL_PRICE_*`).
   *
   * @param signer   The address recovered from the appended ECDSA signature.
   * @param selector The required permission/role id for the operation.
   */
  error UnauthorizedSigner(address signer, bytes4 selector);
  /**
   * @notice Thrown when `inputData` does not have the expected length: `payload || signature`.
   * @dev The signature is expected to be exactly 65 bytes, so `inputData.length` must be `inputSize + 65`.
   *
   * @param actual   The actual length of `inputData` in bytes.
   * @param expected The expected length of `inputData` in bytes.
   */
  error InvalidInputSize(uint256 actual, uint256 expected);

  /// @notice Thrown when the received signature doesn't match the calling rm
  error SignatureRmMismatch();

  /**
   * @notice Validates the signature appended to `inputData` and checks the recovered signer is authorized in `rm`.
   *
   * @param rm           Target RiskModule (must be an {AccessManagedProxy}).
   * @param inputData    Concatenated bytes: `payload || signature`.
   * @param inputSize    Expected length of the payload portion (without signature).
   * @param requiredRole Role/selector id required for this operation (one of the `FULL_PRICE_*` constants).
   *
   * @custom:pre `inputData` is exactly `inputSize + 65` bytes long.
   * @custom:pre `rm` is an {AccessManagedProxy} instance whose `ACCESS_MANAGER()` supports `canCall(...)`.
   *
   * @custom:throws InvalidInputSize if `inputData.length != inputSize + 65`.
   * @custom:throws (via {ECDSA-recover}) if the signature is malformed/invalid.
   * @custom:throws UnauthorizedSigner if the recovered signer is not permitted to call `rm` with `requiredRole`.
   */
  function _checkSignature(address rm, bytes calldata inputData, uint256 inputSize, bytes4 requiredRole) internal view {
    // Check length
    uint256 inputLength = inputData.length;
    if (inputLength != (inputSize + SIGNATURE_SIZE)) revert InvalidInputSize(inputLength, inputSize + SIGNATURE_SIZE);

    // Recover signer
    bytes32 inputHash = MessageHashUtils.toEthSignedMessageHash(inputData[0:inputSize]);
    address signer = ECDSA.recover(inputHash, inputData[inputSize:inputLength]);

    // Check it has the permission in the RM
    (bool immediate, ) = AccessManagedProxy(payable(rm)).ACCESS_MANAGER().canCall(signer, rm, requiredRole);
    require(immediate, UnauthorizedSigner(signer, requiredRole));
  }

  /// @inheritdoc IUnderwriter
  function priceNewPolicy(
    address rm,
    bytes calldata inputData
  )
    external
    view
    override
    returns (
      uint256 payout,
      uint256 premium,
      uint256 lossProb,
      uint40 expiration,
      uint96 internalId,
      Policy.Params memory params
    )
  {
    _checkSignature(rm, inputData, NEW_POLICY_DATA_SIZE, FULL_PRICE_NEW_POLICY);
    uint256 policyId;
    (payout, premium, lossProb, expiration, policyId, params) = abi.decode(
      inputData[0:NEW_POLICY_DATA_SIZE],
      (uint256, uint256, uint256, uint40, uint256, Policy.Params)
    );
    require(Policy.extractRiskModule(policyId) == rm, SignatureRmMismatch());
    internalId = Policy.extractInternalId(policyId);
  }

  /// @inheritdoc IUnderwriter
  function pricePolicyReplacement(
    address rm,
    bytes calldata inputData
  )
    external
    view
    override
    returns (
      Policy.PolicyData memory oldPolicy,
      uint256 payout,
      uint256 premium,
      uint256 lossProb,
      uint40 expiration,
      uint96 internalId,
      Policy.Params memory params
    )
  {
    _checkSignature(rm, inputData, REPLACE_POLICY_DATA_SIZE, FULL_PRICE_REPLACE_POLICY);
    uint256 policyId;
    (oldPolicy, payout, premium, lossProb, expiration, policyId, params) = abi.decode(
      inputData[0:REPLACE_POLICY_DATA_SIZE],
      (Policy.PolicyData, uint256, uint256, uint256, uint40, uint256, Policy.Params)
    );
    require(
      Policy.extractRiskModule(policyId) == rm && Policy.extractRiskModule(oldPolicy.id) == rm,
      SignatureRmMismatch()
    );
    internalId = Policy.extractInternalId(policyId);
  }

  /// @inheritdoc IUnderwriter
  function pricePolicyCancellation(
    address rm,
    bytes calldata inputData
  )
    external
    view
    override
    returns (
      Policy.PolicyData memory policyToCancel,
      uint256 purePremiumRefund,
      uint256 jrCocRefund,
      uint256 srCocRefund
    )
  {
    _checkSignature(rm, inputData, CANCEL_POLICY_DATA_SIZE, FULL_PRICE_CANCEL_POLICY);
    (policyToCancel, purePremiumRefund, jrCocRefund, srCocRefund) = abi.decode(
      inputData[0:CANCEL_POLICY_DATA_SIZE],
      (Policy.PolicyData, uint256, uint256, uint256)
    );
    require(address(uint160(policyToCancel.id >> 96)) == rm, SignatureRmMismatch());
    if (jrCocRefund == type(uint256).max) jrCocRefund = policyToCancel.jrCoc - policyToCancel.jrAccruedInterest();
    if (srCocRefund == type(uint256).max) srCocRefund = policyToCancel.srCoc - policyToCancel.srAccruedInterest();
  }
}
