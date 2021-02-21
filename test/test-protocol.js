const { expect } = require("chai");
const { DAY, WEEK, init_currency, approve_multiple, check_balances, now } = require("./test-utils");

describe("EnsuroProtocol - Creation and policies", function() {
  let Protocol;
  let currency;

  beforeEach(async () => {
    currency = await init_currency(2000);
    Protocol = await ethers.getContractFactory("EnsuroProtocol");
  });

  it("Should be created with currency and invest and can only be destroyed by owner", async function() {
    const [owner, addr1] = await ethers.getSigners();
    const protocol = await Protocol.deploy(currency.address);
    expect(await protocol.ocean_available()).to.equal(0);
    expect(await protocol.mcr()).to.equal(0);
    await expect(protocol.connect(addr1).destroy()).to.be.revertedWith('Only owner can destroy');
    await expect(protocol.connect(owner).destroy()).not.to.be.reverted;
  });

  it("Should accept new policies and lock capital", async function() {
    const [owner, risk_module, cust, provider] = await ethers.getSigners();

    expect(await currency.balanceOf(owner.address)).to.equal(2000);

    // Create protocol and fund it with 500 wei from provider
    const protocol = await Protocol.deploy(currency.address);
    expect(await protocol.ocean_available()).to.equal(0);
    expect(await protocol.mcr()).to.equal(0);

    // Fund the provider and authorize 500 from provider to protocol
    await currency.transfer(provider.address, 500);
    await currency.connect(provider).approve(protocol.address, 500);
    expect(await currency.balanceOf(owner.address)).to.equal(1500);
    expect(await currency.allowance(provider.address, protocol.address)).to.equal(500);

    await expect(() => protocol.connect(provider).invest(500, WEEK)).to.changeTokenBalances(
      currency, [protocol, provider], [500, -500]
    );

    let provider_status = await protocol.get_provider(1);
    expect(provider_status.available_amount).to.equal(500);

    expect(await protocol.ocean_available()).to.equal(500);

    await expect(protocol.add_risk_module(risk_module.address, 1)).not.to.be.reverted;

    const riskm_status = await protocol.get_risk_module_status(risk_module.address);
    expect(riskm_status.smart_contract).to.equal(risk_module.address);
    expect(riskm_status.status).to.equal(1);

    // Invalid policies should be reverted
    await expect(protocol.new_policy(1234, now() - 1000, 1, 36, cust.address)).to.be.revertedWith(
      "Policy can't expire in the past"
    );
    let riskm_calls = protocol.connect(risk_module);
    await expect(riskm_calls.new_policy(1234, now() + 1000, 100, 3600, cust.address)).to.be.revertedWith(
      "Not enought free capital in the pool"
    );

    // Test valid policy - should be stored
    // Fund the customer and authorize 10 from customer to protocol
    await currency.transfer(cust.address, 11);
    await currency.connect(cust).approve(protocol.address, 10);

    await expect(riskm_calls.new_policy(1234, now() + 1000, 10, 360, cust.address)).not.to.be.reverted;
    expect(await protocol.ocean_available()).to.equal(150);
    expect(await protocol.mcr()).to.equal(350);

    // Create another policy
    expect(await currency.allowance(cust.address, protocol.address)).to.equal(0);
    await expect(riskm_calls.new_policy(2222, now() + 1000, 1, 100, cust.address)).to.be.reverted;
    // Aprove allowance and it should work
    await currency.connect(cust).approve(protocol.address, 1);
    await expect(riskm_calls.new_policy(2222, now() + 1000, 1, 100, cust.address)).not.to.be.reverted;
    expect(await currency.balanceOf(protocol.address)).to.equal(51+11+449);
    expect(await currency.balanceOf(cust.address)).to.equal(0);
    expect(await protocol.ocean_available()).to.equal(51);
    expect(await protocol.mcr()).to.equal(449);
    expect(await protocol.pending_premiums()).to.equal(11);

    let policy = await protocol.get_policy(risk_module.address, 1234);
    expect(policy.customer).to.equal(cust.address);
    expect(policy.prize).to.equal(360);
    expect(policy.premium).to.equal(10);

    // Provider available and locked funds should change
    provider_status = await protocol.get_provider(1);
    expect(provider_status.available_amount).to.equal(51);
    expect(provider_status.locked_amount).to.equal(449);

    // Expire the 1st policy
    await expect(protocol.expire_policy(risk_module.address, 1111)).to.be.revertedWith("Policy not found");
    await expect(protocol.expire_policy(risk_module.address, 1234)).to.be.revertedWith("Policy not expired yet");

    await ethers.provider.send("evm_increaseTime", [1000]);
    await ethers.provider.send("evm_mine");
    await expect(protocol.expire_policy(risk_module.address, 1234)).not.to.be.reverted;

    expect(await protocol.ocean_available()).to.equal(411);
    expect(await protocol.mcr()).to.equal(99);
    expect(await protocol.pending_premiums()).to.equal(1);

    // Resolve 2nd policy in favor of the customer
    await expect(() => riskm_calls.resolve_policy(2222, true)).to.changeTokenBalances(
      currency, [protocol, cust], [-100, 100]
    );

    expect(await protocol.ocean_available()).to.equal(411);
    expect(await protocol.mcr()).to.equal(0);
    expect(await protocol.pending_premiums()).to.equal(0);

    // Provider available and locked funds should change
    // no locked_funds, available_amount = 500 + 10 (premium first policy) - 99
    provider_status = await protocol.get_provider(1);
    expect(provider_status.available_amount).to.equal(500 + 10 - 99);
    expect(provider_status.locked_amount).to.equal(0);
  });

});


