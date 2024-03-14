const { expect } = require("chai");
const hre = require("hardhat");
const helpers = require("@nomicfoundation/hardhat-network-helpers");

const { amountFunction, _W, getTransactionEvent } = require("../js/utils");

const _A = amountFunction(6);

describe("Policy initialize", () => {
  it("Does not allow premium greater than payout", async () => {
    const { pool } = await helpers.loadFixture(poolFixture);

    const policyArgs = await makePolicyArgs({ premium: _A("2"), payout: _A("1") });
    await expect(pool.initializeAndEmitPolicy(...policyArgs)).to.be.revertedWith("Premium cannot be more than payout");
  });

  it("Correctly collateralizes with jr etoken", async () => {
    // this test mirrors test_get_minimum_premium_with_high_jr_coll_ratio from riskmodule

    const { pool } = await helpers.loadFixture(poolFixture);

    const policyArgs = await makePolicyArgs({ lossProb: _W("0.01"), payout: _A("100") }, { jrCollRatio: _W("0.1") });

    const tx = await pool.initializeAndEmitPolicy(...policyArgs);
    const receipt = await tx.wait();

    const policy = getTransactionEvent(pool.interface, receipt, "NewPolicy").args.policy;

    expect(policy.jrScr).to.equal(_A("9"));
  });

  it("Correctly computes jr and sr CoC", async () => {
    // this test mirrors test_get_minimum_premium_with_high_jr_coll_ratio from riskmodule

    const { pool } = await helpers.loadFixture(poolFixture);

    const now = await helpers.time.latest();
    const secondsInYear = 3600 * 24 * 365;
    const expiration = now + secondsInYear / 12;

    const policyArgs = await makePolicyArgs(
      { lossProb: _W("0.01"), payout: _A("100"), start: now, expiration: expiration },
      { jrCollRatio: _W("0.1"), jrRoc: _W("0.24"), collRatio: _W("0.2"), srRoc: _W("0.12") }
    );

    const tx = await pool.initializeAndEmitPolicy(...policyArgs);
    const receipt = await tx.wait();

    const policy = getTransactionEvent(pool.interface, receipt, "NewPolicy").args.policy;

    expect(policy.jrCoc).to.equal(_A(9 * 0.02));
    expect(policy.srCoc).to.equal(_A(10 * 0.01));
  });

  async function poolFixture() {
    const PolicyPool = await hre.ethers.getContractFactory("PolicyPoolMock");
    const pool = await PolicyPool.deploy(hre.ethers.ZeroAddress, hre.ethers.ZeroAddress);

    return { pool };
  }

  async function makePolicyArgs(options = {}, rmParams = {}) {
    const now = await helpers.time.latest();
    return [
      options.riskModule || "0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199", // riskModule
      [
        rmParams.moc || _W(1), // moc
        rmParams.jrCollRatio || _W(0), // jrCollRatio
        rmParams.collRatio || _W(0), // collRatio
        rmParams.ensuroPpFee || _A(0), // ensuroPpFee
        rmParams.ensuroCocFee || _A(0), // ensuroCocFee
        rmParams.jrRoc || _W(0), // jrRoc
        rmParams.srRoc || _W(0), // srRoc
      ], // rmParams
      options.premium || _A("10"), // premium
      options.payout || _A("100"), // payout
      options.lossProb || _W("0.1"), // lossProb
      options.expiration || now + 3600 * 5, // expiration
      options.start || 0, // start
    ];
  }
});
