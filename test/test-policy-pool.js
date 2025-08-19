const { expect } = require("chai");
const { grantRole, amountFunction, _W, getTransactionEvent } = require("@ensuro/utils/js/utils");
const { initCurrency } = require("@ensuro/utils/js/test-utils");
const {
  addEToken,
  addRiskModule,
  createEToken,
  createRiskModule,
  deployPool,
  deployPremiumsAccount,
} = require("../js/test-utils");
const hre = require("hardhat");
const helpers = require("@nomicfoundation/hardhat-network-helpers");
const { ComponentStatus, ComponentKind } = require("../js/enums.js");
const { ZeroAddress } = hre.ethers;

async function createNewPolicy(rm, cust, pool, payout, premium, lossProb, expiration, payer, holder, internalId) {
  const tx = await rm.connect(cust).newPolicy(payout, premium, lossProb, expiration, payer, holder, internalId);
  const receipt = await tx.wait();
  const newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");
  const policy = newPolicyEvt.args.policy;
  return policy;
}

describe("PolicyPool contract", function () {
  let _A;
  let backend, cust, lp, owner;

  beforeEach(async () => {
    [owner, lp, cust, backend] = await hre.ethers.getSigners();

    _A = amountFunction(6);
  });

  it("Only allows LEVEL1_ROLE to change the treasury", async () => {
    const { pool, accessManager } = await helpers.loadFixture(deployPoolFixture);
    const newTreasury = "0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199";

    // User with no roles fails
    await expect(pool.connect(backend).setTreasury(newTreasury)).to.be.revertedWithACError(
      accessManager,
      backend,
      "LEVEL1_ROLE"
    );

    // User with LEVEL2_ROLE fails
    await grantRole(hre, accessManager, "LEVEL2_ROLE", backend);
    await expect(pool.connect(backend).setTreasury(newTreasury)).to.be.revertedWithACError(
      accessManager,
      backend,
      "LEVEL1_ROLE"
    );

    // User with LEVEL1_ROLE passes
    await grantRole(hre, accessManager, "LEVEL1_ROLE", backend);

    // Cant set treasury to 0x0
    const zeroAddress = "0x0000000000000000000000000000000000000000";
    await expect(pool.connect(backend).setTreasury(zeroAddress)).to.be.revertedWithCustomError(pool, "NoZeroTreasury");

    await expect(pool.connect(backend).setTreasury(newTreasury)).to.emit(pool, "ComponentChanged");

    expect(await pool.treasury()).to.equal(newTreasury);
  });

  it("Only allows LEVEL1_ROLE to add components", async () => {
    const { pool, accessManager } = await helpers.loadFixture(deployPoolFixture);
    const premiumsAccount = await deployPremiumsAccount(pool, {}, false);

    await expect(
      pool.connect(backend).addComponent(premiumsAccount, ComponentKind.premiumsAccount)
    ).to.be.revertedWithACError(accessManager, backend, "LEVEL1_ROLE");

    await grantRole(hre, accessManager, "LEVEL2_ROLE", backend);
    await expect(
      pool.connect(backend).addComponent(premiumsAccount, ComponentKind.premiumsAccount)
    ).to.be.revertedWithACError(accessManager, backend, "LEVEL1_ROLE");

    await grantRole(hre, accessManager, "LEVEL1_ROLE", backend);
    await expect(pool.connect(backend).addComponent(premiumsAccount, ComponentKind.premiumsAccount)).to.emit(
      pool,
      "ComponentStatusChanged"
    );
  });

  it("Does not allow adding an existing component", async () => {
    const { pool } = await helpers.loadFixture(deployPoolFixture);
    const premiumsAccount = await deployPremiumsAccount(pool, {}, true);

    await expect(pool.addComponent(premiumsAccount, ComponentKind.premiumsAccount)).to.be.revertedWithCustomError(
      pool,
      "ComponentAlreadyInThePool"
    );
  });

  it("Does not allow adding different kind of component", async () => {
    const { pool } = await helpers.loadFixture(deployPoolFixture);

    const etk = await createEToken(pool, {});
    const premiumsAccount = await deployPremiumsAccount(pool, { jrEtk: etk }, false);
    const RiskModule = await hre.ethers.getContractFactory("RiskModuleMock");
    const rm = await createRiskModule(pool, premiumsAccount, RiskModule, {});

    // EToken
    await expect(pool.addComponent(etk, ComponentKind.premiumsAccount))
      .to.be.revertedWithCustomError(pool, "ComponentNotTheRightKind")
      .withArgs(etk, ComponentKind.premiumsAccount);
    await expect(pool.addComponent(etk, ComponentKind.eToken)).not.to.be.reverted;

    // RiskModule
    await expect(pool.addComponent(rm, ComponentKind.eToken))
      .to.be.revertedWithCustomError(pool, "ComponentNotTheRightKind")
      .withArgs(rm, ComponentKind.eToken);
    await expect(pool.addComponent(rm, ComponentKind.riskModule)).not.to.be.reverted;

    // Premiums account
    await expect(pool.addComponent(premiumsAccount, ComponentKind.riskModule))
      .to.be.revertedWithCustomError(pool, "ComponentNotTheRightKind")
      .withArgs(premiumsAccount, ComponentKind.riskModule);
    await expect(pool.addComponent(premiumsAccount, ComponentKind.premiumsAccount)).not.to.be.reverted;
  });

  it("Does not allow adding a component that belongs to a different pool", async () => {
    const { pool, currency } = await helpers.loadFixture(deployPoolFixture);
    const pool2 = await deployPool({
      currency: currency,
      grantRoles: ["LEVEL1_ROLE", "LEVEL2_ROLE"],
      treasuryAddress: "0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199",
    });

    const premiumsAccount = await deployPremiumsAccount(pool2, {}, false);

    await expect(pool.addComponent(premiumsAccount, 3)).to.be.revertedWithCustomError(
      pool,
      "ComponentNotLinkedToThisPool"
    );
  });

  it("Adds the PA as borrower on the jr etoken", async () => {
    const { pool } = await helpers.loadFixture(deployPoolFixture);
    const etk = await addEToken(pool, {});
    const premiumsAccount = await deployPremiumsAccount(pool, { jrEtk: etk }, false);

    await expect(pool.addComponent(premiumsAccount, 3)).to.emit(etk, "InternalBorrowerAdded").withArgs(premiumsAccount);
  });

  it("Removes the PA as borrower from the jr etoken on PremiumsAccount removal", async () => {
    const { pool } = await helpers.loadFixture(deployPoolFixture);
    const etk = await addEToken(pool, {});
    const premiumsAccount = await deployPremiumsAccount(pool, { jrEtk: etk }, false);

    await pool.addComponent(premiumsAccount, 3);

    await pool.changeComponentStatus(premiumsAccount, ComponentStatus.deprecated);

    await expect(pool.removeComponent(premiumsAccount))
      .to.emit(etk, "InternalBorrowerRemoved")
      .withArgs(premiumsAccount, 0);
  });

  it("Adds the PA as borrower on the sr etoken", async () => {
    const { pool } = await helpers.loadFixture(deployPoolFixture);
    const etk = await addEToken(pool, {});
    const premiumsAccount = await deployPremiumsAccount(pool, { srEtk: etk }, false);

    await expect(pool.addComponent(premiumsAccount, 3)).to.emit(etk, "InternalBorrowerAdded").withArgs(premiumsAccount);
  });

  it("Removes the PA as borrower from the sr etoken on PremiumsAccount removal", async () => {
    const { pool } = await helpers.loadFixture(deployPoolFixture);
    const etk = await addEToken(pool, {});
    const premiumsAccount = await deployPremiumsAccount(pool, { srEtk: etk }, false);

    await pool.addComponent(premiumsAccount, 3);

    await pool.changeComponentStatus(premiumsAccount, ComponentStatus.deprecated);

    await expect(pool.removeComponent(premiumsAccount))
      .to.emit(etk, "InternalBorrowerRemoved")
      .withArgs(premiumsAccount, 0);
  });

  it("Does not allow suspending unknown components", async () => {
    const { pool, accessManager } = await helpers.loadFixture(deployPoolFixture);
    const premiumsAccount = await deployPremiumsAccount(pool, {}, false);

    await grantRole(hre, accessManager, "GUARDIAN_ROLE", owner);

    await expect(pool.changeComponentStatus(premiumsAccount, 1)).to.be.revertedWithCustomError(
      pool,
      "ComponentNotFound"
    );
  });

  it("Only allows riskmodule to create policies", async () => {
    const { pool } = await helpers.loadFixture(deployPoolFixture);
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

    await expect(pool.newPolicy(policyData, cust, backend, 11)).to.be.revertedWithCustomError(
      pool,
      "OnlyRiskModuleAllowed"
    );
  });

  async function deployPoolFixture() {
    const currency = await initCurrency(
      { name: "Test USDC", symbol: "USDC", decimals: 6, initial_supply: _A(10000) },
      [lp, cust, backend],
      [_A(5000), _A(500), _A(1000)]
    );

    const pool = await deployPool({
      currency: currency,
      grantRoles: ["LEVEL1_ROLE", "LEVEL2_ROLE"],
      treasuryAddress: "0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199", // Random address
    });
    pool._A = _A;

    const accessManager = await hre.ethers.getContractAt("AccessManager", await pool.access());
    return { pool, accessManager, currency };
  }

  async function deployRiskModuleFixture() {
    const { pool, accessManager, currency } = await helpers.loadFixture(deployPoolFixture);
    // Setup the liquidity sources
    const etk = await addEToken(pool, {});
    const premiumsAccount = await deployPremiumsAccount(pool, { srEtk: etk });

    await currency.connect(lp).approve(pool, _A(5000));
    await pool.connect(lp).deposit(etk, _A(5000));

    // Setup the risk module
    const RiskModule = await hre.ethers.getContractFactory("RiskModuleMock");
    const rm = await addRiskModule(pool, premiumsAccount, RiskModule, {
      extraArgs: [],
    });

    return { etk, premiumsAccount, rm, pool, accessManager, currency };
  }

  async function deployRmWithPolicyFixture() {
    const { rm, pool, currency, accessManager, premiumsAccount } = await helpers.loadFixture(deployRiskModuleFixture);
    const now = await helpers.time.latest();

    // Deploy a new policy
    await currency.connect(cust).approve(pool, _A(110));
    await currency.connect(cust).approve(backend, _A(110));

    await accessManager.grantComponentRole(rm, await rm.PRICER_ROLE(), backend);
    await accessManager.grantComponentRole(rm, await rm.RESOLVER_ROLE(), backend);
    await accessManager.grantComponentRole(rm, await rm.REPLACER_ROLE(), backend);
    const tx = await rm.connect(backend).newPolicy(
      _A(1000), // payout
      _A(10), // premium
      _W(0), // lossProb
      now + 3600 * 5, // expiration
      cust, // payer
      cust, // holder
      123 // internalId
    );

    const receipt = await tx.wait();

    // Try to resolve it without going through the riskModule
    const newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");

    return { policy: newPolicyEvt.args.policy, receipt, rm, currency, accessManager, pool, premiumsAccount };
  }

  it("Only allows to resolve a policy once", async () => {
    const { policy, rm, pool } = await helpers.loadFixture(deployRmWithPolicyFixture);
    expect(await pool.isActive(policy.id)).to.be.true;
    // At least check it's not equal to 0. Doesn't make sense to add in the test the hash calculation
    expect(await pool.getPolicyHash(policy.id)).not.to.be.equal(hre.ethers.ZeroHash);
    await expect(rm.connect(backend).resolvePolicy([...policy], policy.payout)).not.to.be.reverted;
    expect(await pool.isActive(policy.id)).to.be.false;
    expect(await pool.getPolicyHash(policy.id)).to.be.equal(hre.ethers.ZeroHash);
    await expect(rm.connect(backend).resolvePolicy([...policy], _A(100))).to.be.revertedWith("Policy not found");
  });

  it("Only allows riskmodule to resolve unexpired policies", async () => {
    const { policy, pool } = await helpers.loadFixture(deployRmWithPolicyFixture);

    await expect(pool.resolvePolicy([...policy], 0)).to.be.revertedWithCustomError(pool, "OnlyRiskModuleAllowed");
  });

  it("Does not allow a bigger payout than the one setup in the policy", async () => {
    const { policy, rm } = await helpers.loadFixture(deployRmWithPolicyFixture);

    await expect(rm.connect(backend).resolvePolicy([...policy], policy.payout + _A(10))).to.be.revertedWith(
      "payout > policy.payout"
    );
  });

  it("Can't expire policies when the pool is paused", async () => {
    const { accessManager, policy, pool } = await helpers.loadFixture(deployRmWithPolicyFixture);

    await grantRole(hre, accessManager, "GUARDIAN_ROLE", owner);
    await expect(pool.connect(owner).pause()).to.emit(pool, "Paused");

    await expect(pool.connect(backend).expirePolicies([[...policy]])).to.be.revertedWithCustomError(
      pool,
      "EnforcedPause"
    );
  });

  it("Can't replace resolved policies", async () => {
    const { policy, rm, pool } = await helpers.loadFixture(deployRmWithPolicyFixture);
    await expect(rm.connect(backend).resolvePolicy([...policy], policy.payout)).not.to.be.reverted;
    expect(await pool.isActive(policy.id)).to.be.false;
    await expect(pool.replacePolicy([...policy], [...policy], ZeroAddress, 1234)).to.be.revertedWith(
      "Policy not found"
    );
  });

  it("Only RM can replace policies", async () => {
    const { policy, pool } = await helpers.loadFixture(deployRmWithPolicyFixture);
    await expect(pool.replacePolicy([...policy], [...policy], ZeroAddress, 1234)).to.be.revertedWithCustomError(
      pool,
      "OnlyRiskModuleAllowed"
    );
  });

  it("Rejects replace policy if the pool is paused", async () => {
    const { accessManager, policy, pool } = await helpers.loadFixture(deployRmWithPolicyFixture);

    await grantRole(hre, accessManager, "GUARDIAN_ROLE", owner);
    await expect(pool.connect(owner).pause()).to.emit(pool, "Paused");

    await expect(pool.replacePolicy([...policy], [...policy], ZeroAddress, 1234)).to.be.revertedWithCustomError(
      pool,
      "EnforcedPause"
    );
  });

  it("Components must be active to replace policies", async () => {
    const { policy, pool, rm, premiumsAccount } = await helpers.loadFixture(deployRmWithPolicyFixture);
    await pool.changeComponentStatus(premiumsAccount, ComponentStatus.deprecated);
    await expect(
      rm
        .connect(backend)
        .replacePolicy([...policy], policy.payout, policy.premium, policy.lossProb, policy.expiration, 1234)
    ).to.be.revertedWithCustomError(pool, "ComponentNotFoundOrNotActive");
    await pool.changeComponentStatus(premiumsAccount, ComponentStatus.active);
    await pool.changeComponentStatus(rm, ComponentStatus.deprecated);
    await expect(
      rm
        .connect(backend)
        .replacePolicy([...policy], policy.payout, policy.premium, policy.lossProb, policy.expiration, 1234)
    ).to.be.revertedWithCustomError(pool, "ComponentNotFoundOrNotActive");
  });

  it("Does not allow to replace expired policies", async () => {
    const { policy, rm } = await helpers.loadFixture(deployRmWithPolicyFixture);
    await helpers.time.increaseTo(policy.expiration + 100n);
    await expect(
      rm
        .connect(backend)
        .replacePolicy([...policy], policy.payout, policy.premium, policy.lossProb, policy.expiration, 1234)
    ).to.be.revertedWith("Old policy is expired");

    await expect(rm.connect(backend).replacePolicyRaw([...policy], [...policy], backend, 123)).to.be.revertedWith(
      "Old policy is expired"
    );
  });

  it("Must revert if new policy values must be greater or equal than old policy", async () => {
    const { rm, pool } = await helpers.loadFixture(deployRmWithPolicyFixture);

    const now = await helpers.time.latest();
    const p1 = await createNewPolicy(rm, backend, pool, _A(1000), _A(10), _W(0), now + 3600 * 5, cust, cust, 222);
    let p2 = [...p1];
    p2[1] -= _A(1); // change new policy payout
    await expect(rm.connect(backend).replacePolicyRaw([...p1], [...p2], backend, 1234)).to.be.revertedWith(
      "New policy must be greater or equal than old policy"
    );
  });

  it("Must revert if new policy have different start date", async () => {
    const { rm, pool, policy } = await helpers.loadFixture(deployRmWithPolicyFixture);

    await helpers.time.increaseTo(policy.start + 100n);
    const now = await helpers.time.latest();
    const p = await createNewPolicy(rm, backend, pool, _A(1000), _A(10), _W(0), now + 3600 * 5, cust, cust, 1234);
    await expect(rm.connect(backend).replacePolicyRaw([...policy], [...p], backend, 123)).to.be.revertedWith(
      "Both policies must have the same starting date"
    );
  });

  it("Only PolicyPool can call PA policyReplaced", async () => {
    const { pool, policy } = await helpers.loadFixture(deployRmWithPolicyFixture);

    const etk = await createEToken(pool, {});
    const pa = await deployPremiumsAccount(pool, { srEtk: etk });
    await expect(pa.policyReplaced([...policy], [...policy])).to.be.revertedWithCustomError(pa, "OnlyPolicyPool");
  });

  it("Replacement policy must have a new unique internalId", async () => {
    const { policy, rm } = await helpers.loadFixture(deployRmWithPolicyFixture);
    await expect(
      rm
        .connect(backend)
        .replacePolicy([...policy], policy.payout, policy.premium, policy.lossProb, policy.expiration, 123)
    ).to.be.revertedWith("Policy already exists");
  });

  it("Only LEVEL2_ROLE can change the baseURI and after the change the tokenURI works", async () => {
    const { policy, pool, accessManager } = await helpers.loadFixture(deployRmWithPolicyFixture);

    // User with no roles fails
    await expect(pool.connect(backend).setBaseURI("foobar")).to.be.revertedWithACError(
      accessManager,
      backend,
      "LEVEL2_ROLE"
    );

    // User with LEVEL2_ROLE passes
    await grantRole(hre, accessManager, "LEVEL2_ROLE", backend);

    expect(await pool.tokenURI(policy.id)).to.be.equal("");

    // User with no roles fails
    await expect(pool.connect(backend).setBaseURI("https://offchain-v2.ensuro.co/api/policies/nft/"))
      .to.be.emit(pool, "ComponentChanged")
      .withArgs(4, backend);

    expect(await pool.tokenURI(policy.id)).to.be.equal(`https://offchain-v2.ensuro.co/api/policies/nft/${policy.id}`);
    await expect(pool.tokenURI(1233)).to.be.revertedWithCustomError(pool, "ERC721NonexistentToken").withArgs(1233);
  });

  it("Initialize PolicyPool without name and symbol fails", async () => {
    const currency = await initCurrency(
      { name: "Test USDC", symbol: "USDC", decimals: 6, initial_supply: _A(10000) },
      [lp, cust, backend],
      [_A(5000), _A(500), _A(1000)]
    );
    const PolicyPool = await hre.ethers.getContractFactory("PolicyPool");

    await expect(
      deployPool({
        nftName: "",
        currency: currency,
        grantRoles: ["LEVEL1_ROLE", "LEVEL2_ROLE"],
        treasuryAddress: "0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199", // Random address
      })
    ).to.be.revertedWithCustomError(PolicyPool, "NoEmptyName");

    await expect(
      deployPool({
        nftSymbol: "",
        currency: currency,
        grantRoles: ["LEVEL1_ROLE", "LEVEL2_ROLE"],
        treasuryAddress: "0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199", // Random address
      })
    ).to.be.revertedWithCustomError(PolicyPool, "NoEmptySymbol");
  });
});
