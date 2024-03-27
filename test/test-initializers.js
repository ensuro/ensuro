const { expect } = require("chai");
const hre = require("hardhat");
const helpers = require("@nomicfoundation/hardhat-network-helpers");

const { grantRole, amountFunction } = require("../js/utils");
const {
  initCurrency,
  deployPool,
  deployPremiumsAccount,
  addRiskModule,

  createRiskModule,
  addEToken,
} = require("../js/test-utils");

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
    const accessManager = await hre.ethers.getContractAt("AccessManager", await pool.access());
    const TrustfulRiskModule = await hre.ethers.getContractFactory("TrustfulRiskModule");
    const rm = await addRiskModule(pool, premiumsAccount, TrustfulRiskModule, {});

    await grantRole(hre, accessManager, "GUARDIAN_ROLE", guardian);

    await currency.connect(lp).approve(pool, _A(5000));
    await pool.connect(lp).deposit(etk, _A(3000));

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

  let pool;
  let accessManager;
  let premiumsAccount;
  let etk;
  let rm;

  beforeEach(async () => {
    ({ pool, premiumsAccount, etk, accessManager, rm } = await helpers.loadFixture(protocolFixture));
  });

  it("Does not allow reinitializing PolicyPool", async () => {
    await expect(pool.initialize("PP", "PP", ZeroAddress)).to.be.revertedWith(
      "Initializable: contract is already initialized"
    );
  });

  it("Does not allow reinitializing Etoken", async () => {
    await expect(etk.initialize("ETK", "ETK", 0, 0)).to.be.revertedWith(
      "Initializable: contract is already initialized"
    );
  });

  it("Does not allow reinitializing AccessManager", async () => {
    await expect(accessManager.initialize()).to.be.revertedWith("Initializable: contract is already initialized");
  });

  it("Does not allow reinitializing PremiumsAccount", async () => {
    await expect(premiumsAccount.initialize()).to.be.revertedWith("Initializable: contract is already initialized");
  });

  it("Does not allow reinitializing RiskModule", async () => {
    await expect(rm.initialize("RM", 0, 0, 0, 0, 0, ZeroAddress)).to.be.revertedWith(
      "Initializable: contract is already initialized"
    );
  });

  ["SignedQuoteRiskModule", "SignedBucketRiskModule"].forEach((contract) => {
    it(`Does not allow reinitializing ${contract}`, async () => {
      const Factory = await hre.ethers.getContractFactory(contract);
      const initRm = await createRiskModule(pool, premiumsAccount, Factory, { extraConstructorArgs: [false] });
      await expect(initRm.initialize("RM", 0, 0, 0, 0, 0, ZeroAddress)).to.be.revertedWith(
        "Initializable: contract is already initialized"
      );
    });
  });

  it("Does not allow reinitializing Whitelist", async () => {
    const Whitelist = await hre.ethers.getContractFactory("LPManualWhitelist");
    const poolAddr = await hre.ethers.resolveAddress(pool);
    const wl = await hre.upgrades.deployProxy(Whitelist, [[2, 1, 1, 2]], {
      kind: "uups",
      constructorArgs: [poolAddr],
    });
    await expect(wl.initialize([2, 1, 1, 2])).to.be.revertedWith("Initializable: contract is already initialized");
  });
});
