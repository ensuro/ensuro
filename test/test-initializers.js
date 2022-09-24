const { expect } = require("chai");
const hre = require("hardhat");
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

describe("Test Initialize contracts", function () {
  let currency;
  let pool;
  let premiumsAccount;
  let TrustfulRiskModule;
  let lp, cust, guardian;
  let _A;
  let etk;
  let accessManager;
  let rm;

  async function protocolFixture() {
    const [lp, cust, guardian] = await hre.ethers.getSigners();

    const _A = amountFunction(6);

    const currency = await initCurrency(
      { name: "Test USDC", symbol: "USDC", decimals: 6, initial_supply: _A(10000) },
      [lp, cust],
      [_A(5000), _A(500)]
    );

    const pool = await deployPool(hre, {
      currency: currency.address,
      grantRoles: [],
      treasuryAddress: "0x87c47c9a5a2aa74ae714857d64911d9a091c25b1", // Random address
    });
    pool._A = _A;

    const etk = await addEToken(pool, {});

    const premiumsAccount = await deployPremiumsAccount(hre, pool, { srEtkAddr: etk.address });
    const accessManager = await hre.ethers.getContractAt("AccessManager", await pool.access());
    const TrustfulRiskModule = await hre.ethers.getContractFactory("TrustfulRiskModule");
    const rm = await addRiskModule(pool, premiumsAccount, TrustfulRiskModule, {});

    await grantRole(hre, accessManager, "GUARDIAN_ROLE", guardian.address);

    await currency.connect(lp).approve(pool.address, _A(5000));
    await pool.connect(lp).deposit(etk.address, _A(3000));

    return {
      currency,
      pool,
      premiumsAccount,
      TrustfulRiskModule,
      lp,
      cust,
      guardian,
      _A,
      etk,
      accessManager,
      rm,
    };
  }

  beforeEach(async () => {
    ({ currency, pool, premiumsAccount, TrustfulRiskModule, lp, cust, guardian, _A, etk, accessManager, rm } =
      await helpers.loadFixture(protocolFixture));
  });

  it("Does not allow reinitializing PolicyPool", async () => {
    await expect(pool.initialize("PP", "PP", hre.ethers.constants.AddressZero)).to.be.revertedWith(
      "contract is already initialized"
    );
  });

  it("Does not allow reinitializing Etoken", async () => {
    await expect(etk.initialize("ETK", "ETK", 0, 0)).to.be.revertedWith("contract is already initialized");
  });

  it("Does not allow reinitializing AccessManager", async () => {
    await expect(accessManager.initialize()).to.be.revertedWith("contract is already initialized");
  });

  it("Does not allow reinitializing PremiumsAccount", async () => {
    await expect(premiumsAccount.initialize()).to.be.revertedWith("contract is already initialized");
  });

  it("Does not allow reinitializing RiskModule", async () => {
    await expect(rm.initialize("RM", 0, 0, 0, 0, 0, hre.ethers.constants.AddressZero)).to.be.revertedWith(
      "contract is already initialized"
    );
  });

  it("Does not allow reinitializing Whitelist", async () => {
    const Whitelist = await hre.ethers.getContractFactory("LPManualWhitelist");
    const wl = await hre.upgrades.deployProxy(Whitelist, [], {
      kind: "uups",
      unsafeAllow: ["delegatecall"],
      constructorArgs: [pool.address],
    });

    await expect(wl.initialize()).to.be.revertedWith("contract is already initialized");
  });
});
