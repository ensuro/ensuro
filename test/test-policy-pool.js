const { expect } = require("chai");
const {
  initCurrency,
  deployPool,
  deployPremiumsAccount,
  _E,
  _W,
  addRiskModule,
  amountFunction,
  addEToken,
  getTransactionEvent,
  getComponentRole,
  accessControlMessage,
  makePolicyId,
  grantRole,
} = require("./test-utils");
const hre = require("hardhat");
const helpers = require("@nomicfoundation/hardhat-network-helpers");

describe("PolicyPool contract", function () {
  let currency;
  let pool;
  let accessManager;
  let _A;
  let owner, lp, cust, backend;

  beforeEach(async () => {
    [owner, lp, cust, backend] = await hre.ethers.getSigners();

    _A = amountFunction(6);

    currency = await initCurrency(
      { name: "Test USDC", symbol: "USDC", decimals: 6, initial_supply: _A(10000) },
      [lp, cust, backend],
      [_A(5000), _A(500), _A(1000)]
    );

    pool = await deployPool(hre, {
      currency: currency.address,
      grantRoles: ["LEVEL1_ROLE", "LEVEL2_ROLE"],
      treasuryAddress: "0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199", // Random address
    });

    accessManager = await hre.ethers.getContractAt("AccessManager", await pool.access());
  });

  it("Only allows LEVEL1_ROLE to change the treasury", async () => {
    const newTreasury = "0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199";

    // User with no roles fails
    await expect(pool.connect(backend).setTreasury(newTreasury)).to.be.revertedWith(
      accessControlMessage(backend.address, null, "LEVEL1_ROLE")
    );

    // User with LEVEL2_ROLE fails
    await grantRole(hre, accessManager, "LEVEL2_ROLE", backend.address);
    await expect(pool.connect(backend).setTreasury(newTreasury)).to.be.revertedWith(
      accessControlMessage(backend.address, null, "LEVEL1_ROLE")
    );

    // User with LEVEL1_ROLE passes
    await grantRole(hre, accessManager, "LEVEL1_ROLE", backend.address);
    await expect(pool.connect(backend).setTreasury(newTreasury)).to.emit(pool, "ComponentChanged");

    expect(await pool.treasury()).to.equal(newTreasury);
  });

  it("Only allows LEVEL1_ROLE to add components", async () => {
    const premiumsAccount = await deployPremiumsAccount(hre, pool, {}, false);

    await expect(pool.connect(backend).addComponent(premiumsAccount.address, 3)).to.be.revertedWith(
      accessControlMessage(backend.address, null, "LEVEL1_ROLE")
    );

    await grantRole(hre, accessManager, "LEVEL2_ROLE", backend.address);
    await expect(pool.connect(backend).addComponent(premiumsAccount.address, 3)).to.be.revertedWith(
      accessControlMessage(backend.address, null, "LEVEL1_ROLE")
    );

    await grantRole(hre, accessManager, "LEVEL1_ROLE", backend.address);
    await expect(pool.connect(backend).addComponent(premiumsAccount.address, 3)).to.emit(
      pool,
      "ComponentStatusChanged"
    );
  });

  it("Does not allow adding an existing component", async () => {
    const premiumsAccount = await deployPremiumsAccount(hre, pool, {}, true);

    await expect(pool.addComponent(premiumsAccount.address, 3)).to.be.revertedWith("Component already in the pool");
  });

  it("Does not allow adding a component that belongs to a different pool", async () => {
    const pool2 = await deployPool(hre, {
      currency: currency.address,
      grantRoles: ["LEVEL1_ROLE", "LEVEL2_ROLE"],
      treasuryAddress: "0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199",
    });

    const premiumsAccount = await deployPremiumsAccount(hre, pool2, {}, false);

    await expect(pool.addComponent(premiumsAccount.address, 3)).to.be.revertedWith("Component not linked to this pool");
  });

  it("Adds the PA as borrower on the jr etoken", async () => {
    const etk = await addEToken(pool, {});
    const premiumsAccount = await deployPremiumsAccount(hre, pool, { jrEtkAddr: etk.address }, false);

    await expect(pool.addComponent(premiumsAccount.address, 3))
      .to.emit(etk, "InternalBorrowerAdded")
      .withArgs(premiumsAccount.address);
  });

  it("Adds the PA as borrower on the sr etoken", async () => {
    const etk = await addEToken(pool, {});
    const premiumsAccount = await deployPremiumsAccount(hre, pool, { srEtkAddr: etk.address }, false);

    await expect(pool.addComponent(premiumsAccount.address, 3))
      .to.emit(etk, "InternalBorrowerAdded")
      .withArgs(premiumsAccount.address);
  });

  it("Does not allow suspending unknown components", async () => {
    const premiumsAccount = await deployPremiumsAccount(hre, pool, {}, false);

    await grantRole(hre, accessManager, "GUARDIAN_ROLE", owner.address);

    await expect(pool.changeComponentStatus(premiumsAccount.address, 1)).to.be.revertedWith("Component not found");
  });
});
