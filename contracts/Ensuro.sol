//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.1;

import "hardhat/console.sol";

// Very simple implementation of the protocol, just for testing the risk module. 
contract EnsuroProtocol {
  address payable owner;
  uint public ocean_available;  // Available money for new policies
  uint public mcr;  // Locked money in active policies
  uint public pending_premiums;  // Premiums received in active policies not yet collected

  struct Policy {
    uint premium;
    uint prize;
    uint expiration_date;
    address payable customer;
  }

  enum RiskModuleStatus { inactive, active, deprecated, suspended }

  struct RiskModule {
    address smart_contract;
    RiskModuleStatus status;
  }

  mapping(address=>RiskModule) risk_modules;

  // This represents the active policies and it's indexed by (risk_module.address, policy_id)
  mapping(address=>mapping(uint => Policy)) policies;

  modifier assertBalance () {
    // Checks contract's balance is distributes in ocean_available / mcr / pending_premiums
    _;
    assert(address(this).balance == (ocean_available + mcr + pending_premiums));
  }

  constructor() payable assertBalance {
    owner = payable(msg.sender);
    ocean_available = msg.value;
    mcr = 0;
    pending_premiums = 0;
  }

  function destroy() external {
    require(msg.sender == owner, "Only owner can destroy");
    require(mcr == 0, "Can't destroy the protocol because there is locked capital");
    selfdestruct(owner);
  }

  function add_risk_module(address risk_module, RiskModuleStatus status) public {
    require(msg.sender == owner, "Only the owner can change the risk modules");
    RiskModule storage module = risk_modules[risk_module];
    module.smart_contract = risk_module;
    module.status = status;
  }

  function get_risk_module_status(address risk_module) public view returns (RiskModule memory) {
    return risk_modules[risk_module];
  }

  function invest() public payable assertBalance {
    ocean_available += msg.value;
    // TODO: emit new investment event
  }

  function new_policy(uint policy_id, uint expiration_date, uint premium, uint prize, address payable customer) public payable assertBalance {
    // The UNIQUE identifier for a given policy is (<msg.sender(the risk module smart contract>, policy_id)
    // console.log("Received new policy(rm='%s', id='%s', expires: '%s', premium = '%s', prize = '%s'", msg.sender, policy_id, expiration_date, premium, prize);
    require(block.timestamp < expiration_date, "Policy can't expire in the past");
    require(ocean_available >= (prize - premium), "Not enought free capital in the pool");
    require(prize > premium);
    require(premium > 0, "Premium must be > 0, free policies not allowed");
    require(msg.value == premium, "Show me the money");
    require(risk_modules[msg.sender].status == RiskModuleStatus.active, "Risk is not active");
    // TODO: check msg.sender is authorized and active risk_module

    ocean_available -= prize - premium;
    mcr += prize - premium;
    pending_premiums += premium;
    Policy storage policy = policies[msg.sender][policy_id];
    policy.premium = premium;
    policy.prize = prize;
    policy.expiration_date = expiration_date;
    policy.customer = customer;
    // TODO: emit new policy event
  }

  function get_policy(address risk_module, uint policy_id) public view returns (Policy memory) {
    return policies[risk_module][policy_id];
  }

  function expire_policy(address risk_module, uint policy_id) public assertBalance {
    Policy storage policy = policies[risk_module][policy_id];
    require(policy.premium > 0, "Policy not found");
    require(policy.expiration_date <= block.timestamp, "Policy not expired yet");
    ocean_available += policy.prize;
    mcr -= policy.prize - policy.premium;
    pending_premiums -= policy.premium;
    delete policies[risk_module][policy_id];
    (bool expired_call, ) = address(risk_module).call(abi.encodeWithSignature("policy_expired(uint256)", policy_id));
    if (!expired_call)
      revert("Call to risk module notifying expiration failed");
    // TODO: emit policy expired event
  }

  function resolve_policy(uint policy_id, bool customer_won) public assertBalance {
    // This function MUST be called from the risk module smart contract (msg.sender)
    // We TRUST the risk module on the result of the policy
    Policy storage policy = policies[msg.sender][policy_id];
    require(policy.premium > 0, "Policy not found");
    
    if (customer_won) {
      policy.customer.transfer(policy.prize);
      mcr -= policy.prize - policy.premium;
      pending_premiums -= policy.premium;
      // TODO: emit policy lost in favor of client event
    } else {
      ocean_available += policy.prize;
      mcr -= policy.prize - policy.premium;
      pending_premiums -= policy.premium;
      // TODO: emit policy resolved before expiration event
    }
    delete policies[msg.sender][policy_id];
  }

}
