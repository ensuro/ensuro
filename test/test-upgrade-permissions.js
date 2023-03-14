const { expect } = require("chai");
const helpers = require("@nomicfoundation/hardhat-network-helpers");
const {
  initCurrency,
  deployPool,
  deployPremiumsAccount,
  addRiskModule,
  amountFunction,
  grantRole,
  grantComponentRole,
  addEToken,
} = require("./test-utils");

describe("Test Upgrade contracts", function () {
  const zeroAddress = ethers.constants.AddressZero;

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

    await grantRole(hre, access, "GUARDIAN_ROLE", guardian.address);
    await grantRole(hre, access, "LEVEL1_ROLE", level1.address);

    await access.deployed();

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
    const pool = await deployPool(hre, { currency: ret.currency.address, access: ret.access.address });
    pool._A = ret._A;
    return {
      pool,
      ...ret,
    };
  }

  async function setupFixtureWithPoolAndWL() {
    const ret = await setupFixtureWithPool();
    const Whitelist = await hre.ethers.getContractFactory("LPManualWhitelist");
    const wl = await hre.upgrades.deployProxy(Whitelist, [[2, 1, 1, 2]], {
      kind: "uups",
      unsafeAllow: ["delegatecall"],
      constructorArgs: [ret.pool.address],
    });

    return {
      Whitelist,
      wl,
      ...ret,
    };
  }

  async function setupFixtureWithPoolAndPA() {
    const ret = await setupFixtureWithPool();
    const etk = await addEToken(ret.pool, {});
    const premiumsAccount = await deployPremiumsAccount(hre, ret.pool, { srEtkAddr: etk.address });
    return {
      premiumsAccount,
      etk,
      ...ret,
    };
  }

  async function setupFixtureWithPoolAndRM() {
    const ret = await setupFixtureWithPoolAndPA();
    const TrustfulRiskModule = await ethers.getContractFactory("TrustfulRiskModule");
    const rm = await addRiskModule(ret.pool, ret.premiumsAccount, TrustfulRiskModule, {});
    return {
      rm,
      TrustfulRiskModule,
      ...ret,
    };
  }

  it("Should be able to upgrade PolicyPool", async () => {
    const { pool, cust, guardian, currency, access } = await helpers.loadFixture(setupFixtureWithPoolAndPA);
    const PolicyPool = await ethers.getContractFactory("PolicyPool");
    const newImpl = await PolicyPool.deploy(access.address, currency.address);

    // Cust cant upgrade
    await expect(pool.connect(cust).upgradeTo(newImpl.address)).to.be.revertedWith("AccessControl:");

    await pool.connect(guardian).upgradeTo(newImpl.address);
  });

  it("Shouldn't be able to upgrade PolicyPool changing the AccessManager", async () => {
    const { pool, level1, currency, access } = await helpers.loadFixture(setupFixtureWithPoolAndPA);
    const PolicyPool = await ethers.getContractFactory("PolicyPool");
    const newImpl = await PolicyPool.deploy(currency.address, access.address); // Inverted addresses

    await expect(pool.connect(level1).upgradeTo(newImpl.address)).to.be.revertedWith(
      "Can't upgrade changing the access manager"
    );
  });

  it("Shouldn't be able to upgrade PolicyPool changing the Currency", async () => {
    const { pool, level1, access } = await helpers.loadFixture(setupFixtureWithPoolAndPA);
    const PolicyPool = await ethers.getContractFactory("PolicyPool");
    const newImpl = await PolicyPool.deploy(access.address, access.address); // 2nd should be currency.address

    await expect(pool.connect(level1).upgradeTo(newImpl.address)).to.be.revertedWith(
      "Can't upgrade changing the currency"
    );
  });

  it("Should be able to upgrade EToken", async () => {
    const { pool, cust, guardian, etk } = await helpers.loadFixture(setupFixtureWithPoolAndPA);
    const EToken = await ethers.getContractFactory("EToken");
    const newImpl = await EToken.deploy(pool.address);

    // Cust cant upgrade
    await expect(etk.connect(cust).upgradeTo(newImpl.address)).to.be.revertedWith("AccessControl:");

    await etk.connect(guardian).upgradeTo(newImpl.address);
  });

  it("Can upgrade EToken with componentRole", async () => {
    const { pool, cust, etk, access } = await helpers.loadFixture(setupFixtureWithPoolAndPA);
    const EToken = await ethers.getContractFactory("EToken");
    const newEToken = await EToken.deploy(pool.address);

    // Cust cant upgrade
    await expect(etk.connect(cust).upgradeTo(newEToken.address)).to.be.revertedWith("AccessControl:");

    await grantComponentRole(hre, access, etk, "LEVEL1_ROLE", cust);
    await etk.connect(cust).upgradeTo(newEToken.address);
  });

  it("Should not be able to upgrade EToken with different pool", async () => {
    const { guardian, etk, currency, _A } = await helpers.loadFixture(setupFixtureWithPoolAndPA);
    const newPool = await deployPool(hre, {
      currency: currency.address,
      grantRoles: [],
      treasuryAddress: "0x7291Ba1DC551b666c49Da22dE76eC7ceEB51AeDC", // Random address
    });
    newPool._A = _A;

    const EToken = await ethers.getContractFactory("EToken");
    const newImpl = await EToken.deploy(newPool.address);

    await expect(etk.connect(guardian).upgradeTo(newImpl.address)).to.be.revertedWith(
      "Can't upgrade changing the PolicyPool!"
    );
  });

  it("Should be able to upgrade PremiumsAccount contract", async () => {
    const { guardian, cust, pool, premiumsAccount, etk } = await helpers.loadFixture(setupFixtureWithPoolAndPA);
    const PremiumsAccount = await ethers.getContractFactory("PremiumsAccount");
    const newImpl = await PremiumsAccount.deploy(pool.address, zeroAddress, etk.address);

    // Cust cant upgrade
    await expect(premiumsAccount.connect(cust).upgradeTo(newImpl.address)).to.be.revertedWith("AccessControl:");

    await premiumsAccount.connect(guardian).upgradeTo(newImpl.address);
  });

  it("Can upgrade PremiumsAccount with componentRole", async () => {
    const { cust, pool, premiumsAccount, etk, access } = await helpers.loadFixture(setupFixtureWithPoolAndPA);
    const PremiumsAccount = await ethers.getContractFactory("PremiumsAccount");
    const newPremiumsAccount = await PremiumsAccount.deploy(pool.address, zeroAddress, etk.address);

    // Cust cant upgrade
    await expect(premiumsAccount.connect(cust).upgradeTo(newPremiumsAccount.address)).to.be.revertedWith(
      "AccessControl:"
    );

    await grantComponentRole(hre, access, premiumsAccount, "LEVEL1_ROLE", cust);
    await premiumsAccount.connect(cust).upgradeTo(newPremiumsAccount.address);
  });

  it("Should not be able to upgrade PremiumsAccount with different pool or jrEtk", async () => {
    const { guardian, pool, premiumsAccount, etk, currency, _A } = await helpers.loadFixture(setupFixtureWithPoolAndPA);
    const newPool = await deployPool(hre, {
      currency: currency.address,
      grantRoles: [],
      treasuryAddress: "0x7291Ba1DC551b666c49Da22dE76eC7ceEB51AeDC", // Random address
    });
    newPool._A = _A;

    const PremiumsAccount = await ethers.getContractFactory("PremiumsAccount");
    let newImpl = await PremiumsAccount.deploy(newPool.address, zeroAddress, etk.address);

    await expect(premiumsAccount.connect(guardian).upgradeTo(newImpl.address)).to.be.revertedWith(
      "Can't upgrade changing the PolicyPool!"
    );

    newImpl = await PremiumsAccount.deploy(pool.address, zeroAddress, zeroAddress);
    await expect(premiumsAccount.connect(guardian).upgradeTo(newImpl.address)).to.be.revertedWith(
      "Can't upgrade changing the Senior ETK unless to non-zero"
    );

    // Changing jrEtk from 0 to something is possible
    const jrEtk = await addEToken(pool, {});
    newImpl = await PremiumsAccount.deploy(pool.address, jrEtk.address, etk.address);
    await premiumsAccount.connect(guardian).upgradeTo(newImpl.address);

    newImpl = await PremiumsAccount.deploy(pool.address, zeroAddress, etk.address);
    await expect(premiumsAccount.connect(guardian).upgradeTo(newImpl.address)).to.be.revertedWith(
      "Can't upgrade changing the Junior ETK unless to non-zero"
    );
  });

  it("Should be able to upgrade RiskModule contract", async () => {
    const { cust, guardian, pool, premiumsAccount, TrustfulRiskModule, rm } = await helpers.loadFixture(
      setupFixtureWithPoolAndRM
    );
    const newRM = await TrustfulRiskModule.deploy(pool.address, premiumsAccount.address);

    // Cust cant upgrade
    await expect(rm.connect(cust).upgradeTo(newRM.address)).to.be.revertedWith("AccessControl:");
    await rm.connect(guardian).upgradeTo(newRM.address);
  });

  it("Can upgrade RiskModule with componentRole", async () => {
    const { cust, pool, premiumsAccount, TrustfulRiskModule, rm, access } = await helpers.loadFixture(
      setupFixtureWithPoolAndRM
    );
    const newRM = await TrustfulRiskModule.deploy(pool.address, premiumsAccount.address);

    // Cust cant upgrade
    await expect(rm.connect(cust).upgradeTo(newRM.address)).to.be.revertedWith("AccessControl:");

    await grantComponentRole(hre, access, rm, "LEVEL1_ROLE", cust);
    await rm.connect(cust).upgradeTo(newRM.address);
  });

  it("Should not be able to upgrade RiskModule with different pool or PremiumsAccount", async () => {
    const { guardian, pool, rm, currency, _A, TrustfulRiskModule } = await helpers.loadFixture(
      setupFixtureWithPoolAndRM
    );
    const newPool = await deployPool(hre, {
      currency: currency.address,
      grantRoles: [],
      treasuryAddress: "0x7291Ba1DC551b666c49Da22dE76eC7ceEB51AeDC", // Random address
    });
    newPool._A = _A;
    const newPA = await deployPremiumsAccount(hre, newPool, {});

    let newImpl = await TrustfulRiskModule.deploy(newPool.address, newPA.address);

    await expect(rm.connect(guardian).upgradeTo(newImpl.address)).to.be.revertedWith(
      "Can't upgrade changing the PolicyPool!"
    );
    const newPAOrigPool = await deployPremiumsAccount(hre, pool, {});

    newImpl = await TrustfulRiskModule.deploy(pool.address, newPAOrigPool.address);
    await expect(rm.connect(guardian).upgradeTo(newImpl.address)).to.be.revertedWith(
      "Can't upgrade changing the PremiumsAccount"
    );
  });

  it("Should be able to upgrade Whitelist", async () => {
    const { pool, cust, guardian, wl, Whitelist } = await helpers.loadFixture(setupFixtureWithPoolAndWL);
    const newImpl = await Whitelist.deploy(pool.address);

    // Cust cant upgrade
    await expect(wl.connect(cust).upgradeTo(newImpl.address)).to.be.revertedWith("AccessControl:");

    await wl.connect(guardian).upgradeTo(newImpl.address);
  });

  it("Can upgrade Whitelist with componentRole", async () => {
    const { pool, cust, wl, access, Whitelist } = await helpers.loadFixture(setupFixtureWithPoolAndWL);
    const newWL = await Whitelist.deploy(pool.address);

    // Cust cant upgrade
    await expect(wl.connect(cust).upgradeTo(newWL.address)).to.be.revertedWith("AccessControl:");

    await grantComponentRole(hre, access, wl, "LEVEL1_ROLE", cust);
    await wl.connect(cust).upgradeTo(newWL.address);
  });

  it("Should be able to upgrade AccessManager contract", async () => {
    const { guardian, cust, access } = await helpers.loadFixture(setupFixtureWithPool);
    const AccessManager = await ethers.getContractFactory("AccessManager");
    const newAM = await AccessManager.deploy();

    // Cust cant upgrade
    await expect(access.connect(cust).upgradeTo(newAM.address)).to.be.revertedWith("AccessControl:");
    await access.connect(guardian).upgradeTo(newAM.address);
  });
});
