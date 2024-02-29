const { expect } = require("chai");
const { ethers } = require("hardhat");
const { MaxUint256 } = require("ethers");
const { RiskModuleParameter } = require("../js/enums");
const helpers = require("@nomicfoundation/hardhat-network-helpers");
const { grantRole, amountFunction, _W, getTransactionEvent } = require("../js/utils");
const { initCurrency, deployPool, deployPremiumsAccount, addRiskModule, addEToken } = require("../js/test-utils");

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
      grantRoles: ["LEVEL1_ROLE", "LEVEL2_ROLE"],
      treasuryAddress: "0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199", // Random address
    });
    pool._A = _A;

    const accessManager = await hre.ethers.getContractAt("AccessManager", await pool.access());
    return { pool, accessManager, currency };
  }

  async function deployRiskModuleFixture() {
    const { pool, accessManager, currency } = await helpers.loadFixture(deployPoolFixture);
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

    await accessManager.grantComponentRole(rm, await rm.PRICER_ROLE(), backend);
    await accessManager.grantComponentRole(rm, await rm.RESOLVER_ROLE(), backend);
    await accessManager.grantComponentRole(rm, await rm.REPLACER_ROLE(), backend);

    return { etk, premiumsAccount, rm, RiskModule, pool, accessManager, currency };
  }

  async function deployRmWithPolicyFixture() {
    const { rm, pool, currency, accessManager, premiumsAccount } = await helpers.loadFixture(deployRiskModuleFixture);
    const now = await helpers.time.latest();

    // Deploy a new policy
    await currency.connect(cust).approve(pool, _A(110));
    await currency.connect(cust).approve(backend, _A(110));

    const tx = await rm.connect(backend).newPolicy(
      _A(1000), // payout
      _A(10), // premium
      _W(0), // lossProb
      now + 3600 * 5, // expiration
      cust, // payer
      cust, // holder
      123 // internalId
    );

    const receipt = await tx.wait();

    // Try to resolve it without going through the riskModule
    const newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");

    return { policy: newPolicyEvt.args.policy, receipt, rm, currency, accessManager, pool, premiumsAccount };
  }

  it("Set params jrCollRatio validations", async () => {
    const { rm, accessManager } = await helpers.loadFixture(deployRiskModuleFixture);

    let jrCollRatio = 0;
    await rm.setParam(1, jrCollRatio);

    await grantRole(hre, accessManager, "LEVEL3_ROLE", lp);
    await rm.connect(lp).setParam(1, jrCollRatio);

    jrCollRatio = 100;
    await expect(rm.connect(lp).setParam(1, jrCollRatio)).to.be.revertedWith("Tweak exceeded");
  });

  it("Allows msg.sender as payer", async () => {
    const { pool, rm, currency } = await helpers.loadFixture(deployRiskModuleFixture);
    await currency.connect(backend).approve(pool, _A(110));

    const policy = await makePolicy({ payer: backend });
    await rm.connect(backend).newPolicy(...policy.toArgs());

    // The premium was payed by the caller
    expect(await currency.balanceOf(cust)).to.equal(_A(500));
    expect(await currency.balanceOf(backend)).to.equal(_A(890));
  });

  it("Doesn't allow another payer by default", async () => {
    const { pool, rm, currency } = await helpers.loadFixture(deployRiskModuleFixture);

    // The customer approved the spending for the pool
    await currency.connect(cust).approve(pool, _A(110));

    const policy = await makePolicy({ payer: cust });
    await expect(rm.connect(backend).newPolicy(...policy.toArgs())).to.be.revertedWith(
      "Payer must allow caller to transfer the premium"
    );

    expect(await currency.balanceOf(cust)).to.equal(_A(500));
    expect(await currency.balanceOf(backend)).to.equal(_A(1000));
  });

  it("Allows another payer given the right allowances", async () => {
    const { pool, rm, currency } = await helpers.loadFixture(deployRiskModuleFixture);

    // The customer approved the spending for the pool
    await currency.connect(cust).approve(pool, _A(110));

    // And also allowed the backend
    await currency.connect(cust).approve(backend, _A(110));

    const policy = await makePolicy({ payer: cust });
    await rm.connect(backend).newPolicy(...policy.toArgs());

    // The premium was paid by the customer
    expect(await currency.balanceOf(cust)).to.equal(_A(390));
    expect(await currency.balanceOf(backend)).to.equal(_A(1000));
  });

  it("Does not allow an exposure limit of zero", async () => {
    const { pool, premiumsAccount, RiskModule } = await helpers.loadFixture(deployRiskModuleFixture);

    await expect(
      addRiskModule(pool, premiumsAccount, RiskModule, {
        exposureLimit: 0,
        extraArgs: [],
      })
    ).to.be.revertedWith("Exposure and MaxPayout must be >0");
  });

  it("Does not allow wallet with zero address", async () => {
    const { pool, premiumsAccount, RiskModule } = await helpers.loadFixture(deployRiskModuleFixture);
    await expect(
      addRiskModule(pool, premiumsAccount, RiskModule, {
        wallet: hre.ethers.ZeroAddress,
        extraArgs: [],
      })
    ).to.be.revertedWith("Validation: Wallet can't be zero address");
  });

  it("Does not allow a maxpayout of zero", async () => {
    const { pool, premiumsAccount, RiskModule } = await helpers.loadFixture(deployRiskModuleFixture);
    await expect(
      addRiskModule(pool, premiumsAccount, RiskModule, {
        maxPayoutPerPolicy: 0,
        extraArgs: [],
      })
    ).to.be.revertedWith("Exposure and MaxPayout must be >0");
  });

  it("Reverts if new policy is lower than previous", async () => {
    const { policy, rm } = await helpers.loadFixture(deployRmWithPolicyFixture);

    // Old Policy: { payout= 1000, premium = 10, expiration= now + 3600 + 5}
    await expect(
      rm.connect(backend).replacePolicy([...policy], _A(999), policy.premium, policy.lossProb, policy.expiration, 1234)
    ).to.be.revertedWith("Policy replacement must be greater or equal than old policy");

    await expect(
      rm.connect(backend).replacePolicy([...policy], policy.payout, _A(9), policy.lossProb, policy.expiration, 1234)
    ).to.be.revertedWith("Policy replacement must be greater or equal than old policy");

    const now = await helpers.time.latest();
    await expect(
      rm.connect(backend).replacePolicy([...policy], policy.payout, policy.premium, policy.lossProb, now + 3600, 1234)
    ).to.be.revertedWith("Policy replacement must be greater or equal than old policy");
  });

  it("It reverts if the premium >= payout", async () => {
    const { policy, rm } = await helpers.loadFixture(deployRmWithPolicyFixture);

    await expect(
      rm.connect(backend).replacePolicy([...policy], _A(100), _A(101), policy.lossProb, policy.expiration, 1234)
    ).to.be.revertedWith("Premium must be less than payout");
  });

  it("Reverts if new policy is lower than previous with premium == MaxUint256", async () => {
    const { policy, rm } = await helpers.loadFixture(deployRmWithPolicyFixture);

    const minPremium = await rm.getMinimumPremium(policy.payout, policy.lossProb, policy.expiration);
    expect(minPremium < policy.premium).to.be.true;
    await expect(
      rm
        .connect(backend)
        .replacePolicy([...policy], policy.payout, MaxUint256, policy.lossProb, policy.expiration, 1234)
    ).to.be.revertedWith("Policy replacement must be greater or equal than old policy");
  });

  it("It reverts if new policy exceeds max duration", async () => {
    const { policy, rm } = await helpers.loadFixture(deployRmWithPolicyFixture);
    const now = await helpers.time.latest();
    // Max Duration = 8760
    const newExp = 8760 * 3600 + now + 1000;
    await expect(
      rm.connect(backend).replacePolicy([...policy], policy.payout, policy.premium, policy.lossProb, newExp, 1234)
    ).to.be.revertedWith("Policy exceeds max duration");
  });

  it("It reverts if new payout > maxPayoutPerPolicy", async () => {
    const { policy, rm } = await helpers.loadFixture(deployRmWithPolicyFixture);

    const newPayout = (await rm.maxPayoutPerPolicy()) + 1n;
    await expect(
      rm
        .connect(backend)
        .replacePolicy([...policy], newPayout, policy.premium, policy.lossProb, policy.expiration, 1234)
    ).to.be.revertedWith("RiskModule: Payout is more than maximum per policy");
  });

  it("It reverts if _activeExposure > exposureLimit", async () => {
    const { policy, rm } = await helpers.loadFixture(deployRmWithPolicyFixture);

    expect(await rm.exposureLimit()).to.be.equal(_A(1000000));
    // Set exposureLimit to 1500 and maxPayoutPerPolicy to allow bigger policies
    await rm.setParam(RiskModuleParameter.maxPayoutPerPolicy, _A(3000));
    await rm.setParam(RiskModuleParameter.exposureLimit, _A(1100));
    expect(await rm.exposureLimit()).to.be.equal(_A(1100));

    await expect(
      rm
        .connect(backend)
        .replacePolicy([...policy], policy.payout + _A(200), policy.premium, policy.lossProb, policy.expiration, 1234)
    ).to.be.revertedWith("RiskModule: Exposure limit exceeded");
  });

  it("Rejects replace policy if the RM is paused", async () => {
    const { policy, rm, accessManager } = await helpers.loadFixture(deployRmWithPolicyFixture);

    await grantRole(hre, accessManager, "GUARDIAN_ROLE", owner);
    await expect(rm.connect(owner).pause()).to.emit(rm, "Paused");

    await expect(
      rm
        .connect(backend)
        .replacePolicy([...policy], policy.payout, policy.premium, policy.lossProb, policy.expiration, 1234)
    ).to.be.revertedWith("Pausable: paused");
  });

  it("Should emit PolicyReplaced when policy is repla", async () => {
    const { policy, rm, pool } = await helpers.loadFixture(deployRmWithPolicyFixture);

    await expect(
      rm
        .connect(backend)
        .replacePolicy([...policy], policy.payout, policy.premium, policy.lossProb, policy.expiration, 1234)
    ).to.emit(pool, "PolicyReplaced");
  });

  async function makePolicy({ payout, premium, lossProbability, expiration, payer, onBehalfOf, internalId }) {
    const now = await helpers.time.latest();
    const policy = {
      payout: payout || _A(1000),
      premium: premium || _A(110),
      lossProbability: lossProbability || _W("0.1"),
      expiration: expiration || now + 3600 * 5,
      payer: payer || cust,
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
