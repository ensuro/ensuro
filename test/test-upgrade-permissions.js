const { expect } = require("chai");
const {
  initCurrency,
  deployPool,
  deployPremiumsAccount,
  addRiskModule,
  amountFunction,
  grantRole,
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
  let policyNFT;
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
      grantRoles: ["LEVEL1_ROLE", "LEVEL2_ROLE"],
      treasuryAddress: "0x87c47c9a5a2aa74ae714857d64911d9a091c25b1", // Random address
    });
    pool._A = _A;

    etk = await addEToken(pool, {});

    premiumsAccount = await deployPremiumsAccount(hre, pool, { srEtkAddr: etk.address });
    accessManager = await ethers.getContractAt("AccessManager", await pool.access());
    policyNFT = await ethers.getContractAt("PolicyNFT", await pool.policyNFT());
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

  it("Should be able to upgrade PremiumsAccount contract", async () => {
    const PremiumsAccount = await ethers.getContractFactory("PremiumsAccount");
    const newImpl = await PremiumsAccount.deploy(pool.address, ethers.constants.AddressZero, etk.address);

    // Cust cant upgrade
    await expect(premiumsAccount.connect(cust).upgradeTo(newImpl.address)).to.be.revertedWith("AccessControl:");

    await premiumsAccount.connect(guardian).upgradeTo(newImpl.address);
  });

  it("Should be able to upgrade PolicyNFT contract", async () => {
    const PolicyNFT = await ethers.getContractFactory("PolicyNFT");
    const newPolicyNFT = await PolicyNFT.deploy();

    // Cust cant upgrade
    await expect(policyNFT.connect(cust).upgradeTo(newPolicyNFT.address)).to.be.revertedWith("AccessControl:");
    await policyNFT.connect(guardian).upgradeTo(newPolicyNFT.address);
  });

  it("Should be able to upgrade RiskModule contract", async () => {
    const RiskModule = await ethers.getContractFactory("TrustfulRiskModule");
    const newRM = await RiskModule.deploy(pool.address, premiumsAccount.address);

    // Cust cant upgrade
    await expect(rm.connect(cust).upgradeTo(newRM.address)).to.be.revertedWith("AccessControl:");
    await rm.connect(guardian).upgradeTo(newRM.address);
  });
});
