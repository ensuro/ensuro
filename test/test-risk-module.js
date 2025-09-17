const { expect } = require("chai");
const { ethers } = require("hardhat");
const { MaxUint256, ZeroAddress } = require("ethers");
const { RiskModuleParameter } = require("../js/enums");
const helpers = require("@nomicfoundation/hardhat-network-helpers");
const { amountFunction, _W, getTransactionEvent, captureAny } = require("@ensuro/utils/js/utils");
const { initCurrency } = require("@ensuro/utils/js/test-utils");
const { deployPool, deployPremiumsAccount, addRiskModule, addEToken } = require("../js/test-utils");

// NOTICE: This tests only cover the bits not already covered by the python tests in the `tests`
// directory.
//
// Namely, the RiskModule internals that are not reachable through TrustfulRiskModule are tested
// here through a mock contract.

describe("RiskModule contract", function () {
  let _A;
  let backend, cust, lp, owner;

  beforeEach(async () => {
    [, lp, cust, backend, owner] = await ethers.getSigners();

    _A = amountFunction(6);
  });

  async function deployPoolFixture() {
    const currency = await initCurrency(
      { name: "Test USDC", symbol: "USDC", decimals: 6, initial_supply: _A(10000) },
      [lp, cust, backend],
      [_A(5000), _A(500), _A(1000)]
    );

    const pool = await deployPool({
      currency: currency,
      treasuryAddress: "0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199", // Random address
    });
    pool._A = _A;

    return { pool, currency };
  }

  async function deployRiskModuleFixture() {
    const { pool, currency } = await helpers.loadFixture(deployPoolFixture);
    // Setup the liquidity sources
    const etk = await addEToken(pool, {});
    const premiumsAccount = await deployPremiumsAccount(pool, { srEtk: etk });

    await currency.connect(lp).approve(pool, _A(5000));
    await pool.connect(lp).deposit(etk, _A(5000));

    // Setup the risk module
    const RiskModule = await hre.ethers.getContractFactory("RiskModuleMock");
    const rm = await addRiskModule(pool, premiumsAccount, RiskModule, {
      extraArgs: [],
    });

    return { etk, premiumsAccount, rm, RiskModule, pool, currency };
  }

  async function deployRmWithPolicyFixture() {
    const { rm, pool, currency, premiumsAccount } = await helpers.loadFixture(deployRiskModuleFixture);
    const now = await helpers.time.latest();

    // Deploy a new policy
    await currency.connect(backend).approve(pool, _A(110));

    const tx = await rm.connect(backend).newPolicy(
      _A(1000), // payout
      _A(10), // premium
      _W(0), // lossProb
      now + 3600 * 5, // expiration
      ZeroAddress,
      cust, // holder
      123 // internalId
    );

    const receipt = await tx.wait();

    // Try to resolve it without going through the riskModule
    const newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");

    return { policy: newPolicyEvt.args.policy, receipt, rm, currency, pool, premiumsAccount };
  }

  it("Set params jrCollRatio validations", async () => {
    const { rm } = await helpers.loadFixture(deployRiskModuleFixture);

    let jrCollRatio = 0;
    await rm.setParam(1, jrCollRatio);
  });

  it("Allows msg.sender as payer", async () => {
    const { pool, rm, currency } = await helpers.loadFixture(deployRiskModuleFixture);
    await currency.connect(backend).approve(pool, _A(110));

    const policy = await makePolicy({});
    await rm.connect(backend).newPolicy(...policy.toArgs());

    // The premium was payed by the caller
    expect(await currency.balanceOf(cust)).to.equal(_A(500));
    expect(await currency.balanceOf(backend)).to.equal(_A(890));
  });

  it("The payer is always the caller and fails with ERC20 error if spending not approved", async () => {
    const { pool, rm, currency } = await helpers.loadFixture(deployRiskModuleFixture);

    // The customer approved the spending for the pool
    await currency.connect(cust).approve(pool, _A(110));

    const policy = await makePolicy({});
    await expect(rm.connect(backend).newPolicy(...policy.toArgs()))
      .to.be.revertedWithCustomError(currency, "ERC20InsufficientAllowance")
      .withArgs(pool, 0, _A(100)); // 100 = Pure Premium

    expect(await currency.balanceOf(cust)).to.equal(_A(500));
    expect(await currency.balanceOf(backend)).to.equal(_A(1000));
  });

  it("Does not allow another payer - Even with old allowances", async () => {
    const { pool, rm, currency } = await helpers.loadFixture(deployRiskModuleFixture);

    // Leaving this test to underline the 2.x behaviour where the customer could be the payer
    // by doing an allowance to the caller is no longer supported

    // The customer approved the spending for the pool
    await currency.connect(cust).approve(pool, _A(110));

    // And also allowed the backend
    await currency.connect(cust).approve(backend, _A(110));

    const policy = await makePolicy({});
    await expect(rm.connect(backend).newPolicy(...policy.toArgs()))
      .to.be.revertedWithCustomError(currency, "ERC20InsufficientAllowance")
      .withArgs(pool, _A(0), _A(100));
  });

  it("Does not allow an exposure limit of zero", async () => {
    const { pool, premiumsAccount, RiskModule } = await helpers.loadFixture(deployRiskModuleFixture);

    await expect(
      addRiskModule(pool, premiumsAccount, RiskModule, {
        exposureLimit: 0,
        extraArgs: [],
      })
    )
      .to.be.revertedWithCustomError(RiskModule, "InvalidParameter")
      .withArgs(RiskModuleParameter.exposureLimit);
  });

  it("Does not allow wallet with zero address", async () => {
    const { pool, premiumsAccount, RiskModule } = await helpers.loadFixture(deployRiskModuleFixture);
    await expect(
      addRiskModule(pool, premiumsAccount, RiskModule, {
        wallet: hre.ethers.ZeroAddress,
        extraArgs: [],
      })
    ).to.be.revertedWithCustomError(RiskModule, "NoZeroWallet");
  });

  it("Does not allow a maxpayout of zero", async () => {
    const { pool, premiumsAccount, RiskModule } = await helpers.loadFixture(deployRiskModuleFixture);
    await expect(
      addRiskModule(pool, premiumsAccount, RiskModule, {
        maxPayoutPerPolicy: 0,
        extraArgs: [],
      })
    )
      .to.be.revertedWithCustomError(RiskModule, "InvalidParameter")
      .withArgs(RiskModuleParameter.maxPayoutPerPolicy);
  });

  it("Reverts if new policy is lower than previous", async () => {
    const { policy, rm, pool } = await helpers.loadFixture(deployRmWithPolicyFixture);

    // Old Policy: { payout= 1000, premium = 10, expiration= now + 3600 + 5}
    await expect(
      rm.connect(backend).replacePolicy([...policy], _A(999), policy.premium, policy.lossProb, policy.expiration, 1234)
    )
      .to.be.revertedWithCustomError(pool, "InvalidPolicyReplacement")
      .withArgs(policy, captureAny.value);
    expect(captureAny.lastValue[1]).to.equal(_A(999));

    await expect(
      rm.connect(backend).replacePolicy([...policy], policy.payout, _A(9), policy.lossProb, policy.expiration, 1234)
    )
      .to.be.revertedWithCustomError(pool, "InvalidPolicyReplacement")
      .withArgs(policy, captureAny.value);

    const now = await helpers.time.latest();
    await expect(
      rm.connect(backend).replacePolicy([...policy], policy.payout, policy.premium, policy.lossProb, now + 3600, 1234)
    ).to.be.revertedWithCustomError(pool, "InvalidPolicyReplacement");
  });

  it("It reverts if the premium >= payout", async () => {
    const { policy, rm } = await helpers.loadFixture(deployRmWithPolicyFixture);

    await expect(
      rm.connect(backend).replacePolicy([...policy], _A(100), _A(101), policy.lossProb, policy.expiration, 1234)
    )
      .to.be.revertedWithCustomError(rm, "PremiumExceedsPayout")
      .withArgs(_A(101), _A(100));
  });

  it("Reverts if new policy is lower than previous with premium == MaxUint256", async () => {
    const { policy, rm, pool } = await helpers.loadFixture(deployRmWithPolicyFixture);

    const minPremium = await rm.getMinimumPremium(policy.payout, policy.lossProb, policy.expiration);
    expect(minPremium < policy.premium).to.be.true;
    await expect(
      rm
        .connect(backend)
        .replacePolicy([...policy], policy.payout, MaxUint256, policy.lossProb, policy.expiration, 1234)
    )
      .to.be.revertedWithCustomError(pool, "InvalidPolicyReplacement")
      .withArgs(policy, captureAny.value);
  });

  it("It reverts if new policy exceeds max duration", async () => {
    const { policy, rm } = await helpers.loadFixture(deployRmWithPolicyFixture);
    const now = await helpers.time.latest();
    // Max Duration = 8760
    const newExp = 8760 * 3600 + now + 1000;
    await expect(
      rm.connect(backend).replacePolicy([...policy], policy.payout, MaxUint256, policy.lossProb, newExp, 1234)
    )
      .to.be.revertedWithCustomError(rm, "PolicyExceedsMaxDuration")
      .withArgs(8760);
  });

  it("It reverts if new payout > maxPayoutPerPolicy", async () => {
    const { policy, rm } = await helpers.loadFixture(deployRmWithPolicyFixture);

    const maxPayoutPerPolicy = await rm.maxPayoutPerPolicy();
    const newPayout = maxPayoutPerPolicy + 1n;
    await expect(
      rm
        .connect(backend)
        .replacePolicy([...policy], newPayout, policy.premium, policy.lossProb, policy.expiration, 1234)
    )
      .to.be.revertedWithCustomError(rm, "PayoutExceedsMaxPerPolicy")
      .withArgs(newPayout, maxPayoutPerPolicy);
  });

  it("It reverts if _activeExposure > exposureLimit", async () => {
    const { policy, rm, pool, currency } = await helpers.loadFixture(deployRmWithPolicyFixture);

    expect(await rm.exposureLimit()).to.be.equal(_A(1000000));
    // Set exposureLimit to 1500 and maxPayoutPerPolicy to allow bigger policies
    await rm.setParam(RiskModuleParameter.maxPayoutPerPolicy, _A(3000));
    await rm.setParam(RiskModuleParameter.exposureLimit, _A(1100));
    expect(await rm.exposureLimit()).to.be.equal(_A(1100));

    await currency.connect(backend).approve(pool, _A(200));

    await expect(
      rm.connect(backend).replacePolicy([...policy], _A(2000), _A(200), policy.lossProb, policy.expiration, 1234)
    )
      .to.be.revertedWithCustomError(rm, "ExposureLimitExceeded")
      .withArgs(_A(2000), _A(1100));
  });

  it("Rejects replace policy if the pool is paused", async () => {
    const { policy, rm, pool } = await helpers.loadFixture(deployRmWithPolicyFixture);

    await expect(pool.connect(owner).pause()).to.emit(pool, "Paused");

    await expect(
      rm
        .connect(backend)
        .replacePolicy([...policy], policy.payout, policy.premium, policy.lossProb, policy.expiration, 1234)
    ).to.be.revertedWithCustomError(pool, "EnforcedPause");
  });

  it("Should emit PolicyReplaced when policy is replaced", async () => {
    const { policy, rm, pool } = await helpers.loadFixture(deployRmWithPolicyFixture);

    await expect(
      rm
        .connect(backend)
        .replacePolicy([...policy], policy.payout, policy.premium, policy.lossProb, policy.expiration, 1234)
    )
      .to.emit(pool, "NewPolicy")
      .to.emit(pool, "PolicyReplaced")
      .withArgs(rm, policy.id, policy.id - 123n + 1234n);
  });

  async function makePolicy({ payout, premium, lossProbability, expiration, payer, onBehalfOf, internalId }) {
    const now = await helpers.time.latest();
    const policy = {
      payout: payout || _A(1000),
      premium: premium || _A(110),
      lossProbability: lossProbability || _W("0.1"),
      expiration: expiration || now + 3600 * 5,
      payer: payer || ZeroAddress,
      onBehalfOf: onBehalfOf || cust,
      internalId: internalId || 123,
    };
    policy.toArgs = () => [
      policy.payout,
      policy.premium,
      policy.lossProbability,
      policy.expiration,
      policy.payer,
      policy.onBehalfOf,
      policy.internalId,
    ];
    return policy;
  }
});
