const { expect } = require("chai");
const helpers = require("@nomicfoundation/hardhat-network-helpers");
const {
  grantRole,
  grantComponentRole,
  amountFunction,
  getComponentRole,
  getAddress,
} = require("@ensuro/utils/js/utils");
const { initCurrency } = require("@ensuro/utils/js/test-utils");
const { deployPool, deployPremiumsAccount, addRiskModule, addEToken } = require("../js/test-utils");

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

    const AccessManager = await hre.ethers.getContractFactory("AccessManager");
    const PolicyPool = await hre.ethers.getContractFactory("PolicyPool");

    // Deploy AccessManager
    const access = await hre.upgrades.deployProxy(AccessManager, [], { kind: "uups" });

    await grantRole(hre, access, "GUARDIAN_ROLE", guardian);
    await grantRole(hre, access, "LEVEL1_ROLE", level1);

    await access.waitForDeployment();

    return {
      currency,
      _A,
      owner,
      guardian,
      level1,
      lp,
      cust,
      access,
      PolicyPool,
    };
  }

  async function setupFixtureWithPool() {
    const ret = await setupFixture();
    const pool = await deployPool({ currency: ret.currency, access: ret.access });
    pool._A = ret._A;
    return { pool, ...ret };
  }

  async function setupFixtureWithPoolAndWL() {
    const ret = await setupFixtureWithPool();
    const Whitelist = await hre.ethers.getContractFactory("LPManualWhitelist");
    const poolAddr = await hre.ethers.resolveAddress(ret.pool);
    const wl = await hre.upgrades.deployProxy(Whitelist, [[2, 1, 1, 2]], {
      kind: "uups",
      constructorArgs: [poolAddr],
    });

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
    const TrustfulRiskModule = await hre.ethers.getContractFactory("TrustfulRiskModule");
    const rm = await addRiskModule(ret.pool, ret.premiumsAccount, TrustfulRiskModule, {});
    return { rm, TrustfulRiskModule, ...ret };
  }

  it("Should be able to upgrade PolicyPool", async () => {
    const { pool, cust, guardian, currency, access } = await helpers.loadFixture(setupFixtureWithPoolAndPA);
    const PolicyPool = await hre.ethers.getContractFactory("PolicyPool");
    const newImpl = await PolicyPool.deploy(access, currency);

    // Cust cant upgrade
    await expect(pool.connect(cust).upgradeToAndCall(newImpl, emptyBytes)).to.be.revertedWithACError(
      access,
      cust,
      "LEVEL1_ROLE"
    );

    await pool.connect(guardian).upgradeToAndCall(newImpl, emptyBytes);
  });

  it("Shouldn't be able to upgrade PolicyPool changing the AccessManager", async () => {
    const { pool, level1, currency, access } = await helpers.loadFixture(setupFixtureWithPoolAndPA);
    const PolicyPool = await hre.ethers.getContractFactory("PolicyPool");
    const newImpl = await PolicyPool.deploy(currency, access); // Inverted addresses

    await expect(pool.connect(level1).upgradeToAndCall(newImpl, emptyBytes)).to.be.revertedWithCustomError(
      pool,
      "UpgradeCannotChangeAccess"
    );
  });

  it("Should be able to upgrade EToken", async () => {
    const { pool, cust, guardian, etk, access } = await helpers.loadFixture(setupFixtureWithPoolAndPA);
    const EToken = await hre.ethers.getContractFactory("EToken");
    const newImpl = await EToken.deploy(pool);

    // Cust cant upgrade
    await expect(etk.connect(cust).upgradeToAndCall(newImpl, emptyBytes)).to.be.revertedWithACError(
      access,
      cust,
      getComponentRole(getAddress(etk), "LEVEL1_ROLE")
    );

    await etk.connect(guardian).upgradeToAndCall(newImpl, emptyBytes);
  });

  it("Can upgrade EToken with componentRole", async () => {
    const { pool, cust, etk, access } = await helpers.loadFixture(setupFixtureWithPoolAndPA);
    const EToken = await hre.ethers.getContractFactory("EToken");
    const newEToken = await EToken.deploy(pool);

    // Cust cant upgrade
    await expect(etk.connect(cust).upgradeToAndCall(newEToken, emptyBytes)).to.be.revertedWithACError(
      access,
      cust,
      getComponentRole(getAddress(etk), "LEVEL1_ROLE")
    );

    await grantComponentRole(hre, access, etk, "LEVEL1_ROLE", cust);
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
    const { guardian, cust, pool, premiumsAccount, etk, access } = await helpers.loadFixture(setupFixtureWithPoolAndPA);
    const PremiumsAccount = await hre.ethers.getContractFactory("PremiumsAccount");
    const newImpl = await PremiumsAccount.deploy(pool, ZeroAddress, etk);

    // Cust cant upgrade
    await expect(premiumsAccount.connect(cust).upgradeToAndCall(newImpl, emptyBytes)).to.be.revertedWithACError(
      access,
      cust,
      getComponentRole(getAddress(premiumsAccount), "LEVEL1_ROLE")
    );

    await premiumsAccount.connect(guardian).upgradeToAndCall(newImpl, emptyBytes);
  });

  it("Can upgrade PremiumsAccount with componentRole", async () => {
    const { cust, pool, premiumsAccount, etk, access } = await helpers.loadFixture(setupFixtureWithPoolAndPA);
    const PremiumsAccount = await hre.ethers.getContractFactory("PremiumsAccount");
    const newPremiumsAccount = await PremiumsAccount.deploy(pool, ZeroAddress, etk);

    // Cust cant upgrade
    await expect(
      premiumsAccount.connect(cust).upgradeToAndCall(newPremiumsAccount, emptyBytes)
    ).to.be.revertedWithACError(access, cust, getComponentRole(getAddress(premiumsAccount), "LEVEL1_ROLE"));

    await grantComponentRole(hre, access, premiumsAccount, "LEVEL1_ROLE", cust);
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
    await expect(premiumsAccount.connect(guardian).upgradeToAndCall(newImpl, emptyBytes)).to.be.revertedWith(
      "Can't upgrade changing the Senior ETK unless to non-zero"
    );

    // Changing jrEtk from 0 to something is possible
    const jrEtk = await addEToken(pool, {});
    newImpl = await PremiumsAccount.deploy(pool, jrEtk, etk);
    await premiumsAccount.connect(guardian).upgradeToAndCall(newImpl, emptyBytes);

    newImpl = await PremiumsAccount.deploy(pool, ZeroAddress, etk);
    await expect(premiumsAccount.connect(guardian).upgradeToAndCall(newImpl, emptyBytes)).to.be.revertedWith(
      "Can't upgrade changing the Junior ETK unless to non-zero"
    );
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
    await expect(premiumsAccount.connect(guardian).upgradeToAndCall(newImpl, emptyBytes)).to.be.revertedWith(
      "Can't upgrade changing the Senior ETK unless to non-zero"
    );
  });

  it("Should be able to upgrade RiskModule contract", async () => {
    const { cust, guardian, pool, premiumsAccount, TrustfulRiskModule, rm, access } =
      await helpers.loadFixture(setupFixtureWithPoolAndRM);
    const newRM = await TrustfulRiskModule.deploy(pool, premiumsAccount);

    // Cust cant upgrade
    await expect(rm.connect(cust).upgradeToAndCall(newRM, emptyBytes)).to.be.revertedWithACError(
      access,
      cust,
      getComponentRole(getAddress(rm), "LEVEL1_ROLE")
    );
    await rm.connect(guardian).upgradeToAndCall(newRM, emptyBytes);
  });

  it("Can upgrade RiskModule with componentRole", async () => {
    const { cust, pool, premiumsAccount, TrustfulRiskModule, rm, access } =
      await helpers.loadFixture(setupFixtureWithPoolAndRM);
    const newRM = await TrustfulRiskModule.deploy(pool, premiumsAccount);

    // Cust cant upgrade
    await expect(rm.connect(cust).upgradeToAndCall(newRM, emptyBytes)).to.be.revertedWithACError(
      access,
      cust,
      getComponentRole(getAddress(rm), "LEVEL1_ROLE")
    );

    await grantComponentRole(hre, access, rm, "LEVEL1_ROLE", cust);
    await rm.connect(cust).upgradeToAndCall(newRM, emptyBytes);
  });

  it("Should not be able to upgrade RiskModule with different pool or PremiumsAccount", async () => {
    const { guardian, pool, rm, currency, _A, TrustfulRiskModule } =
      await helpers.loadFixture(setupFixtureWithPoolAndRM);
    const newPool = await deployPool({
      currency: currency,
      grantRoles: [],
      treasuryAddress: "0x7291Ba1DC551b666c49Da22dE76eC7ceEB51AeDC", // Random address
    });
    newPool._A = _A;
    const newPA = await deployPremiumsAccount(newPool, {});

    let newImpl = await TrustfulRiskModule.deploy(newPool, newPA);

    await expect(rm.connect(guardian).upgradeToAndCall(newImpl, emptyBytes)).to.be.revertedWithCustomError(
      rm,
      "UpgradeCannotChangePolicyPool"
    );
    const newPAOrigPool = await deployPremiumsAccount(pool, {});

    newImpl = await TrustfulRiskModule.deploy(pool, newPAOrigPool);
    await expect(rm.connect(guardian).upgradeToAndCall(newImpl, emptyBytes)).to.be.revertedWithCustomError(
      rm,
      "UpgradeCannotChangePremiumsAccount"
    );
  });

  it("Should be able to upgrade Whitelist", async () => {
    const { pool, cust, guardian, wl, Whitelist, access } = await helpers.loadFixture(setupFixtureWithPoolAndWL);
    const newImpl = await Whitelist.deploy(pool);

    // Cust cant upgrade
    await expect(wl.connect(cust).upgradeToAndCall(newImpl, emptyBytes)).to.be.revertedWithACError(
      access,
      cust,
      getComponentRole(getAddress(wl), "LEVEL1_ROLE")
    );
    await wl.connect(guardian).upgradeToAndCall(newImpl, emptyBytes);
  });

  it("Can upgrade Whitelist with componentRole", async () => {
    const { pool, cust, wl, access, Whitelist } = await helpers.loadFixture(setupFixtureWithPoolAndWL);
    const newWL = await Whitelist.deploy(pool);

    // Cust cant upgrade
    await expect(wl.connect(cust).upgradeToAndCall(newWL, emptyBytes)).to.be.revertedWithACError(
      access,
      cust,
      getComponentRole(getAddress(wl), "LEVEL1_ROLE")
    );

    await grantComponentRole(hre, access, wl, "LEVEL1_ROLE", cust);
    await wl.connect(cust).upgradeToAndCall(newWL, emptyBytes);
  });

  it("Should be able to upgrade AccessManager contract", async () => {
    const { guardian, cust, access } = await helpers.loadFixture(setupFixtureWithPool);
    const AccessManager = await hre.ethers.getContractFactory("AccessManager");
    const newAM = await AccessManager.deploy();

    // Cust cant upgrade
    await expect(access.connect(cust).upgradeToAndCall(newAM, emptyBytes)).to.be.revertedWithACError(
      access,
      cust,
      "LEVEL1_ROLE"
    );
    await access.connect(guardian).upgradeToAndCall(newAM, emptyBytes);
  });
});
