const { expect } = require("chai");
const helpers = require("@nomicfoundation/hardhat-network-helpers");
const { amountFunction } = require("@ensuro/utils/js/utils");
const { initCurrency } = require("@ensuro/utils/js/test-utils");
const { deployAMPProxy, getAccessManager } = require("@ensuro/access-managed-proxy/js/deployProxy");
const { deployPool, deployPremiumsAccount, addRiskModule, addEToken, makeAllPublic } = require("../js/test-utils");
const { ampConfig } = require("../js/ampConfig");

const { ethers } = hre;
const { ZeroAddress } = ethers;

const emptyBytes = ethers.toUtf8Bytes("");

describe("Test Upgrade contracts", function () {
  async function setupFixture() {
    const [owner, cust, lp, guardian, level1] = await hre.ethers.getSigners();
    const _A = amountFunction(6);

    const currency = await initCurrency(
      { name: "Test USDC", symbol: "USDC", decimals: 6, initial_supply: _A(10000) },
      [lp, cust],
      [_A(5000), _A(500)]
    );

    const PolicyPool = await hre.ethers.getContractFactory("PolicyPool");

    return {
      currency,
      _A,
      owner,
      guardian,
      level1,
      lp,
      cust,
      PolicyPool,
    };
  }

  async function setupFixtureWithPool() {
    const ret = await setupFixture();
    const pool = await deployPool({ currency: ret.currency });
    pool._A = ret._A;
    return { pool, ...ret };
  }

  async function setupFixtureWithPoolAndWL() {
    const ret = await setupFixtureWithPool();
    const Whitelist = await hre.ethers.getContractFactory("LPManualWhitelist");
    const poolAddr = await hre.ethers.resolveAddress(ret.pool);
    const acMgr = await getAccessManager(ret.pool);
    const wl = await deployAMPProxy(Whitelist, [[2, 1, 1, 2]], {
      kind: "uups",
      constructorArgs: [poolAddr],
      acMgr,
      ...ampConfig.LPManualWhitelist,
    });
    await makeAllPublic(wl, acMgr);

    return { Whitelist, wl, ...ret };
  }

  async function setupFixtureWithPoolAndPA() {
    const ret = await setupFixtureWithPool();
    const etk = await addEToken(ret.pool, {});
    const premiumsAccount = await deployPremiumsAccount(ret.pool, { srEtk: etk });
    return { premiumsAccount, etk, ...ret };
  }

  async function setupFixtureWithPoolAndPAWithoutETK() {
    const ret = await setupFixtureWithPool();
    const premiumsAccount = await deployPremiumsAccount(ret.pool, {});
    return {
      premiumsAccount,
      ...ret,
    };
  }

  async function setupFixtureWithPoolAndRM() {
    const ret = await setupFixtureWithPoolAndPA();
    const RiskModule = await hre.ethers.getContractFactory("RiskModule");
    const rm = await addRiskModule(ret.pool, ret.premiumsAccount, {});
    return { rm, RiskModule, ...ret };
  }

  it("Should be able to upgrade PolicyPool", async () => {
    const { pool, guardian, currency } = await helpers.loadFixture(setupFixtureWithPoolAndPA);
    const PolicyPool = await hre.ethers.getContractFactory("PolicyPool");
    const newImpl = await PolicyPool.deploy(currency);

    await pool.connect(guardian).upgradeToAndCall(newImpl, emptyBytes);
  });

  it("Shouldn't be able to upgrade PolicyPool changing the Currency", async () => {
    const { pool } = await helpers.loadFixture(setupFixtureWithPoolAndPA);
    const PolicyPool = await hre.ethers.getContractFactory("PolicyPool");
    const newImpl = await PolicyPool.deploy("0x9a5c5a447a4A324771107140EfC226aA6b3be7F4"); // Random Address

    await expect(pool.upgradeToAndCall(newImpl, emptyBytes)).to.be.revertedWithCustomError(
      pool,
      "UpgradeCannotChangeCurrency"
    );
  });

  it("Should be able to upgrade EToken", async () => {
    const { pool, guardian, etk } = await helpers.loadFixture(setupFixtureWithPoolAndPA);
    const EToken = await hre.ethers.getContractFactory("EToken");
    const newImpl = await EToken.deploy(pool);

    await etk.connect(guardian).upgradeToAndCall(newImpl, emptyBytes);
  });

  it("Can upgrade EToken with componentRole", async () => {
    const { pool, cust, etk } = await helpers.loadFixture(setupFixtureWithPoolAndPA);
    const EToken = await hre.ethers.getContractFactory("EToken");
    const newEToken = await EToken.deploy(pool);

    await etk.connect(cust).upgradeToAndCall(newEToken, emptyBytes);
  });

  it("Should not be able to upgrade EToken with different pool", async () => {
    const { guardian, etk, currency, _A } = await helpers.loadFixture(setupFixtureWithPoolAndPA);
    const newPool = await deployPool({
      currency: currency,
      grantRoles: [],
      treasuryAddress: "0x7291Ba1DC551b666c49Da22dE76eC7ceEB51AeDC", // Random address
    });
    newPool._A = _A;

    const EToken = await hre.ethers.getContractFactory("EToken");
    const newImpl = await EToken.deploy(newPool);

    await expect(etk.connect(guardian).upgradeToAndCall(newImpl, emptyBytes)).to.be.revertedWithCustomError(
      etk,
      "UpgradeCannotChangePolicyPool"
    );
  });

  it("Should be able to upgrade PremiumsAccount contract", async () => {
    const { guardian, pool, premiumsAccount, etk } = await helpers.loadFixture(setupFixtureWithPoolAndPA);
    const PremiumsAccount = await hre.ethers.getContractFactory("PremiumsAccount");
    const newImpl = await PremiumsAccount.deploy(pool, ZeroAddress, etk);

    await premiumsAccount.connect(guardian).upgradeToAndCall(newImpl, emptyBytes);
  });

  it("Can upgrade PremiumsAccount with componentRole", async () => {
    const { cust, pool, premiumsAccount, etk } = await helpers.loadFixture(setupFixtureWithPoolAndPA);
    const PremiumsAccount = await hre.ethers.getContractFactory("PremiumsAccount");
    const newPremiumsAccount = await PremiumsAccount.deploy(pool, ZeroAddress, etk);

    await premiumsAccount.connect(cust).upgradeToAndCall(newPremiumsAccount, emptyBytes);
  });

  it("Should not be able to upgrade PremiumsAccount with different pool or jrEtk", async () => {
    const { guardian, pool, premiumsAccount, etk, currency, _A } = await helpers.loadFixture(setupFixtureWithPoolAndPA);
    const newPool = await deployPool({
      currency: currency,
      grantRoles: [],
      treasuryAddress: "0x7291Ba1DC551b666c49Da22dE76eC7ceEB51AeDC", // Random address
    });
    newPool._A = _A;

    const PremiumsAccount = await hre.ethers.getContractFactory("PremiumsAccount");
    let newImpl = await PremiumsAccount.deploy(newPool, ZeroAddress, etk);

    await expect(premiumsAccount.connect(guardian).upgradeToAndCall(newImpl, emptyBytes)).to.be.revertedWithCustomError(
      premiumsAccount,
      "UpgradeCannotChangePolicyPool"
    );

    newImpl = await PremiumsAccount.deploy(pool, ZeroAddress, ZeroAddress);
    await expect(premiumsAccount.connect(guardian).upgradeToAndCall(newImpl, emptyBytes))
      .to.be.revertedWithCustomError(premiumsAccount, "InvalidUpgradeETokenChanged")
      .withArgs(await premiumsAccount.seniorEtk(), ZeroAddress);

    // Changing jrEtk from 0 to something is possible
    const jrEtk = await addEToken(pool, {});
    newImpl = await PremiumsAccount.deploy(pool, jrEtk, etk);
    await premiumsAccount.connect(guardian).upgradeToAndCall(newImpl, emptyBytes);

    newImpl = await PremiumsAccount.deploy(pool, ZeroAddress, etk);
    await expect(premiumsAccount.connect(guardian).upgradeToAndCall(newImpl, emptyBytes))
      .to.be.revertedWithCustomError(premiumsAccount, "InvalidUpgradeETokenChanged")
      .withArgs(jrEtk, ZeroAddress);
  });

  it("Should be able to deploy PremiumsAccount without eTokens and upgrade to have them", async () => {
    const { guardian, pool, premiumsAccount } = await helpers.loadFixture(setupFixtureWithPoolAndPAWithoutETK);
    const PremiumsAccount = await hre.ethers.getContractFactory("PremiumsAccount");

    let newImpl = await PremiumsAccount.deploy(pool, ZeroAddress, ZeroAddress);
    await expect(premiumsAccount.connect(guardian).upgradeToAndCall(newImpl, emptyBytes)).not.to.be.reverted;

    // Changing jrEtk from 0 to something is possible
    const jrEtk = await addEToken(pool, {});
    newImpl = await PremiumsAccount.deploy(pool, jrEtk, ZeroAddress);
    await premiumsAccount.connect(guardian).upgradeToAndCall(newImpl, emptyBytes);

    // Changing srEtk from 0 to something is possible
    const srEtk = await addEToken(pool, {});
    newImpl = await PremiumsAccount.deploy(pool, jrEtk, srEtk);
    await premiumsAccount.connect(guardian).upgradeToAndCall(newImpl, emptyBytes);

    // Changing srEtk to something else is not possible
    const otherSrEtk = await addEToken(pool, {});
    newImpl = await PremiumsAccount.deploy(pool, jrEtk, otherSrEtk);
    await expect(premiumsAccount.connect(guardian).upgradeToAndCall(newImpl, emptyBytes))
      .to.be.revertedWithCustomError(premiumsAccount, "InvalidUpgradeETokenChanged")
      .withArgs(await premiumsAccount.seniorEtk(), otherSrEtk);
  });

  it("Should be able to upgrade RiskModule contract", async () => {
    const { guardian, pool, premiumsAccount, RiskModule, rm } = await helpers.loadFixture(setupFixtureWithPoolAndRM);
    const newRM = await RiskModule.deploy(pool, premiumsAccount);

    await rm.connect(guardian).upgradeToAndCall(newRM, emptyBytes);
  });

  it("Can upgrade RiskModule with componentRole", async () => {
    const { cust, pool, premiumsAccount, RiskModule, rm } = await helpers.loadFixture(setupFixtureWithPoolAndRM);
    const newRM = await RiskModule.deploy(pool, premiumsAccount);

    await rm.connect(cust).upgradeToAndCall(newRM, emptyBytes);
  });

  it("Should not be able to upgrade RiskModule with different pool or PremiumsAccount", async () => {
    const { guardian, pool, rm, currency, _A, RiskModule } = await helpers.loadFixture(setupFixtureWithPoolAndRM);
    const newPool = await deployPool({
      currency: currency,
      grantRoles: [],
      treasuryAddress: "0x7291Ba1DC551b666c49Da22dE76eC7ceEB51AeDC", // Random address
    });
    newPool._A = _A;
    const newPA = await deployPremiumsAccount(newPool, {});

    let newImpl = await RiskModule.deploy(newPool, newPA);

    await expect(rm.connect(guardian).upgradeToAndCall(newImpl, emptyBytes)).to.be.revertedWithCustomError(
      rm,
      "UpgradeCannotChangePolicyPool"
    );
    const newPAOrigPool = await deployPremiumsAccount(pool, {});

    newImpl = await RiskModule.deploy(pool, newPAOrigPool);
    await expect(rm.connect(guardian).upgradeToAndCall(newImpl, emptyBytes)).to.be.revertedWithCustomError(
      rm,
      "UpgradeCannotChangePremiumsAccount"
    );
  });

  it("Should be able to upgrade Whitelist", async () => {
    const { pool, guardian, wl, Whitelist } = await helpers.loadFixture(setupFixtureWithPoolAndWL);
    const newImpl = await Whitelist.deploy(pool);

    await wl.connect(guardian).upgradeToAndCall(newImpl, emptyBytes);
  });

  it("Can upgrade Whitelist with componentRole", async () => {
    const { pool, cust, wl, Whitelist } = await helpers.loadFixture(setupFixtureWithPoolAndWL);
    const newWL = await Whitelist.deploy(pool);

    await wl.connect(cust).upgradeToAndCall(newWL, emptyBytes);
  });
});
