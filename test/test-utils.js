const { expect } = require("chai");
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
