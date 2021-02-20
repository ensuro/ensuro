//SPDX-License-Identifier: Unlicense
pragma solidity ^0.7.3;

import "hardhat/console.sol";
import "contracts/Ensuro.sol";

/*
* EnsuroRoulette
* Risk module that accepts policies betting on a given number (0-36), validates prize/premium relation
* and sends the policy to the protocol.
* Later swipes the roulette and resolves the policy (win or not) and sends the resolution to the protocol.
*/

contract EnsuroRoulette {
  address owner;
  EnsuroProtocol public protocol;
  uint public policy_count;  // Always goes up - just for policy_id
  mapping(uint=>uint) roulette_values; // policy_id => (roulette_value + 1) (so 0 is invalid==not-found)

  constructor(address _protocol) {
    protocol = EnsuroProtocol(_protocol);
    owner = msg.sender;
    policy_count = 0;
  }

  function new_policy(uint roulette_value, uint premium, uint prize, uint expiration_date) external returns (uint) {
    // Accepts the policy, validates the calculation
    require(roulette_value <= 36, "Allowed roulette values are from 0 to 36");
    require(premium * 36 == prize, "Prize must be 36 times the premium");
    require(protocol.currency().allowance(msg.sender, address(protocol)) >= premium, "You must allow ENSURO to transfer the premium");
    policy_count++;
    uint policy_id = policy_count;
    protocol.new_policy(policy_id, expiration_date, premium, prize, msg.sender);
    roulette_values[policy_id] = roulette_value + 1;
    return policy_id;
  }

  function swipe_roulette(uint policy_id, uint roulette_result) external returns (bool) {
    // TODO: This method must be called by randomness oracle
    uint roulette_value = roulette_values[policy_id];
    require(roulette_value != 0, "Policy not found or already expired");
    bool result = (roulette_value - 1) == roulette_result;
    protocol.resolve_policy(policy_id, result);
    return result;
  }

  function policy_expired(uint policy_id) external {
    require(msg.sender == address(protocol), "Only protocol can expire policies");
    delete roulette_values[policy_id];
  }

  function get_roulette_value(uint policy_id) external view returns (uint) {
    uint ret = roulette_values[policy_id];
    if (ret == 0)
      return 9999;
    else
      return ret - 1;
  }

}
