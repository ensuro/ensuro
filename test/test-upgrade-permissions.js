const { expect } = require("chai");
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
  let currency;
  let pool;
  let premiumsAccount;
  let TrustfulRiskModule;
  let lp, cust, guardian;
  let _A;
  let etk;
  let accessManager;
  let rm;

  beforeEach(async () => {
    [lp, cust, guardian] = await ethers.getSigners();

    _A = amountFunction(6);

    currency = await initCurrency(
      { name: "Test USDC", symbol: "USDC", decimals: 6, initial_supply: _A(10000) },
      [lp, cust],
      [_A(5000), _A(500)]
    );

    pool = await deployPool(hre, {
      currency: currency.address,
      grantRoles: [],
      treasuryAddress: "0x87c47c9a5a2aa74ae714857d64911d9a091c25b1", // Random address
    });
    pool._A = _A;

    etk = await addEToken(pool, {});

    premiumsAccount = await deployPremiumsAccount(hre, pool, { srEtkAddr: etk.address });
    accessManager = await ethers.getContractAt("AccessManager", await pool.access());
    TrustfulRiskModule = await ethers.getContractFactory("TrustfulRiskModule");
    rm = await addRiskModule(pool, premiumsAccount, TrustfulRiskModule, {});

    await grantRole(hre, accessManager, "GUARDIAN_ROLE", guardian.address);

    await currency.connect(lp).approve(pool.address, _A(5000));
    await pool.connect(lp).deposit(etk.address, _A(3000));
  });

  it("Should be able to upgrade EToken", async () => {
    const EToken = await ethers.getContractFactory("EToken");
    const newImpl = await EToken.deploy(pool.address);

    // Cust cant upgrade
    await expect(etk.connect(cust).upgradeTo(newImpl.address)).to.be.revertedWith("AccessControl:");

    await etk.connect(guardian).upgradeTo(newImpl.address);
  });

  it("Can upgrade EToken with componentRole", async () => {
    const EToken = await ethers.getContractFactory("EToken");
    const newEToken = await EToken.deploy(pool.address);

    // Cust cant upgrade
    await expect(etk.connect(cust).upgradeTo(newEToken.address)).to.be.revertedWith("AccessControl:");

    await grantComponentRole(hre, accessManager, etk, "LEVEL1_ROLE", cust);
    await etk.connect(cust).upgradeTo(newEToken.address);
  });

  it("Should not be able to upgrade EToken with different pool", async () => {
    const newPool = await deployPool(hre, {
      currency: currency.address,
      grantRoles: [],
      treasuryAddress: "0x7291Ba1DC551b666c49Da22dE76eC7ceEB51AeDC", // Random address
    });
    newPool._A = _A;

    const EToken = await ethers.getContractFactory("EToken");
    const newImpl = await EToken.deploy(newPool.address);

    // Cust cant upgrade
    await expect(etk.connect(cust).upgradeTo(newImpl.address)).to.be.revertedWith("AccessControl:");

    await expect(etk.connect(guardian).upgradeTo(newImpl.address)).to.be.revertedWith(
      "Can't upgrade changing the PolicyPool!"
    );
  });

  it("Should be able to upgrade PremiumsAccount contract", async () => {
    const PremiumsAccount = await ethers.getContractFactory("PremiumsAccount");
    const newImpl = await PremiumsAccount.deploy(pool.address, ethers.constants.AddressZero, etk.address);

    // Cust cant upgrade
    await expect(premiumsAccount.connect(cust).upgradeTo(newImpl.address)).to.be.revertedWith("AccessControl:");

    await premiumsAccount.connect(guardian).upgradeTo(newImpl.address);
  });

  it("Can upgrade PremiumsAccount with componentRole", async () => {
    const PremiumsAccount = await ethers.getContractFactory("PremiumsAccount");
    const newPremiumsAccount = await PremiumsAccount.deploy(pool.address, ethers.constants.AddressZero, etk.address);

    // Cust cant upgrade
    await expect(premiumsAccount.connect(cust).upgradeTo(newPremiumsAccount.address)).to.be.revertedWith(
      "AccessControl:"
    );

    await grantComponentRole(hre, accessManager, premiumsAccount, "LEVEL1_ROLE", cust);
    await premiumsAccount.connect(cust).upgradeTo(newPremiumsAccount.address);
  });

  it("Should be able to upgrade RiskModule contract", async () => {
    const RiskModule = await ethers.getContractFactory("TrustfulRiskModule");
    const newRM = await RiskModule.deploy(pool.address, premiumsAccount.address);

    // Cust cant upgrade
    await expect(rm.connect(cust).upgradeTo(newRM.address)).to.be.revertedWith("AccessControl:");
    await rm.connect(guardian).upgradeTo(newRM.address);
  });

  it("Can upgrade RiskModule with componentRole", async () => {
    const RiskModule = await ethers.getContractFactory("TrustfulRiskModule");
    const newRM = await RiskModule.deploy(pool.address, premiumsAccount.address);

    // Cust cant upgrade
    await expect(rm.connect(cust).upgradeTo(newRM.address)).to.be.revertedWith("AccessControl:");

    await grantComponentRole(hre, accessManager, rm, "LEVEL1_ROLE", cust);
    await rm.connect(cust).upgradeTo(newRM.address);
  });

  it("Should be able to upgrade AccessManager contract", async () => {
    const AccessManager = await ethers.getContractFactory("AccessManager");
    const newAM = await AccessManager.deploy();

    // Cust cant upgrade
    await expect(accessManager.connect(cust).upgradeTo(newAM.address)).to.be.revertedWith("AccessControl:");
    await accessManager.connect(guardian).upgradeTo(newAM.address);
  });
});
