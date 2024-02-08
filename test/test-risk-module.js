const { expect } = require("chai");
const { grantRole, amountFunction, _W } = require("../js/utils");
const { initCurrency, deployPool, deployPremiumsAccount, addRiskModule, addEToken } = require("../js/test-utils");
const { ethers } = require("hardhat");
const helpers = require("@nomicfoundation/hardhat-network-helpers");

// NOTICE: This tests only cover the bits not already covered by the python tests in the `tests`
// directory.
//
// Namely, the RiskModule internals that are not reachable through TrustfulRiskModule are tested
// here through a mock contract.

describe("RiskModule contract", function () {
  let currency;
  let pool;
  let accessManager;
  let premiumsAccount;
  let _A;
  let backend, cust, lp;
  let RiskModule;
  let rm;

  beforeEach(async () => {
    [, lp, cust, backend] = await ethers.getSigners();

    _A = amountFunction(6);

    currency = await initCurrency(
      { name: "Test USDC", symbol: "USDC", decimals: 6, initial_supply: _A(10000) },
      [lp, cust, backend],
      [_A(5000), _A(500), _A(1000)]
    );

    pool = await deployPool({
      currency: currency.target,
      grantRoles: ["LEVEL1_ROLE", "LEVEL2_ROLE"],
      treasuryAddress: "0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199", // Random address
    });
    pool._A = _A;

    const etk = await addEToken(pool, {});

    premiumsAccount = await deployPremiumsAccount(pool, { srEtkAddr: etk.target });

    accessManager = await ethers.getContractAt("AccessManager", await pool.access());

    RiskModule = await ethers.getContractFactory("RiskModuleMock");

    await currency.connect(lp).approve(pool.target, _A(5000));
    await pool.connect(lp).deposit(etk.target, _A(5000));

    rm = await addRiskModule(pool, premiumsAccount, RiskModule, {
      extraArgs: [],
    });
    await accessManager.grantComponentRole(rm.target, await rm.PRICER_ROLE(), backend.address);
  });

  it("Set params jrCollRatio validations", async () => {
    let jrCollRatio = 0;
    await rm.setParam(1, jrCollRatio);

    await grantRole(hre, accessManager, "LEVEL3_ROLE", lp.address);
    await rm.connect(lp).setParam(1, jrCollRatio);

    jrCollRatio = 100;
    await expect(rm.connect(lp).setParam(1, jrCollRatio)).to.be.revertedWith("Tweak exceeded");
  });

  it("Allows msg.sender as payer", async () => {
    await currency.connect(backend).approve(pool.target, _A(110));

    const policy = await makePolicy({ payer: backend.address });
    await rm.connect(backend).newPolicy(...policy.toArgs());

    // The premium was payed by the caller
    expect(await currency.balanceOf(cust.address)).to.equal(_A(500));
    expect(await currency.balanceOf(backend.address)).to.equal(_A(890));
  });

  it("Doesn't allow another payer by default", async () => {
    // The customer approved the spending for the pool
    await currency.connect(cust).approve(pool.target, _A(110));

    const policy = await makePolicy({ payer: cust.address });
    await expect(rm.connect(backend).newPolicy(...policy.toArgs())).to.be.revertedWith(
      "Payer must allow caller to transfer the premium"
    );

    expect(await currency.balanceOf(cust.address)).to.equal(_A(500));
    expect(await currency.balanceOf(backend.address)).to.equal(_A(1000));
  });

  it("Allows another payer given the right allowances", async () => {
    // The customer approved the spending for the pool
    await currency.connect(cust).approve(pool.target, _A(110));

    // And also allowed the backend
    await currency.connect(cust).approve(backend.address, _A(110));

    const policy = await makePolicy({ payer: cust.address });
    await rm.connect(backend).newPolicy(...policy.toArgs());

    // The premium was paid by the customer
    expect(await currency.balanceOf(cust.address)).to.equal(_A(390));
    expect(await currency.balanceOf(backend.address)).to.equal(_A(1000));
  });

  it("Does not allow an exposure limit of zero", async () => {
    await expect(
      addRiskModule(pool, premiumsAccount, RiskModule, {
        exposureLimit: 0,
        extraArgs: [],
      })
    ).to.be.revertedWith("Exposure and MaxPayout must be >0");
  });

  it("Does not allow wallet with zero address", async () => {
    await expect(
      addRiskModule(pool, premiumsAccount, RiskModule, {
        wallet: hre.ethers.ZeroAddress,
        extraArgs: [],
      })
    ).to.be.revertedWith("Validation: Wallet can't be zero address");
  });

  it("Does not allow a maxpayout of zero", async () => {
    await expect(
      addRiskModule(pool, premiumsAccount, RiskModule, {
        maxPayoutPerPolicy: 0,
        extraArgs: [],
      })
    ).to.be.revertedWith("Exposure and MaxPayout must be >0");
  });

  async function makePolicy({ payout, premium, lossProbability, expiration, payer, onBehalfOf, internalId }) {
    const now = await helpers.time.latest();
    const policy = {
      payout: payout || _A(1000),
      premium: premium || _A(110),
      lossProbability: lossProbability || _W("0.1"),
      expiration: expiration || now + 3600 * 5,
      payer: payer || cust.address,
      onBehalfOf: onBehalfOf || cust.address,
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
