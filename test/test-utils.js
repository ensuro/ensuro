const { expect } = require("chai");
const { BigNumber, utils } = require("ethers");
const {LogDescription} = require("ethers/lib/utils");
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

exports.impersonate = async function(address, setBalanceTo) {
  const ok = await hre.network.provider.request(
    {method: "hardhat_impersonateAccount", params: [address]}
  );
  if (!ok)
    throw "Error impersonatting " + address;

  if (setBalanceTo !== undefined)
    await hre.network.provider.request(
      {method: "hardhat_setBalance", params: [address, setBalanceTo.toHexString()]}
    );

  return await ethers.getSigner(address);
}


/**
* Finds an event in the receipt
* @param {Interface} interface The interface of the contract that contains the requested event
* @param {TransactionReceipt} receipt Transaction receipt containing the events in the logs
* @param {String} eventName The name of the event we are interested in
* @returns {LogDescription}
*/
exports.getTransactionEvent = function(interface, receipt, eventName) {
  // for each log in the transaction receipt
  for (const log of receipt.events) {
    let parsedLog;
    try {
      parsedLog = interface.parseLog(log);
    } catch (error) {
      continue;
    }
    if (parsedLog.name == eventName) {
      return parsedLog;
    }
  }
  return null;  // not found
}
