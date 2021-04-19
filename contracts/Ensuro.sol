//SPDX-License-Identifier: Unlicense
pragma solidity ^0.7.3;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/EnumerableSet.sol";
// import "hardhat/console.sol";


// Very simple implementation of the protocol, just for testing the risk module.
contract EnsuroProtocol {
  using EnumerableSet for EnumerableSet.AddressSet;
  using EnumerableSet for EnumerableSet.UintSet;

  uint constant MAX_PERCENTAGE = 100000;

  address owner;
  uint public ocean_available;  // Available money for new policies
  uint public mcr;  // Locked money in active policies
  uint public pending_premiums;  // Premiums received in active policies not yet collected

  IERC20 public currency;

  // Risk Modules plugged into the protocol
  enum RiskModuleStatus { inactive, active, deprecated, suspended }

  struct RiskModule {  // percentages all 100 based with 3 digits.
    address smart_contract;   // address of the Smart Contract that sends new policies and resolves policies
    address owner;            // "owner" of the RiskModule who can teak some parameters
    RiskModuleStatus status;

    uint max_mcr_per_policy;  // max amount to cover, per policy
    uint mcr_limit;           // max amount to cover - all policies
    uint total_mcr;           // current mcr
    uint mcr_percentage;      // MCR = mcr_percentage * (payout - premium) / MAX_PERCENTAGE

    uint ensuro_share;        // percentage of the premium that is collected by the Ensuro
    uint premium_share;       // percentage of the premium that is collected by the risk_module owner.
                              // This is how risk_module owner makes profit - Only changed by EnsuroProtocol.owner

    // shared coverage: part of each policy is covered with capital of risk module owner.
    address wallet;      // wallet to transfer from the shared coverage amount - Can be changed by RiskModule.owner
    uint shared_coverage_percentage;     // actual percentage covered by wallet - Can be changed by RiskModule.owner
    uint shared_coverage_min_percentage; // minimal percentage covered by wallet - Only changed by EnsuroProtocol.owner
    // shared_coverage_percentage >= shared_coverage_min_percentage

    EnumerableSet.UintSet policy_ids;
  }

  mapping(address=>RiskModule) risk_modules;
  EnumerableSet.AddressSet private active_risk_modules;

  struct LockedCapital {
    uint provider_id;
    uint amount;
  }

  // Active Policies
  struct Policy {
    uint premium;
    uint payout;
    uint rm_coverage;     // amount of the payout covered by risk_module
    uint mcr;
    uint expiration_date;
    address customer;
    LockedCapital[] locked_funds;  // sum(locked_funds.amount) == (mcr)
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
    bool asap;              // Indicates if funds have to be transfered back As Soon As Possible or on cashback_date
    // uint acceptable_risk;   // relation between mean value / variance with 3 decimals - NOT YET IMPLEMENTED
  }

  uint public provider_count;  // Always goes up - just for provider_id
  // This represents the active LPs and it's indexed by (provider_id)
  mapping(uint=>LiquidityProvider) providers;
  EnumerableSet.UintSet provider_ids;

  // LP events
  event NewLiquidityProvider (
    address indexed provider,
    uint provider_id,
    uint capital,
    uint cashback_period
  );

  event LiquidityProviderDeleted (
    address indexed provider,
    uint indexed provider_id
  );

  event LiquidityProviderWithdrawal (
    address indexed provider,
    uint indexed provider_id,
    uint amount
  );

  // Policy events
  event NewPolicy (
    address indexed risk_module,
    uint indexed policy_id,
    address indexed customer,
    uint payout,
    uint premium,
    uint mcr,
    uint expiration_date
  );

  event PolicyExpired (
    address indexed risk_module,
    uint indexed policy_id,
    address indexed customer,
    uint payout,
    uint premium,
    uint mcr,
    uint expiration_date
  );

  event PolicyResolved (
    address indexed risk_module,
    uint indexed policy_id,
    address indexed customer,
    bool customer_won,
    uint payout,
    uint premium,
    uint mcr
  );

  event RiskModuleStatusChanged (
    address indexed smart_contract,
    RiskModuleStatus indexed status
  );

  // Scheduling events
  event ScheduleWithdraw (
    uint indexed provider_id,
    uint cashback_date
  );

  event SchedulePolicyExpire (
    address indexed risk_module,
    uint indexed policy_id,
    uint expiration_date
  );

  modifier assertBalance () {
    // Checks contract's balance is distributes in ocean_available / mcr / pending_premiums
    _;
    assert(currency.balanceOf(address(this)) >= (ocean_available + mcr + pending_premiums));
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

  function add_risk_module(address smart_contract, address module_owner, RiskModuleStatus status, uint max_mcr_per_policy,
                           uint mcr_limit, uint mcr_percentage, uint premium_share,
                           address wallet, uint shared_coverage_min_percentage) public {
    /* this function adds or sets risk module parameters */
    require(msg.sender == owner, "Only the owner can change the risk modules");
    require(mcr_percentage <= MAX_PERCENTAGE);
    require(premium_share <= MAX_PERCENTAGE);
    require(shared_coverage_min_percentage <= MAX_PERCENTAGE);

    RiskModule storage module = risk_modules[smart_contract];
    module.smart_contract = smart_contract;
    module.status = status;
    module.owner = module_owner;
    module.max_mcr_per_policy = max_mcr_per_policy;
    require(module.total_mcr <= mcr_limit, "MCR limit under the current MCR for the module");
    module.mcr_limit = mcr_limit;
    module.mcr_percentage = mcr_percentage;
    module.premium_share = premium_share;
    module.wallet = wallet;
    module.shared_coverage_min_percentage = shared_coverage_min_percentage;
    if (module.shared_coverage_percentage < shared_coverage_min_percentage)
      module.shared_coverage_percentage = shared_coverage_min_percentage;
    active_risk_modules.add(smart_contract);
    emit RiskModuleStatusChanged(smart_contract, status);
  }

  function change_shared_coverage(address _risk_module, uint new_shared_coverage_percentage) public {
    RiskModule storage module = risk_modules[_risk_module];
    require(msg.sender == module.owner, "Only module owner can tweak this parameter");
    require(new_shared_coverage_percentage >= module.shared_coverage_min_percentage,
            "Must be greater or equal to shared_coverage_min_percentage");
    module.shared_coverage_percentage = new_shared_coverage_percentage;
  }

  function get_risk_module_status(address risk_module) public view returns (RiskModuleStatus) {
    return risk_modules[risk_module].status;
  }

  function get_provider(uint provider_id) public view returns (LiquidityProvider memory) {
    return providers[provider_id];
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
    /* Invest a given `amount` in the pool with `cashback_period` (seconds) indicating the max time can
       wait for withdrawal after asking for it
    */
    provider_count++;
    LiquidityProvider storage new_provider = providers[provider_count];
    new_provider.provider_id = provider_count;
    new_provider.invested_capital = amount;
    new_provider.available_amount = amount;
    // new_provider.locked_amount should be initialized as 0
    new_provider.cashback_period = cashback_period;
    // new_provider.cashback_date should be initialized as 0
    new_provider.provider = msg.sender;
    new_provider.asap = false;

    provider_ids.add(provider_count);

    require(currency.transferFrom(msg.sender, address(this), amount),
           "Transfer of currency failed must approve us for the amount");
    ocean_available += amount;
    emit NewLiquidityProvider(msg.sender, provider_count, amount, cashback_period);
    return provider_count; // provider_id
  }

  function withdraw(uint provider_id, bool asap) public assertBalance returns (uint) {
    LiquidityProvider storage provider = providers[provider_id];
    require(provider.provider_id > 0, "Provider not found");
    if (provider.cashback_date == 0 || block.timestamp < provider.cashback_date)
      require(provider.provider == msg.sender, "You are not authorized to manage this funds");
    // else anyone is authorized to call this function to wake up us to do the withdrawal

    if (provider.cashback_date == 0)
      provider.cashback_date = block.timestamp + provider.cashback_period;
    else if (provider.cashback_date < block.timestamp)
      asap = true;

    provider.asap = asap;

    if (asap)
      return transfer_available_funds_to_provider(provider);
    else {
      emit ScheduleWithdraw(provider_id, provider.cashback_date);
      return 0;
    }
  }

  function transfer_available_funds_to_provider(LiquidityProvider storage provider) internal returns (uint) {
    if (provider.available_amount == 0 && provider.locked_amount > 0)
      return 0;
    require(currency.transfer(provider.provider, provider.available_amount));
    uint transferred = provider.available_amount;
    ocean_available -= transferred;
    emit LiquidityProviderWithdrawal(provider.provider, provider.provider_id, provider.available_amount);
    provider.available_amount = 0;

    if (provider.locked_amount == 0) {
      // Delete provider
      provider_ids.remove(provider.provider_id);
      delete providers[provider.provider_id];
      emit LiquidityProviderDeleted(provider.provider, provider.provider_id);
    }
    return transferred;
  }

  function new_policy(uint policy_id, uint expiration_date, uint premium, uint payout, address customer) public assertBalance {
    // The UNIQUE identifier for a given policy is (<msg.sender(the risk module smart contract>, policy_id)
    require(block.timestamp < expiration_date, "Policy can't expire in the past");
    require(payout > premium);
    require(premium > 0, "Premium must be > 0, free policies not allowed");
    RiskModule storage risk_module = risk_modules[msg.sender];
    require(risk_module.status == RiskModuleStatus.active, "Risk is not active");
    uint rm_coverage = risk_module.shared_coverage_percentage * payout / MAX_PERCENTAGE;
    uint rm_premium = premium * rm_coverage / payout;
    uint policy_mcr = ((payout - rm_coverage) - (premium - rm_premium)) * risk_module.mcr_percentage / MAX_PERCENTAGE;
    require(policy_mcr <= risk_module.max_mcr_per_policy, "MCR bigger than MAX_MCR for this module");
    require(ocean_available >= policy_mcr, "Not enought free capital in the pool");

    ocean_available -= policy_mcr;
    mcr += policy_mcr;
    risk_module.total_mcr += policy_mcr;
    require(risk_module.total_mcr <= risk_module.mcr_limit, "This risk module doesn't have enought limit to cover this policy");
    risk_module.policy_ids.add(policy_id);

    pending_premiums += premium;
    Policy storage policy = policies[msg.sender][policy_id];
    policy.premium = premium;
    policy.mcr = policy_mcr;
    policy.payout = payout;
    policy.rm_coverage = rm_coverage;
    policy.expiration_date = expiration_date;
    policy.customer = customer;
    require(currency.transferFrom(customer, address(this), premium),
            "Transfer of currency failed must approve us to transfer the premium");
    if (rm_coverage > 0)
      require(currency.transferFrom(risk_module.wallet, address(this), rm_coverage - rm_premium),
              "Transfer from risk_module wallet failed - unable to do shared coverage");
    lock_funds(policy);

    emit NewPolicy(msg.sender, policy_id, customer, payout, premium, policy_mcr, expiration_date);
    emit SchedulePolicyExpire(msg.sender, policy_id, expiration_date);
  }

  function provider_cashback_date(LiquidityProvider storage provider) internal view returns (uint) {
    if (provider.cashback_date == 0)
      return (block.timestamp + provider.cashback_period);
    else
      return provider.cashback_date;
  }

  function lock_funds(Policy storage policy) internal {
    // Distributes the amount between potential liquidity providers
    uint policy_mcr = policy.mcr;
    uint available_total = 0;

    // Iterate to calculate available amount
    for (uint i = 0; i < provider_ids.length(); i++) {
      LiquidityProvider storage provider = providers[provider_ids.at(i)];
      // Filter provider by amount and cashback_date
      if ((provider.available_amount == 0) || (provider_cashback_date(provider) < policy.expiration_date))
        continue;
      available_total += provider.available_amount;
    }

    // Iterate AGAIN to distribute the policy_mcr among them
    uint to_distribute = policy_mcr;
    for (uint i = 0; i < provider_ids.length(); i++) {
      LiquidityProvider storage provider = providers[provider_ids.at(i)];
      if ((provider.available_amount == 0) || (provider_cashback_date(provider) < policy.expiration_date))
        continue;
      LockedCapital memory to_lock;
      // distribute based on the weight of a fund in all available funds
      to_lock.amount = (provider.available_amount * policy_mcr) / available_total;
      if (to_lock.amount > to_distribute || i == (provider_ids.length() - 1)) // rounding effects
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

    _resolve_policy(risk_module, policy_id, false);
    emit PolicyExpired(risk_module, policy_id, policy.customer, policy.payout, policy.premium,
                       policy.mcr, policy.expiration_date);
    delete policies[risk_module][policy_id];

    // Notify the risk_module so it updates internal state
    (bool expired_call, ) = address(risk_module).call(
      abi.encodeWithSignature("policy_expired(uint256)", policy_id)
    );
    if (!expired_call)
      revert("Call to risk module notifying expiration failed");
  }

  function resolve_policy(uint policy_id, bool customer_won) public assertBalance {
    // This function MUST be called from the risk module smart contract (msg.sender)
    // We TRUST the risk module on the result of the policy
    Policy storage policy = policies[msg.sender][policy_id];
    require(policy.premium > 0, "Policy not found");

    _resolve_policy(msg.sender, policy_id, customer_won);
    emit PolicyResolved(msg.sender, policy_id, policy.customer, customer_won,
                        policy.payout, policy.premium, policy.mcr);
    delete policies[msg.sender][policy_id];
  }

  function _resolve_policy(address _risk_module, uint policy_id, bool customer_won) internal {
    // Resolves the policy and updates affected LiquidityProviders
    Policy storage policy = policies[_risk_module][policy_id];
    uint policy_premium = policy.premium;
    uint rm_premium = policy.premium * policy.rm_coverage / policy.payout;
    policy_premium -= rm_premium;
    uint premium_distributed = 0;
    uint for_risk_module = 0;
    RiskModule storage risk_module = risk_modules[_risk_module];

    if (!customer_won) {
      // risk_module gets premium_share or the premium covered by the pool
      if (risk_module.premium_share > 0) {
        for_risk_module = policy_premium * risk_module.premium_share / MAX_PERCENTAGE;
        policy_premium -= for_risk_module;
      }
      // risk_module also gets the locked money back
      for_risk_module += policy.rm_coverage;
    }

    for (uint i=0; i < policy.locked_funds.length; i++) {
      LockedCapital storage fund = policy.locked_funds[i];
      LiquidityProvider storage provider = providers[fund.provider_id];
      provider.locked_amount -= fund.amount;
      if (!customer_won) {
        uint premium_for_provider = (fund.amount * policy_premium) / policy.mcr;
        if (i == (policy.locked_funds.length - 1)) // last one gets rounding cents
          premium_for_provider = policy_premium - premium_distributed;
        provider.available_amount += fund.amount + premium_for_provider;
        premium_distributed += premium_for_provider;
        if (provider.asap)
          transfer_available_funds_to_provider(provider);
      }
    }
    if (customer_won) {
      currency.transfer(policy.customer, policy.payout);
      mcr -= policy.mcr;
      pending_premiums -= policy.premium;
    } else {
      ocean_available += policy.mcr + policy_premium;
      mcr -= policy.mcr;
      pending_premiums -= policy.premium;
    }

    if (for_risk_module > 0)
      currency.transfer(risk_module.wallet, for_risk_module);
    risk_module.total_mcr -= policy.mcr;
    risk_module.policy_ids.remove(policy_id);
  }

}
