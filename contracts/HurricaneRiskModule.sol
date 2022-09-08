// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {IPolicyPool} from "../interfaces/IPolicyPool.sol";
import {RiskModule} from "./RiskModule.sol";
import {Policy} from "./Policy.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/**
 * @title Hurricane Risk Module
 * @dev Risk Module for hurricane policies. _treeRoot is the root of a hash tree with all the combinations of zipCode
*  and lossProb allowed.
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */

contract HurricaneRiskModule is RiskModule {
  bytes32 public constant PRICE_ADMIN_ROLE = keccak256("PRICE_ADMIN_ROLE");
  bytes32 public constant PRICER_ROLE = keccak256("PRICER_ROLE");
  bytes32 public constant RESOLVER_ROLE = keccak256("RESOLVER_ROLE");

  bytes32 internal _treeRoot;

  /// @custom:oz-upgrades-unsafe-allow constructor
  // solhint-disable-next-line no-empty-blocks
  constructor(IPolicyPool policyPool_) RiskModule(policyPool_) {}

  /**
   * @dev Initializes the RiskModule
   * @param name_ Name of the Risk Module
   * @param scrPercentage_ Solvency Capital Requirement percentage, to calculate
                          capital requirement as % of (payout - premium)  (in ray)
   * @param ensuroFee_ % of premium that will go for Ensuro treasury (in ray)
   * @param scrInterestRate_ cost of capital (in ray)
   * @param maxScrPerPolicy_ Max SCR to be allocated to this module (in wad)
   * @param scrLimit_ Max SCR to be allocated to this module (in wad)
   * @param wallet_ Address of the RiskModule provider
   */
  function initialize(
    string memory name_,
    uint256 scrPercentage_,
    uint256 ensuroFee_,
    uint256 scrInterestRate_,
    uint256 maxScrPerPolicy_,
    uint256 scrLimit_,
    address wallet_,
    bytes32 treeRoot_
  ) public initializer {
    __RiskModule_init(
      name_,
      scrPercentage_,
      ensuroFee_,
      scrInterestRate_,
      maxScrPerPolicy_,
      scrLimit_,
      wallet_
    );
    _treeRoot = treeRoot_;
  }

  function setTreeRoot(bytes32 treeRoot_) external onlyRole(PRICE_ADMIN_ROLE) {
    _treeRoot = treeRoot_;
  }

  function treeRoot() external view returns (bytes32) {
    return _treeRoot;
  }

  function newPolicy(
    uint256 payout,
    uint256 premium,
    uint256 lossProb,
    uint32 zipCode,
    bytes32[] memory proof,
    uint40 expiration,
    address customer,
    uint96 internalId
  ) external onlyRole(PRICER_ROLE) returns (uint256) {
    bytes32 leafHash = keccak256(abi.encodePacked(zipCode, lossProb));
    require(MerkleProof.verify(proof, _treeRoot, leafHash), "Invalid zipCode/lossProb combination");
    uint256 policyId = _newPolicy(payout, premium, lossProb, expiration, customer, internalId).id;
    return policyId;
  }

  function resolvePolicy(Policy.PolicyData calldata policy, uint256 payout)
    external
    onlyRole(RESOLVER_ROLE)
    whenNotPaused
  {
    _policyPool.resolvePolicy(policy, payout);
  }

  function resolvePolicyFullPayout(Policy.PolicyData calldata policy, bool customerWon)
    external
    onlyRole(RESOLVER_ROLE)
    whenNotPaused
  {
    _policyPool.resolvePolicyFullPayout(policy, customerWon);
  }
}
