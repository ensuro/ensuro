//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.1;

import "hardhat/console.sol";

// Very simple implementation of the protocol, just for testing the risk module. 
contract EnsuroProtocol {
  address payable owner;
  uint public ocean;
  uint public mcr;
  uint public pending_premiums;


  struct Policy {
    uint premium;
    uint prize;
    uint expiration_date;
    address payable customer;
  }

  mapping(address=>mapping(uint => Policy)) policies;

  modifier assertBalance () {
    // Checks contract's balance is distributes in ocean / mcr / pending_premiums
    _;
    assert(address(this).balance == (ocean + mcr + pending_premiums));
  }

  constructor() payable assertBalance {
    owner = payable(msg.sender);
    ocean = msg.value;
    mcr = 0;
    pending_premiums = 0;
  }

  function destroy() external {
    require(msg.sender == owner, "Only owner can destroy");
    require(mcr == 0, "Can't destroy the protocol because there is locked capital");
    selfdestruct(owner);
  }

  function invest() public payable assertBalance {
    ocean += msg.value;
    // TODO: emit new investment event
  }

  function new_policy(uint policy_id, uint expiration_date, uint premium, uint prize, address payable customer) public payable assertBalance{
    // console.log("Received new policy(rm='%s', id='%s', expires: '%s', premium = '%s', prize = '%s'", msg.sender, policy_id, expiration_date, premium, prize);
    require(block.timestamp < expiration_date, "Policy can't expire in the past");
    require(ocean >= (prize - premium), "Not enought free capital in the pool");
    require(prize > premium);
    require(premium > 0, "Premium must be > 0, free policies not allowed");
    require(msg.value == premium, "Show me the money");
    // TODO: check msg.sender is authorized and active risk_module

    ocean -= prize - premium;
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
    ocean += policy.prize;
    mcr -= policy.prize - policy.premium;
    pending_premiums -= policy.premium;
    delete policies[risk_module][policy_id];
    (bool expired_call, ) = address(risk_module).call(abi.encodeWithSignature("policy_expired(uint256)", policy_id));
    if (!expired_call)
      revert("Call to risk module notifying expiration failed");
    // TODO: emit policy expired event
  }

  function resolve_policy(uint policy_id, bool customer_won) public assertBalance {
    Policy storage policy = policies[msg.sender][policy_id];
    require(policy.premium > 0, "Policy not found");
    
    if (customer_won) {
      policy.customer.transfer(policy.prize);
      mcr -= policy.prize - policy.premium;
      pending_premiums -= policy.premium;
      // TODO: emit policy lost in favor of client event
    } else {
      ocean += policy.prize;
      mcr -= policy.prize - policy.premium;
      pending_premiums -= policy.premium;
      // TODO: emit policy resolved before expiration event
    }
    delete policies[msg.sender][policy_id];
  }

}
