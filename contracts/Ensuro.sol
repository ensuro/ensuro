//SPDX-License-Identifier: Unlicense
pragma solidity ^0.7.3;
pragma experimental ABIEncoderV2;

import "hardhat/console.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";


// Very simple implementation of the protocol, just for testing the risk module.
contract EnsuroProtocol {
  address owner;
  uint public ocean_available;  // Available money for new policies
  uint public mcr;  // Locked money in active policies
  uint public pending_premiums;  // Premiums received in active policies not yet collected
  uint public rounding;  // premiums not distributed because of rounding error

  IERC20 public currency;

  // Risk Modules plugged into the protocol
  enum RiskModuleStatus { inactive, active, deprecated, suspended }

  struct RiskModule {
    address smart_contract;
    RiskModuleStatus status;
  }

  mapping(address=>RiskModule) risk_modules;

  struct LockedCapital {
    uint provider_id;
    uint amount;
  }

  // Active Policies
  struct Policy {
    uint premium;
    uint prize;
    uint expiration_date;
    address customer;
    LockedCapital[] locked_funds;
  }

  // This represents the active policies and it's indexed by (risk_module.address, policy_id)
  mapping(address=>mapping(uint => Policy)) public policies;

  // LiquidityProviders - the ones providing the funds to support the policies
  struct LiquidityProvider {
    uint provider_id;
    uint invested_capital;  // The capital invested initially - Never changes to track performance
    uint available_amount;  // The available amount for new policies
    uint locked_amount;     // The locked amount for new policies
    uint cashback_period;   // The cashback_period preference (seconds from asking for cashback and actual withdraw)
    uint cashback_date;     // The cashback date. Initially 0 when not yet asked (and will be considereded block.timestamp + cashback_period)
                            // when withdraw asked it's fixed to ask_date + cashback_period
    address provider;
    // uint acceptable_risk;   // relation between mean value / variance  with 3 decimals - NOT YET IMPLEMENTED
  }

  uint public provider_count;  // Always goes up - just for provider_id
  // This represents the active LPs and it's indexed by (provider_id)
  LiquidityProvider[] providers;
  mapping(uint=>uint) provider_id_2_index;  // mapping to track (provider_id => index of providers + 1);

  modifier assertBalance () {
    // Checks contract's balance is distributes in ocean_available / mcr / pending_premiums
    _;
    assert(currency.balanceOf(address(this)) >= (ocean_available + mcr + pending_premiums + rounding));
    // greater than equal instead of equal because someone can give us tokens for free!
  }

  constructor(address _currency) assertBalance {
    owner = msg.sender;
    currency = IERC20(_currency);
    ocean_available = 0;
    mcr = 0;
    pending_premiums = 0;
  }

  function destroy() external {
    require(msg.sender == owner, "Only owner can destroy");
    require((mcr + ocean_available + pending_premiums) == 0, "Can't destroy the protocol because there is locked capital");
    require(currency.balanceOf(address(this)) == 0, "Can't destroy the protocol because it has balance");
    selfdestruct(payable(owner));
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

  // function check_invariants() public {
    // ocean_available == sum(provider.available_amount for provider in providers)
    // mcr == sum(provider.locked_amount for provider in providers)
    // pending_premiums == sum(policy.premium for policy in policies)
    // provider_locked = {}
    // for policy in policies:
    //     for locked in policy.locked_funds:
    //         provider_locked[locked.provider_id] = provider_locked.get(locked.provider_id) + locked.amount
    // for provider in providers:
    //     if provider.locked_amount != provider_locked.get(provider.provider_id):
    //         raise Error()
  // }

  function invest(uint amount, uint cashback_period) public assertBalance returns (uint) {
    provider_count++;
    LiquidityProvider storage new_provider = providers.push();
    new_provider.provider_id = provider_count;
    new_provider.invested_capital = amount;
    new_provider.available_amount = amount;
    // new_provider.locked_amount should be initialized as 0
    new_provider.cashback_period = cashback_period;
    // new_provider.cashback_date should be initialized as 0
    new_provider.provider = msg.sender;

    provider_id_2_index[provider_count] = providers.length;

    require(currency.transferFrom(msg.sender, address(this), amount),
           "Transfer of currency failed must approve us for the amount");
    ocean_available += amount;
    // TODO: emit new investment event
    return provider_count; // provider_id
  }

  function new_policy(uint policy_id, uint expiration_date, uint premium, uint prize, address customer) public assertBalance {
    // The UNIQUE identifier for a given policy is (<msg.sender(the risk module smart contract>, policy_id)
    // console.log("Received new policy(rm='%s', id='%s', expires: '%s', premium = '%s', prize = '%s'", msg.sender, policy_id, expiration_date, premium, prize);
    require(block.timestamp < expiration_date, "Policy can't expire in the past");
    require(ocean_available >= (prize - premium), "Not enought free capital in the pool");
    require(prize > premium);
    require(premium > 0, "Premium must be > 0, free policies not allowed");
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
    lock_funds(policy);
    require(currency.transferFrom(customer, address(this), premium),
            "Transfer of currency failed must approve us to transfer the premium");

    // TODO: emit new policy event
  }

  function provider_cashback_date(LiquidityProvider storage provider) internal view returns (uint) {
    if (provider.cashback_date == 0)
      return (block.timestamp + provider.cashback_period);
    else
      return provider.cashback_date;
  }

  function lock_funds(Policy storage policy) internal {
    // Distributes the amount between potential liquidity providers
    uint policy_mcr = policy.prize - policy.premium;
    uint available_total = 0;

    // Iterate to calculate available amount
    for (uint i = 0; i < providers.length; i++) {
      LiquidityProvider storage provider = providers[i];
      // Filter provider by amount and cashback_date
      if ((provider.available_amount == 0) || (provider_cashback_date(provider) < policy.expiration_date))
        continue;
      available_total += provider.available_amount;
    }

    // Iterate AGAIN to distribute the policy_mcr among them
    uint to_distribute = policy_mcr;
    for (uint i = 0; i < providers.length; i++) {
      LiquidityProvider storage provider = providers[i];
      if ((provider.available_amount == 0) || (provider_cashback_date(provider) < policy.expiration_date))
        continue;
      LockedCapital memory to_lock;
      // distribute based on the weight of a fund in all available funds
      to_lock.amount = (provider.available_amount * policy_mcr) / available_total;
      if (to_lock.amount > to_distribute) // rounding effects
        to_lock.amount = to_distribute;
      if (to_lock.amount == 0)
        continue;
      // Lock
      to_lock.provider_id = provider.provider_id;
      provider.available_amount -= to_lock.amount;
      provider.locked_amount += to_lock.amount;
      policy.locked_funds.push(to_lock);

      to_distribute -= to_lock.amount;
      if (to_distribute == 0)
        break;
    }
  }

  function get_policy(address risk_module, uint policy_id) public view returns (Policy memory) {
    return policies[risk_module][policy_id];
  }

  function expire_policy(address risk_module, uint policy_id) public assertBalance {
    Policy storage policy = policies[risk_module][policy_id];
    require(policy.premium > 0, "Policy not found");
    require(policy.expiration_date <= block.timestamp, "Policy not expired yet");

    _resolve_policy(policy, false);
    delete policies[risk_module][policy_id];

    // Notify the risk_module so it updates internal state
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

    _resolve_policy(policy, customer_won);
    delete policies[msg.sender][policy_id];
  }

  function _resolve_policy(Policy storage policy, bool customer_won) internal {
    // Resolves the policy and updates affected LiquidityProviders
    uint premium_distributed = 0;
    uint policy_mcr = policy.prize - policy.premium;

    for (uint i=0; i < policy.locked_funds.length; i++) {
      LockedCapital storage fund = policy.locked_funds[i];
      LiquidityProvider storage provider = providers[provider_id_2_index[fund.provider_id] - 1];
      provider.locked_amount -= fund.amount;
      if (!customer_won) {
        uint premium_for_provider = (fund.amount * policy.premium) / policy_mcr;
        provider.available_amount += fund.amount + premium_for_provider;
        premium_distributed += premium_for_provider;
      }
    }
    if (customer_won) {
      currency.transfer(policy.customer, policy.prize);
      mcr -= policy.prize - policy.premium;
      pending_premiums -= policy.premium;
      // TODO: emit policy lost in favor of client event
    } else {
      rounding += policy.premium - premium_distributed;
      ocean_available += policy.prize;
      mcr -= policy.prize - policy.premium;
      pending_premiums -= policy.premium;
      // TODO: emit policy resolved before expiration event
    }
  }

}
