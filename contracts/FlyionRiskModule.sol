// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {IPolicyPool} from "../interfaces/IPolicyPool.sol";
import {RiskModule} from "./RiskModule.sol";
import {Chainlink} from "@chainlink/contracts/src/v0.8/Chainlink.sol";
import {ChainlinkClientUpgradeable} from "./dependencies/ChainlinkClientUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title Flyion Risk Module
 * @dev Risk Module that resolves policy based in
 * @author Ensuro
 */

contract FlyionRiskModule is RiskModule, ChainlinkClientUpgradeable {
  using Chainlink for Chainlink.Request;

  bytes32 public constant PRICER_ROLE = keccak256("PRICER_ROLE");
  bytes32 public constant ORACLE_ADMIN_ROLE = keccak256("ORACLE_ADMIN_ROLE");

  //replace it by the ones at the top for each new contract
  // address public constant chainlinkOracleAddr = 0x2f90A6D021db21e1B2A077c5a37B3C7E75D15b7e;
  // solhint-disable-next-line const-name-snakecase
  address public constant chainlinkOracleAddr = 0x0a908660e9319413a16978fA48dF641b4bf37C54;
  address private constant LINK_TOKEN = 0x326C977E6efc84E512bB9C30f76E30c160eD06FB;
  // solhint-disable-next-line const-name-snakecase
  bytes32 public constant dataJobId =
    0x2fb0c3a36f924e4ab43040291e14e0b700000000000000000000000000000000;
  // solhint-disable-next-line const-name-snakecase
  bytes32 public constant sleepJobId =
    0xb93734c968d741a4930571586f30d0e000000000000000000000000000000000;
  uint256 public constant ORACLE_DELAY_TIME = 600;
  uint256 internal oracleFee; // chainlink payment

  struct FlyionPolicyData {
    string flight;
    uint40 departure;
    uint40 expectedArrival;
    uint40 tolerance;
  }

  mapping(bytes32 => uint256) internal _pendingQueries;
  mapping(uint256 => FlyionPolicyData) internal _flyionPolicies;

  event ChainlinkScheduled(uint256 indexed policyId, bytes32 queryId, uint256 until);
  event ChainlinkFulfilledDebug(
    uint256 indexed policyId,
    bytes32 queryId,
    int256 actualArrivalDate
  );

  /**
   * @dev Initializes the RiskModule
   * @param name_ Name of the Risk Module
   * @param policyPool_ The address of the Ensuro PolicyPool where this module is plugged
   * @param scrPercentage_ Solvency Capital Requirement percentage, to calculate
                          capital requirement as % of (payout - premium)  (in ray)
   * @param ensuroFee_ % of premium that will go for Ensuro treasury (in ray)
   * @param scrInterestRate_ cost of capital (in ray)
   * @param maxScrPerPolicy_ Max SCR to be allocated to this module (in wad)
   * @param scrLimit_ Max SCR to be allocated to this module (in wad)
   * @param wallet_ Address of the RiskModule provider
   * @param sharedCoverageMinPercentage_ minimal % of SCR that must be covered by the RM
   */
  function initialize(
    string memory name_,
    IPolicyPool policyPool_,
    uint256 scrPercentage_,
    uint256 ensuroFee_,
    uint256 scrInterestRate_,
    uint256 maxScrPerPolicy_,
    uint256 scrLimit_,
    address wallet_,
    uint256 sharedCoverageMinPercentage_
  ) public initializer {
    __RiskModule_init(
      name_,
      policyPool_,
      scrPercentage_,
      ensuroFee_,
      scrInterestRate_,
      maxScrPerPolicy_,
      scrLimit_,
      wallet_,
      sharedCoverageMinPercentage_
    );
    __ChainlinkClient_init();
    __FlyionRiskModule_init_unchained();
  }

  // solhint-disable-next-line func-name-mixedcase
  function __FlyionRiskModule_init_unchained() internal initializer {
    setChainlinkToken(LINK_TOKEN);
    oracleFee = 10e16; // 0.1 LINK
  }

  function setOracleFee(uint256 newOrableFee) external onlyRole(ORACLE_ADMIN_ROLE) {
    oracleFee = newOrableFee;
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
   * @param expiration Policy expiration (in epoch seconds)
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
    uint40 expiration,
    address customer
  ) external onlyRole(PRICER_ROLE) returns (uint256) {
    require(expectedArrival != 0, "expectedArrival can't be zero");
    uint256 policyId = _newPolicy(payout, premium, lossProb, expiration, customer);

    // request takes a JobID, a callback address, and callback function as input
    Chainlink.Request memory req = buildChainlinkRequest(
      sleepJobId,
      address(this),
      this.fulfill.selector
    );
    req.add("flight", flight);
    req.addUint("departure", departure);
    uint256 until = expectedArrival + tolerance + ORACLE_DELAY_TIME;
    if (until < (block.timestamp + 120)) until = block.timestamp + 120;
    req.addUint("until", until);

    // Sends the request with the amount of payment specified to the oracle (results will arrive with the callback = later)
    bytes32 queryId = sendChainlinkRequestTo(chainlinkOracleAddr, req, oracleFee);
    FlyionPolicyData storage policy = _flyionPolicies[policyId];
    policy.flight = flight;
    policy.departure = departure;
    policy.expectedArrival = expectedArrival;
    policy.tolerance = tolerance;
    _pendingQueries[queryId] = policyId;
    emit ChainlinkScheduled(policyId, queryId, until); // DEBUG event - can be removed later
    return policyId;
  }

  /**
   * @dev Forces the resolution of the policy (without waiting Chainlink scheduled on creation)
   * @param policyId The id of the policy previously created (in newPolicy)
   */
  function resolvePolicy(uint256 policyId) external onlyRole(PRICER_ROLE) returns (uint256) {
    FlyionPolicyData storage policy = _flyionPolicies[policyId];
    require(policy.expectedArrival != 0, "Policy not found!");
    // request takes a JobID, a callback address, and callback function as input
    Chainlink.Request memory req = buildChainlinkRequest(
      dataJobId,
      address(this),
      this.fulfill.selector
    );
    req.add("flight", policy.flight);
    req.addUint("departure", policy.departure);

    // Sends the request with the amount of payment specified to the oracle (results will arrive with the callback = later)
    bytes32 queryId = sendChainlinkRequestTo(chainlinkOracleAddr, req, oracleFee);
    emit ChainlinkScheduled(policyId, queryId, 0); // DEBUG event - can be removed later
    _pendingQueries[queryId] = policyId;
    return policyId;
  }

  function fulfill(bytes32 queryId, int256 actualArrivalDate)
    public
    recordChainlinkFulfillment(queryId)
  {
    uint256 policyId = _pendingQueries[queryId];
    require(policyId != 0, "queryId not found!");
    FlyionPolicyData storage policy = _flyionPolicies[policyId];
    emit ChainlinkFulfilledDebug(policyId, queryId, actualArrivalDate);

    if (actualArrivalDate == 0) {
      // Shouldn't happen because we take field estimatedarrivaltime
      // TODO: Don't know what it means...
      // revert("actualArrivalDate == 0, don't know what it means");
      // request takes a JobID, a callback address, and callback function as input
      // If sleepJobId not working, reschedule request
      Chainlink.Request memory req = buildChainlinkRequest(
        dataJobId,
        address(this),
        this.fulfill.selector
      );
      req.add("flight", policy.flight);
      req.addUint("departure", policy.departure);

      // Sends the request with the amount of payment specified to the oracle (results will arrive with the callback = later)
      queryId = sendChainlinkRequestTo(chainlinkOracleAddr, req, oracleFee);
      emit ChainlinkScheduled(policyId, queryId, 0); // DEBUG event - can be removed later
      _pendingQueries[queryId] = policyId;
      return;
    }
    bool customerWon = (actualArrivalDate <= 0 || // cancelled
      uint256(actualArrivalDate) > uint256(policy.expectedArrival + policy.tolerance)); // arrived after tolerance

    _policyPool.resolvePolicyFullPayout(policyId, customerWon);
  }

  // TODO: remove later, now useful to recover LINK
  function destroy() external onlyRole(DEFAULT_ADMIN_ROLE) {
    IERC20 linkToken = IERC20(chainlinkTokenAddress());
    linkToken.transfer(msg.sender, linkToken.balanceOf(address(this)));
  }
}
