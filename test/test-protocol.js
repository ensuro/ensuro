const { expect } = require("chai");
const { DAY, WEEK, init_currency, approve_multiple, check_balances,
        now, add_risk_module, expected_change } = require("./test-utils");


/*fit = it;
it = function() {}*/

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

    await expect(add_risk_module(protocol, risk_module.address)).not.to.be.reverted;

    const riskm_status = await protocol.get_risk_module_status(risk_module.address);
    expect(riskm_status).to.equal(1);

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
    expect(policy.payout).to.equal(360);
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
    await expect(add_risk_module(protocol, riskm.address)).not.to.be.reverted;
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
      .to.emit(protocol, "PolicyResolved").withArgs(
        riskm.address, 2222, cust1.address, false, 3000, 500, 2500
      );

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
    await expect(add_risk_module(protocol, roulette.address)).not.to.be.reverted;

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
      .withArgs(roulette.address, 2, cust2.address, true, 18000, 500, 17500);


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

describe("EnsuroProtocol - Risk Modules", function() {
  let protocol;
  let currency;
  let owner, prov1, prov2, cust, riskm1, riskm2;

  beforeEach(async () => {
    [owner, prov1, prov2, cust, riskm1, riskm2] = await ethers.getSigners();
    currency = await init_currency(1e10,
      [prov1, prov2, cust, riskm1, riskm2],
      [1e5, 2e5, 1e4, 3e4, 4e4],
    );
    Protocol = await ethers.getContractFactory("EnsuroProtocol");
    protocol = await Protocol.deploy(currency.address);

    // Customer approves all its capital
    await approve_multiple(currency, protocol, [cust], [1e4]);

    expect(await protocol.ocean_available()).to.equal(0);
    expect(await protocol.mcr()).to.equal(0);
    await approve_multiple(currency, protocol, [prov1, prov2], [1e5, 2e5]);
    await expect(protocol.connect(prov1).invest(1e5, WEEK))
      .to.emit(protocol, "NewLiquidityProvider");
    await expect(protocol.connect(prov2).invest(2e5, 2 * WEEK))
      .to.emit(protocol, "NewLiquidityProvider");
  });

  it("Should validate risk module limits", async function() {
    await expect(add_risk_module(
      protocol, riskm1.address, undefined, undefined,
      1e4 /*max_mcr_per_policy */, 1e5 /* mcr_limit */, 80e3 /* mcr_percentage - 80% */,
    )).not.to.be.reverted;

    let riskm_calls = protocol.connect(riskm1);

    await expect(riskm_calls.new_policy(1234, now() + 3000, 100, 2e4, cust.address)).to.be.revertedWith(
      "MCR bigger than MAX_MCR for this module"
    );

    await expect(riskm_calls.new_policy(1234, now() + 3000, 100, 1e4, cust.address)).not.to.be.reverted;
    expect(await protocol.mcr()).to.equal((1e4 - 100) * .8); // mcr_percentage = 80%

    // Insert more policies
    for (let i=0; i < 11; i++) {
      await expect(riskm_calls.new_policy(1235 + i, now() + 3000, 100, 1e4, cust.address)).not.to.be.reverted;
    }

    await expect(riskm_calls.new_policy(1235 + 12, now() + 3000, 100, 1e4, cust.address)).to.be.revertedWith(
      "This risk module doesn't have enought limit to cover this policy"
    );


  });

  it("Should pay premium_share to risk module", async function() {
    await expect(add_risk_module(
      protocol, riskm1.address, undefined, undefined,
      1e4 /*max_mcr_per_policy */, 1e5 /* mcr_limit */, 1e5 /* mcr_percentage - 100% */,
      10e3 /* premium_share - 10% */
    )).not.to.be.reverted;

    let riskm_calls = protocol.connect(riskm1);

    let initial_ocean = await protocol.ocean_available();

    await expect(riskm_calls.new_policy(1234, now() + 2000, 100, 1e4, cust.address)).not.to.be.reverted;
    expect(await protocol.mcr()).to.equal(1e4 - 100); // mcr_percentage = 100%
    await expect(riskm_calls.new_policy(1235, now() + 2000, 100, 1e4, cust.address)).not.to.be.reverted;
    expect(await protocol.mcr()).to.equal(2e4 - 200); // mcr_percentage = 100%

    // Resolve 1nd policy in favor of the customer - riskm1 gets nothing
    await expect(() => riskm_calls.resolve_policy(1234, true)).to.changeTokenBalances(
      currency, [protocol, cust, riskm1], [-1e4, 1e4, 0]
    );

    // Resolve 2nd policy in favor of the pool - riskm1 gets 10% of premium = 10
    await expect(() => riskm_calls.resolve_policy(1235, false)).to.changeTokenBalances(
      currency, [protocol, cust, riskm1], [-10, 0, 10]
    );
    expect(await protocol.mcr()).to.equal(0);
    expect(await protocol.ocean_available()).to.equal(initial_ocean - (1e4 - 100) + (100 - 10));
  });

  it("Should allow shared coverage of the policies", async function() {
    await expect(add_risk_module(
      protocol, riskm1.address, undefined, undefined,
      undefined, undefined, undefined,
      10e3 /* premium_share - 10% */, undefined, 30e3 /* shared_coverage_min_percentage - 30% */
    )).not.to.be.reverted;

    await expect(add_risk_module(
      protocol, riskm2.address, undefined, undefined,
      undefined, undefined, undefined,
      0 /* premium_share - 0% */, undefined, 80e3 /* shared_coverage_min_percentage - 80% */
    )).not.to.be.reverted;

    let riskm1_calls = protocol.connect(riskm1);
    let riskm2_calls = protocol.connect(riskm2);

    let ocean = await protocol.ocean_available();
    let mcr = 0;

    await expect(riskm1_calls.new_policy(1234, now() + 2000, 100, 1e4, cust.address)).to.be.revertedWith(
      "ERC20: transfer amount exceeds allowance"
    );

    await approve_multiple(currency, protocol, [riskm1, riskm2], [2e4, 4e4]);

    let rm1_shared_coverage = 1e4 * .3 - 100 * .3;

    await expect(() => riskm1_calls.new_policy(1234, now() + 2000, 100, 1e4, cust.address)).to.changeTokenBalances(
      currency, [protocol, cust, riskm1], [100 + rm1_shared_coverage, -100, -rm1_shared_coverage]
    );
    mcr = await expected_change(protocol.mcr, mcr, 7000 - 70)

    let rm2_shared_coverage = 2e4 * .8 - 200 * .8;
    await expect(() => riskm2_calls.new_policy(1234, now() + 2000, 200, 2e4, cust.address)).to.changeTokenBalances(
      currency, [protocol, cust, riskm2], [200 + rm2_shared_coverage, -200, -rm2_shared_coverage]
    );
    mcr = await expected_change(protocol.mcr, mcr, 4000 - 40);
    await expect(riskm1_calls.change_shared_coverage(riskm2.address, 100e3)).to.be.revertedWith(
      "Only module owner can tweak this parameter"
    );
    await expect(riskm2_calls.change_shared_coverage(riskm2.address, 10e3)).to.be.revertedWith(
      "Must be greater or equal to shared_coverage_min_percentage"
    );
    await expect(riskm2_calls.change_shared_coverage(riskm2.address, 100e3)).not.to.be.reverted;

    await expect(() => riskm2_calls.new_policy(1235, now() + 2000, 200, 2e4, cust.address)).to.changeTokenBalances(
      currency, [protocol, cust, riskm2], [2e4, -200, - 2e4 + 200]
    );
    mcr = await expected_change(protocol.mcr, mcr, 0); // Unchanged - full coverage by RM
    ocean = await expected_change(protocol.ocean_available, ocean, -mcr);

    // Resolve 1st policy in favor of the pool - riskm1 gets 30% of the premium + 10% of 70% + rm1_shared_coverage
    await expect(() => riskm1_calls.resolve_policy(1234, false)).to.changeTokenBalances(
      currency, [protocol, cust, riskm1], [-rm1_shared_coverage - 30 - 7, 0, rm1_shared_coverage + 30 + 7]
    );

    mcr = await expected_change(protocol.mcr, mcr, -(7000 - 70));
    ocean = await expected_change(protocol.ocean_available, ocean, +(7000 - 70) + 63 /* premium after premium_share*/);

    // Resolve 2nd policy in favor if the customer - riskm2 losts it's shared coverage, pool only the MCR
    await expect(() => riskm2_calls.resolve_policy(1234, true)).to.changeTokenBalances(
      currency, [protocol, cust, riskm2], [-2e4, 2e4, 0]
    );
    mcr = await expected_change(protocol.mcr, mcr, -(4000 - 40));
    ocean = await expected_change(protocol.ocean_available, ocean, 0);

    // Resolve 3rd policy againt the customer - riskm2 gets all because it was full coverage
    await expect(() => riskm2_calls.resolve_policy(1235, false)).to.changeTokenBalances(
      currency, [protocol, cust, riskm2], [-2e4, 0, 2e4]
    );
    // mcr and ocean unchanged
    mcr = await expected_change(protocol.mcr, mcr, 0);
    ocean = await expected_change(protocol.ocean_available, ocean, 0);
  });

});
