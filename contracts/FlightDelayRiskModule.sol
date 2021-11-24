// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {IPolicyPool} from "../interfaces/IPolicyPool.sol";
import {RiskModule} from "./RiskModule.sol";
import {Chainlink} from "@chainlink/contracts/src/v0.8/Chainlink.sol";
import {ChainlinkClientUpgradeable} from "./dependencies/ChainlinkClientUpgradeable.sol";

/**
 * @title Flight Delay Risk Module
 * @dev Risk Module that resolves policy based in actualarrivaldate of flight
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
contract FlightDelayRiskModule is RiskModule, ChainlinkClientUpgradeable {
  using Chainlink for Chainlink.Request;

  bytes32 public constant PRICER_ROLE = keccak256("PRICER_ROLE");
  bytes32 public constant ORACLE_ADMIN_ROLE = keccak256("ORACLE_ADMIN_ROLE");
  // Multiplier to calculate expiration = expectedArrival + tolerance + delayTime * DELAY_EXPIRATION_TIMES
  uint40 public constant DELAY_EXPIRATION_TIMES = 5;

  struct PolicyData {
    string flight;
    uint40 departure;
    uint40 expectedArrival;
    uint40 tolerance;
  }

  struct OracleParams {
    address oracle;
    uint96 delayTime;
    uint256 fee;
    bytes16 dataJobId;
    bytes16 sleepJobId;
  }

  OracleParams internal _oracleParams;

  mapping(bytes32 => uint256) internal _pendingQueries;
  mapping(uint256 => PolicyData) internal _policies;

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
   * @param sharedCoverageMinPercentage_ minimal % of SCR that must be covered by the RM
   * @param linkToken_ Address of ChainLink LINK token
   * @param oracleParams_ Parameters of the Oracle
   */
  function initialize(
    string memory name_,
    uint256 scrPercentage_,
    uint256 ensuroFee_,
    uint256 scrInterestRate_,
    uint256 maxScrPerPolicy_,
    uint256 scrLimit_,
    address wallet_,
    uint256 sharedCoverageMinPercentage_,
    address linkToken_,
    OracleParams memory oracleParams_
  ) public initializer {
    __RiskModule_init(
      name_,
      scrPercentage_,
      ensuroFee_,
      scrInterestRate_,
      maxScrPerPolicy_,
      scrLimit_,
      wallet_,
      sharedCoverageMinPercentage_
    );
    __ChainlinkClient_init();
    __FlightDelayRiskModule_init_unchained(linkToken_, oracleParams_);
  }

  // solhint-disable-next-line func-name-mixedcase
  function __FlightDelayRiskModule_init_unchained(
    address linkToken_,
    OracleParams memory oracleParams_
  ) internal initializer {
    setChainlinkToken(linkToken_);
    _oracleParams = oracleParams_;
  }

  function setOracleParams(OracleParams memory newParams) external onlyRole(ORACLE_ADMIN_ROLE) {
    _oracleParams = newParams;
  }

  function oracleParams() external view returns (OracleParams memory) {
    return _oracleParams;
  }

  /**
   * @dev Creates a new policy
   * @param flight Flight Number as String (ex: NAX105)
   * @param departure Departure in epoch seconds (ex: 1631817600)
   * @param expectedArrival Expected arrival in epoch seconds (ex: 1631824800)
   * @param tolerance In seconds, the tolerance margin after expectedArrival before trigger the policy
   * @param payout Payout for customer in case policy is triggered
   * @param premium Premium the customer pays
   * @param lossProb Probability of policy being triggered
   * @param customer Customer address (to take premium from and send payout)
   */
  function newPolicy(
    string memory flight,
    uint40 departure,
    uint40 expectedArrival,
    uint40 tolerance,
    uint256 payout,
    uint256 premium,
    uint256 lossProb,
    address customer
  ) external onlyRole(PRICER_ROLE) returns (uint256) {
    require(expectedArrival > block.timestamp, "expectedArrival can't be in the past");
    require(departure != 0 && expectedArrival > departure, "expectedArrival <= departure!");
    uint40 expiration = expectedArrival +
      tolerance +
      uint40(_oracleParams.delayTime) *
      DELAY_EXPIRATION_TIMES;
    uint256 policyId = _newPolicy(payout, premium, lossProb, expiration, customer);
    PolicyData storage policy = _policies[policyId];
    policy.flight = flight;
    policy.departure = departure;
    policy.expectedArrival = expectedArrival;
    policy.tolerance = tolerance;

    uint256 until = expectedArrival + tolerance + uint256(_oracleParams.delayTime);
    _chainlinkRequest(policyId, policy, until);
    return policyId;
  }

  function _chainlinkRequest(
    uint256 policyId,
    PolicyData storage policy,
    uint256 until
  ) internal {
    // request takes a JobID, a callback address, and callback function as input
    Chainlink.Request memory req = buildChainlinkRequest(
      until == 0 ? _oracleParams.dataJobId : _oracleParams.sleepJobId,
      address(this),
      this.fulfill.selector
    );
    req.add("flight", policy.flight);
    req.add("endpoint", "actualarrivaldate");
    req.addUint("departure", policy.departure);
    if (until > 0) {
      req.addUint("until", until);
    }

    // Sends the request with the amount of payment specified to the oracle
    // (results will arrive with the callback = later)
    bytes32 queryId = sendChainlinkRequestTo(_oracleParams.oracle, req, _oracleParams.fee);
    _pendingQueries[queryId] = policyId;
  }

  /**
   * @dev Forces the resolution of the policy (without waiting Chainlink scheduled on creation)
   * @param policyId The id of the policy previously created (in newPolicy)
   */
  function resolvePolicy(uint256 policyId) external onlyRole(PRICER_ROLE) returns (uint256) {
    PolicyData storage policy = _policies[policyId];
    require(policy.expectedArrival != 0, "Policy not found!");
    _chainlinkRequest(policyId, policy, 0);
    return policyId;
  }

  function fulfill(bytes32 queryId, int256 actualArrivalDate)
    public
    recordChainlinkFulfillment(queryId)
  {
    uint256 policyId = _pendingQueries[queryId];
    require(policyId != 0, "queryId not found!");
    PolicyData storage policy = _policies[policyId];

    if (actualArrivalDate == 0) {
      if (block.timestamp > (policy.expectedArrival + policy.tolerance)) {
        // Treat as arrived after tolerance
        actualArrivalDate = int256(uint256((policy.expectedArrival + policy.tolerance) + 1));
      } else {
        // Not arrived yet
        return;
      }
    }
    bool customerWon = (actualArrivalDate <= 0 || // cancelled
      uint256(actualArrivalDate) > uint256(policy.expectedArrival + policy.tolerance)); // arrived after tolerance

    _policyPool.resolvePolicyFullPayout(policyId, customerWon);
  }
}