describe("EnsuroProtocol - LiquidityProviders", function() {
  let protocol;
  let currency;
  let owner, prov1, prov2, prov3, cust1, cust2, riskm;

  beforeEach(async () => {
    [owner, prov1, prov2, prov3, cust1, cust2, riskm] = await ethers.getSigners();
    currency = await init_currency(1e10,
      [prov1, prov2, prov3, cust1, cust2],
      [1e5, 2e5, 3e5, 1e4, 2e4],
    );
    Protocol = await ethers.getContractFactory("EnsuroProtocol");
    protocol = await Protocol.deploy(currency.address);
    expect(await protocol.ocean_available()).to.equal(0);
    expect(await protocol.mcr()).to.equal(0);
    await expect(protocol.add_risk_module(riskm.address, 1)).not.to.be.reverted;
  });

  it("Should record investments and can be withdrawn inmediatelly if not used", async function() {
    await approve_multiple(currency, protocol, [prov1, prov2, prov3], [1e4, 2e4, 3e4]);

    await expect(protocol.connect(prov1).invest(1e4, WEEK))
      .to.emit(protocol, "NewLiquidityProvider");
    await expect(protocol.connect(prov2).invest(2e4, 2 * WEEK))
      .to.emit(protocol, "NewLiquidityProvider");
    const tx = await expect(protocol.connect(prov3).invest(3e4, 4 * WEEK)).not.to.be.reverted;
    const event = (await tx.wait()).events.pop();

    expect(event.args[1]).to.equal(3); // provider_id = 3

    await check_balances(currency, [prov1, prov2, prov3], [1e5 - 1e4, 2e5 - 2e4, 3e5 - 3e4]);

    await expect(protocol.connect(prov2).withdraw(2, true))
      .to.emit(protocol, "LiquidityProviderWithdrawal")
      .to.emit(protocol, "LiquidityProviderDeleted");
    await expect(protocol.connect(prov1).withdraw(1, true))
      .to.emit(protocol, "LiquidityProviderWithdrawal")
      .to.emit(protocol, "LiquidityProviderDeleted");
    await expect(protocol.connect(prov3).withdraw(3, true))
      .to.emit(protocol, "LiquidityProviderWithdrawal")
      .to.emit(protocol, "LiquidityProviderDeleted");

    await check_balances(currency, [prov1, prov2, prov3], [1e5, 2e5, 3e5]);
  });

  it("Should distribute policies between multiple providers", async function() {
    await approve_multiple(currency, protocol, [prov1, prov2, prov3, cust1, cust2],
      [1e4, 2e4, 3e4, 2000, 3000]
    );

    await expect(protocol.connect(prov1).invest(1e4, WEEK)).not.to.be.reverted;
    await expect(protocol.connect(prov2).invest(2e4, 2 * WEEK)).not.to.be.reverted;
    await expect(protocol.connect(prov3).invest(3e4, 4 * WEEK)).not.to.be.reverted;
    await check_balances(currency, [prov1, prov2, prov3], [1e5 - 1e4, 2e5 - 2e4, 3e5 - 3e4]);

    const riskm_calls = protocol.connect(riskm);

    // First policy, available for all, distributes MCR 9000 proportional to available funds
    await expect(riskm_calls.new_policy(1111, now() + WEEK - DAY, 1000, 1e4, cust1.address))
      .to.emit(protocol, "NewPolicy");
    let p1_status = await protocol.get_provider(1);
    let p2_status = await protocol.get_provider(2);
    let p3_status = await protocol.get_provider(3);
    expect(p1_status.locked_amount).to.equal(1500);
    expect(p2_status.locked_amount).to.equal(3000);
    expect(p3_status.locked_amount).to.equal(4500);
    expect(p1_status.available_amount).to.equal(8500);
    expect(p2_status.available_amount).to.equal(17000);
    expect(p3_status.available_amount).to.equal(25500);

    // 2nd policy available only for prov2 and prov3
    await expect(riskm_calls.new_policy(2222, now() + WEEK + DAY, 500, 3000, cust1.address))
      .to.emit(protocol, "NewPolicy");
    let p1_newstatus = await protocol.get_provider(1);
    expect(p1_newstatus.locked_amount).to.equal(p1_status.locked_amount);  // unchanged
    expect(p1_newstatus.available_amount).to.equal(p1_status.available_amount);
    p2_status = await protocol.get_provider(2);
    p3_status = await protocol.get_provider(3);
    expect(p2_status.locked_amount).to.equal(3000 + 1000);
    expect(p3_status.locked_amount).to.equal(4500 + 1500);

    // Resolve 2nd policy - customer lost
    await expect(riskm_calls.resolve_policy(2222, false))
      .to.emit(protocol, "PolicyResolved").withArgs(riskm.address, 2222, cust1.address, false, 3000, 500);

    p1_newstatus = await protocol.get_provider(1);
    expect(p1_newstatus.locked_amount).to.equal(p1_status.locked_amount);  // still unchanged
    p2_status = await protocol.get_provider(2);
    p3_status = await protocol.get_provider(3);
    // Amounts locked only in first policy
    expect(p2_status.locked_amount).to.equal(3000);
    expect(p3_status.locked_amount).to.equal(4500);
    // Available amounts increased by shared premium
    expect(p2_status.available_amount).to.equal(17000 + 200);
    expect(p3_status.available_amount).to.equal(25500 + 300);

    // Resolve 1st policy - customer won
    await expect(riskm_calls.resolve_policy(1111, true))
      .to.emit(protocol, "PolicyResolved");

    p1_status = await protocol.get_provider(1);
    p2_status = await protocol.get_provider(2);
    p3_status = await protocol.get_provider(3);
    // No amounts locked
    expect(p1_status.locked_amount).to.equal(0);
    expect(p2_status.locked_amount).to.equal(0);
    expect(p3_status.locked_amount).to.equal(0);
    // Available amounts increased by shared premium
    expect(p1_status.available_amount).to.equal(1e4 - 1500); // Lost 1500 locked in 1st policy
    expect(p2_status.available_amount).to.equal(17000 + 200);
    expect(p3_status.available_amount).to.equal(25500 + 300);

    // Withdraw all
    await expect(protocol.connect(prov2).withdraw(2, true))
      .to.emit(protocol, "LiquidityProviderWithdrawal")
      .to.emit(protocol, "LiquidityProviderDeleted");
    await expect(protocol.connect(prov1).withdraw(1, true))
      .to.emit(protocol, "LiquidityProviderWithdrawal")
      .to.emit(protocol, "LiquidityProviderDeleted");
    await expect(protocol.connect(prov3).withdraw(3, true))
      .to.emit(protocol, "LiquidityProviderWithdrawal")
      .to.emit(protocol, "LiquidityProviderDeleted");

    await check_balances(currency, [prov1, prov2, prov3, cust1],
      [1e5 - 1500, 2e5 - 3000 + 200, 3e5 - 4500 + 300, 1e4 - 500 + 9000]
    );
  });

  it("Should do the Binance Hackathon walkthrough", async function() {
    const Roulette = await ethers.getContractFactory("EnsuroRoulette");
    const roulette = await Roulette.deploy(protocol.address);
    await expect(protocol.add_risk_module(roulette.address, 1)).not.to.be.reverted;

    // 1. Initial wallets
    // [prov1, prov2, prov3, cust1, cust2],
    // [100K, 200K, 300K, 10K, 20K],
    await approve_multiple(currency, protocol, [prov1, prov2, prov3, cust1, cust2],
      [1e4, 2e4, 3e4, 1000, 500]  // 10K / 20K / 30K / 1K / 500
    );

    // 2. Providers investment
    await expect(protocol.connect(prov1).invest(1e4, WEEK)).not.to.be.reverted;
    await expect(protocol.connect(prov2).invest(2e4, 2 * WEEK)).not.to.be.reverted;
    await expect(protocol.connect(prov3).invest(3e4, 4 * WEEK)).not.to.be.reverted;
    await check_balances(currency, [prov1, prov2, prov3], [1e5 - 1e4, 2e5 - 2e4, 3e5 - 3e4]);

    // 3. Customer 1 acquires policy
    // First policy, available for all, distributes MCR 9000 proportional to available funds
    await expect(roulette.connect(cust1).new_policy(17, 1000, 36000, now() + WEEK - DAY))
      .to.emit(protocol, "NewPolicy");
    let p1_status = await protocol.get_provider(1);
    let p2_status = await protocol.get_provider(2);
    let p3_status = await protocol.get_provider(3);
    expect(p1_status.locked_amount).to.equal(5833);
    expect(p2_status.locked_amount).to.equal(11666);
    expect(p3_status.locked_amount).to.equal(17501);
    expect(p1_status.available_amount).to.equal(1e4 - 5833);
    expect(p2_status.available_amount).to.equal(2e4 - 11666);
    expect(p3_status.available_amount).to.equal(3e4 - 17501);
    expect(await protocol.mcr()).to.equal(35000);
    expect(await protocol.ocean_available()).to.equal(25000);

    // 4. Customer 2 acquires policy
    // 2nd policy available only for prov2 and prov3
    await expect(roulette.connect(cust2).new_policy(15, 500, 18000, now() + WEEK + DAY))
      .to.emit(protocol, "NewPolicy");
    let p1_newstatus = await protocol.get_provider(1);
    expect(p1_newstatus.locked_amount).to.equal(p1_status.locked_amount);  // unchanged
    expect(p1_newstatus.available_amount).to.equal(p1_status.available_amount);
    p2_status = await protocol.get_provider(2);
    p3_status = await protocol.get_provider(3);
    expect(p2_status.locked_amount).to.equal(11666 + 7000);
    expect(p3_status.locked_amount).to.equal(17501 + 10500);
    expect(p2_status.available_amount).to.equal(1334);
    expect(p3_status.available_amount).to.equal(1999);

    expect(await protocol.ocean_available()).to.equal(7500);
    expect(await protocol.mcr()).to.equal(35000 + 17500);
    expect(await protocol.pending_premiums()).to.equal(1500);

    // 5. Prov1 asks for withdrawal
    // 1st provider ask for withdraw
    expect(await protocol.connect(prov1).withdraw(1, true))
      .to.emit(protocol, "LiquidityProviderWithdrawal")
      .withArgs(prov1.address, 1, 4167)
    ;
    expect(await protocol.ocean_available()).to.equal(3333);

    // 6. Swipe roulette for 1st policy - customer lost
    await expect(roulette.swipe_roulette(1, 20))
      .to.emit(protocol, "LiquidityProviderWithdrawal")
      .withArgs(prov1.address, 1, 5833 + 166) // 5999
      .to.emit(protocol, "LiquidityProviderDeleted");

    p2_status = await protocol.get_provider(2);
    p3_status = await protocol.get_provider(3);
    expect(p2_status.locked_amount).to.equal(7000);
    expect(p3_status.locked_amount).to.equal(10500);
    expect(p2_status.available_amount).to.equal(1334 + 11666 + 333);
    expect(p3_status.available_amount).to.equal(1999 + 17501 + 501);

    expect(await protocol.ocean_available()).to.equal(50000 - 17500 + (1000 - 166));  // 33334
    expect(await protocol.mcr()).to.equal(17500);
    expect(await protocol.pending_premiums()).to.equal(500);

    // 7. Swipe roulette for 2nd policy - customer won
    await expect(roulette.swipe_roulette(2, 15))
      .to.emit(protocol, "PolicyResolved")
      .withArgs(roulette.address, 2, cust2.address, true, 18000, 500);


    p2_status = await protocol.get_provider(2);
    p3_status = await protocol.get_provider(3);
    expect(p2_status.locked_amount).to.equal(0);
    expect(p3_status.locked_amount).to.equal(0);
    expect(p2_status.available_amount).to.equal(1334 + 11666 + 333);
    expect(p3_status.available_amount).to.equal(1999 + 17501 + 501);

    expect(await protocol.ocean_available()).to.equal(33334);
    expect(await protocol.mcr()).to.equal(0);
    expect(await protocol.pending_premiums()).to.equal(0);

    await check_balances(currency, [prov1, prov2, prov3], [1e5 + 166, 2e5 - 2e4, 3e5 - 3e4]);

    // Withdraw all
    await expect(protocol.connect(prov2).withdraw(2, true))
      .to.emit(protocol, "LiquidityProviderWithdrawal")
      .to.emit(protocol, "LiquidityProviderDeleted");
    await expect(protocol.connect(prov3).withdraw(3, true))
      .to.emit(protocol, "LiquidityProviderWithdrawal")
      .to.emit(protocol, "LiquidityProviderDeleted");

    await check_balances(currency, [prov1, prov2, prov3], [1e5 + 166, 2e5 - 2e4 + 13333, 3e5 - 3e4 + 20001]);
    await check_balances(currency, [cust1, cust2], [9000, 20000 + 17500]);

  });

  // TODO: test progressive withdrawal (with asap=false)

});
