const { expect } = require("chai");
const { BigNumber } = require("ethers");
exports.WEEK = 3600 * 24 * 7;
exports.DAY = 3600 * 24;

exports.init_currency = async function(initial_supply, initial_targets, initial_balances) {
  Currency = await ethers.getContractFactory("TestCurrency");
  currency = await Currency.deploy(initial_supply);
  initial_targets = initial_targets || [];
  await Promise.all(initial_targets.map(async function (user, index) {
    await currency.transfer(user.address, initial_balances[index]);
  }));
  return currency;
}

exports.approve_multiple = async function(currency, spender, sources, amounts) {
  return Promise.all(sources.map(async function (source, index) {
    await currency.connect(source).approve(spender.address, amounts[index]);
  }));
}

exports.check_balances = async function(currency, users, amounts) {
  return Promise.all(users.map(async function (user, index) {
    expect(await currency.balanceOf(user.address)).to.equal(amounts[index]);
  }));
}

exports.now = function() {
  return Math.floor(new Date().getTime() / 1000);
}

exports.add_risk_module = function(protocol, smart_contract, module_owner, status,
                                   max_mcr_per_policy, mcr_limit, mcr_percentage, premium_share,
                                   wallet, shared_coverage_min_percentage) {
  // add_risk_module call with defaults
  module_owner = module_owner || smart_contract;
  status = status || 1;
  max_mcr_per_policy = max_mcr_per_policy || 1e10;
  mcr_limit = mcr_limit || 1e10;
  mcr_percentage = mcr_percentage || 1e5;
  premium_share = premium_share || 0;
  wallet = wallet || smart_contract;
  shared_coverage_min_percentage = shared_coverage_min_percentage || 0;
  return protocol.add_risk_module(smart_contract, module_owner, status, max_mcr_per_policy, mcr_limit, mcr_percentage,
                                  premium_share, wallet, shared_coverage_min_percentage);
}

exports.expected_change = async function(protocol_attribute, initial, change) {
  change = BigNumber.from(change);
  let actual_value = await protocol_attribute();
  expect(actual_value.sub(initial)).to.equal(change);
  return actual_value;
}
