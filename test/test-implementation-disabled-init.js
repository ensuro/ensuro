const { expect } = require("chai");
const hre = require("hardhat");
const helpers = require("@nomicfoundation/hardhat-network-helpers");

const { initCurrency } = require("@ensuro/utils/js/test-utils");
const { amountFunction, _W } = require("@ensuro/utils/js/utils");
const { deployPremiumsAccount, deployPool } = require("../js/test-utils");

const { ZeroAddress } = hre.ethers;

describe("Test Implementation contracts can't be initialized", function () {
  const rndAddr = "0xd758af6bfc2f0908d7c5f89942be52c36a6b3cab";

  async function setupFixture() {
    const [owner] = await hre.ethers.getSigners();

    const _A = amountFunction(6);

    const currency = await initCurrency({ name: "Test USDC", symbol: "USDC", decimals: 6, initial_supply: _A(10000) });
    const PolicyPool = await hre.ethers.getContractFactory("PolicyPool");

    return {
      currency,
      _A,
      owner,
      PolicyPool,
    };
  }

  async function setupFixtureWithPool() {
    const ret = await setupFixture();
    const policyPool = await deployPool({ currency: ret.currency });
    return {
      policyPool,
      ...ret,
    };
  }

  async function setupFixtureWithPoolAndPA() {
    const ret = await setupFixtureWithPool();
    const premiumsAccount = await deployPremiumsAccount(ret.policyPool, {});
    return {
      premiumsAccount,
      ...ret,
    };
  }

  it("Does not allow initialize PolicyPool implementation", async () => {
    const { currency, PolicyPool } = await helpers.loadFixture(setupFixture);
    const pool = await PolicyPool.deploy(currency);
    await expect(pool.initialize("Ensuro", "EPOL", rndAddr)).to.be.revertedWithCustomError(
      pool,
      "InvalidInitialization"
    );
  });

  it("Does not allow initialize EToken implementation", async () => {
    const { policyPool } = await helpers.loadFixture(setupFixtureWithPool);
    const EToken = await hre.ethers.getContractFactory("EToken");
    const etk = await EToken.deploy(policyPool);
    await expect(etk.initialize("eUSD Foobar", "eUSD", _W(1), _W("0.05"))).to.be.revertedWithCustomError(
      etk,
      "InvalidInitialization"
    );
  });

  it("Does not allow initialize PremiumsAccount implementation", async () => {
    const { policyPool } = await helpers.loadFixture(setupFixtureWithPool);
    const PremiumsAccount = await hre.ethers.getContractFactory("PremiumsAccount");
    const pa = await PremiumsAccount.deploy(policyPool, ZeroAddress, ZeroAddress);
    await expect(pa.initialize()).to.be.revertedWithCustomError(pa, "InvalidInitialization");
  });

  it("Does not allow initialize RiskModule implementation", async () => {
    const { policyPool, premiumsAccount } = await helpers.loadFixture(setupFixtureWithPoolAndPA);
    const RiskModule = await hre.ethers.getContractFactory("RiskModule");
    const rm = await RiskModule.deploy(policyPool, premiumsAccount);
    await expect(rm.initialize(ZeroAddress, rndAddr)).to.be.revertedWithCustomError(rm, "InvalidInitialization");
  });

  it("Does not allow initialize LPManualWhitelist implementation", async () => {
    const { policyPool } = await helpers.loadFixture(setupFixtureWithPool);
    const LPManualWhitelist = await hre.ethers.getContractFactory("LPManualWhitelist");
    const wh = await LPManualWhitelist.deploy(policyPool);
    await expect(wh.initialize([2, 1, 1, 2])).to.be.revertedWithCustomError(wh, "InvalidInitialization");
  });
});
