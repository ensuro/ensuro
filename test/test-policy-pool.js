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

const COMPONENT_STATUS_DEPRECATED = 2;

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
    pool._A = _A;

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

  it("Removes the PA as borrower from the jr etoken on PremiumsAccount removal", async () => {
    const etk = await addEToken(pool, {});
    const premiumsAccount = await deployPremiumsAccount(hre, pool, { jrEtkAddr: etk.address }, false);

    await pool.addComponent(premiumsAccount.address, 3);

    pool.changeComponentStatus(premiumsAccount.address, COMPONENT_STATUS_DEPRECATED);

    await expect(pool.removeComponent(premiumsAccount.address))
      .to.emit(etk, "InternalBorrowerRemoved")
      .withArgs(premiumsAccount.address, 0);
  });

  it("Adds the PA as borrower on the sr etoken", async () => {
    const etk = await addEToken(pool, {});
    const premiumsAccount = await deployPremiumsAccount(hre, pool, { srEtkAddr: etk.address }, false);

    await expect(pool.addComponent(premiumsAccount.address, 3))
      .to.emit(etk, "InternalBorrowerAdded")
      .withArgs(premiumsAccount.address);
  });

  it("Removes the PA as borrower from the sr etoken on PremiumsAccount removal", async () => {
    const etk = await addEToken(pool, {});
    const premiumsAccount = await deployPremiumsAccount(hre, pool, { srEtkAddr: etk.address }, false);

    await pool.addComponent(premiumsAccount.address, 3);

    pool.changeComponentStatus(premiumsAccount.address, COMPONENT_STATUS_DEPRECATED);

    await expect(pool.removeComponent(premiumsAccount.address))
      .to.emit(etk, "InternalBorrowerRemoved")
      .withArgs(premiumsAccount.address, 0);
  });

  it("Does not allow suspending unknown components", async () => {
    const premiumsAccount = await deployPremiumsAccount(hre, pool, {}, false);

    await grantRole(hre, accessManager, "GUARDIAN_ROLE", owner.address);

    await expect(pool.changeComponentStatus(premiumsAccount.address, 1)).to.be.revertedWith("Component not found");
  });

  it("Only allows riskmodule to create policies", async () => {
    const now = await helpers.time.latest();
    const policyData = [
      1, // id
      _A(1000), // payout
      _A(110), // premium
      _W(0), // jrScr
      _W(0), // srScr
      _W("0.1"), // lossProb
      _W(10), // purePremium
      _W(0), // ensuroCommission
      _W(0), // partnerCommission
      _W(0), // jrCoc
      _W(0), // srCoc
      "0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199", // riskModule
      now, // start
      now + 3600 * 5, // expiration
    ];

    await expect(pool.newPolicy(policyData, cust.address, backend.address, 11)).to.be.revertedWith(
      "Only the RM can create new policies"
    );
  });

  async function deployRiskModuleFixture() {
    // Setup the liquidity sources
    const etk = await addEToken(pool, {});
    const premiumsAccount = await deployPremiumsAccount(hre, pool, { srEtkAddr: etk.address });

    await currency.connect(lp).approve(pool.address, _A(5000));
    await pool.connect(lp).deposit(etk.address, _A(5000));

    // Setup the risk module
    const RiskModule = await hre.ethers.getContractFactory("RiskModuleMock");
    const rm = await addRiskModule(pool, premiumsAccount, RiskModule, {
      extraArgs: [],
    });

    return { etk, premiumsAccount, rm };
  }

  async function deployRmWithPolicyFixture() {
    const { rm } = await deployRiskModuleFixture();
    const now = await helpers.time.latest();

    // Deploy a new policy
    await currency.connect(cust).approve(pool.address, _A(110));
    await currency.connect(cust).approve(backend.address, _A(110));

    await accessManager.grantComponentRole(rm.address, await rm.PRICER_ROLE(), backend.address);
    await accessManager.grantComponentRole(rm.address, await rm.RESOLVER_ROLE(), backend.address);
    const tx = await rm.connect(backend).newPolicy(
      _A(1000), // payout
      _A(10), // premium
      _W(0), // lossProb
      now + 3600 * 5, // expiration
      cust.address, // payer
      cust.address, // holder
      123 // internalId
    );

    const receipt = await tx.wait();

    // Try to resolve it without going through the riskModule
    const newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");

    return { policy: newPolicyEvt.args.policy, receipt, rm };
  }

  it("Only allows riskmodule to resolve unexpired policies", async () => {
    const { policy } = await helpers.loadFixture(deployRmWithPolicyFixture);

    await expect(pool.resolvePolicy(policy, 0)).to.be.revertedWith("Only the RM can resolve policies");
  });

  it("Does not allow a bigger payout than the one setup in the policy", async () => {
    const { policy, rm } = await helpers.loadFixture(deployRmWithPolicyFixture);

    await expect(rm.connect(backend).resolvePolicy(policy, policy.payout + _A(10))).to.be.revertedWith(
      "payout > policy.payout"
    );
  });

  it("Only allows to resolve a policy once", async () => {
    const { policy, rm } = await helpers.loadFixture(deployRmWithPolicyFixture);
    expect(await pool.isActive(policy.id)).to.be.true;
    await expect(rm.connect(backend).resolvePolicy(policy, policy.payout)).not.to.be.reverted;
    expect(await pool.isActive(policy.id)).to.be.false;
    await expect(rm.connect(backend).resolvePolicy(policy, policy.payout)).to.be.revertedWith("Policy not found");
  });
});
