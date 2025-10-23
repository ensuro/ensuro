const { expect } = require("chai");
const hre = require("hardhat");
const helpers = require("@nomicfoundation/hardhat-network-helpers");

const { amountFunction } = require("@ensuro/utils/js/utils");
const { initCurrency } = require("@ensuro/utils/js/test-utils");
const { deployPool, deployPremiumsAccount, addRiskModule, addEToken } = require("../js/test-utils");
const { deployAMPProxy, getAccessManager } = require("@ensuro/access-managed-proxy/js/deployProxy");
const { ampConfig } = require("../js/ampConfig");

const { ZeroAddress } = hre.ethers;

describe("Test Initialize contracts", function () {
  async function protocolFixture() {
    const [lp, cust, guardian] = await hre.ethers.getSigners();

    const _A = amountFunction(6);

    const currency = await initCurrency(
      { name: "Test USDC", symbol: "USDC", decimals: 6, initial_supply: _A(10000) },
      [lp, cust],
      [_A(5000), _A(500)]
    );

    const pool = await deployPool({
      currency: currency,
      grantRoles: [],
      treasuryAddress: "0x87c47c9a5a2aa74ae714857d64911d9a091c25b1", // Random address
    });
    pool._A = _A;

    const etk = await addEToken(pool, {});

    const premiumsAccount = await deployPremiumsAccount(pool, { srEtk: etk });
    const rm = await addRiskModule(pool, premiumsAccount, {});

    await currency.connect(lp).approve(pool, _A(5000));
    await pool.connect(lp).deposit(etk, _A(3000), lp);

    return {
      currency,
      pool,
      premiumsAccount,
      lp,
      cust,
      guardian,
      _A,
      etk,
      rm,
    };
  }

  let pool;
  let premiumsAccount;
  let etk;
  let rm;

  beforeEach(async () => {
    ({ pool, premiumsAccount, etk, rm } = await helpers.loadFixture(protocolFixture));
  });

  it("Does not allow reinitializing PolicyPool", async () => {
    await expect(pool.initialize("PP", "PP", ZeroAddress)).to.be.revertedWithCustomError(pool, "InvalidInitialization");
  });

  it("Does not allow reinitializing Etoken", async () => {
    await expect(etk.initialize("ETK", "ETK", 0, 0)).to.be.revertedWithCustomError(pool, "InvalidInitialization");
  });

  it("Does not allow reinitializing PremiumsAccount", async () => {
    await expect(premiumsAccount.initialize()).to.be.revertedWithCustomError(pool, "InvalidInitialization");
  });

  it("Does not allow reinitializing RiskModule", async () => {
    await expect(rm.initialize(ZeroAddress, ZeroAddress)).to.be.revertedWithCustomError(pool, "InvalidInitialization");
  });

  it("Does not allow reinitializing Whitelist", async () => {
    const Whitelist = await hre.ethers.getContractFactory("LPManualWhitelist");
    const poolAddr = await hre.ethers.resolveAddress(pool);
    const acMgr = await getAccessManager(pool);
    const wl = await deployAMPProxy(Whitelist, [[2, 1, 1, 2]], {
      kind: "uups",
      constructorArgs: [poolAddr],
      acMgr,
      ...ampConfig.LPManualWhitelist,
    });
    await expect(wl.initialize([2, 1, 1, 2])).to.be.revertedWithCustomError(pool, "InvalidInitialization");
  });
});
