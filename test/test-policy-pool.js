const { expect } = require("chai");
const { grantRole, amountFunction, _W, getTransactionEvent, accessControlMessage } = require("../js/utils");
const {
  addEToken,
  addRiskModule,
  createEToken,
  createRiskModule,
  deployPool,
  deployPremiumsAccount,
  initCurrency,
} = require("../js/test-utils");
const hre = require("hardhat");
const helpers = require("@nomicfoundation/hardhat-network-helpers");
const { ComponentStatus } = require("../js/enums.js");
const { ZeroAddress } = hre.ethers;

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
    await expect(pool.connect(backend).setTreasury(newTreasury)).to.be.revertedWith(
      accessControlMessage(backend, null, "LEVEL1_ROLE")
    );

    // User with LEVEL2_ROLE fails
    await grantRole(hre, accessManager, "LEVEL2_ROLE", backend);
    await expect(pool.connect(backend).setTreasury(newTreasury)).to.be.revertedWith(
      accessControlMessage(backend, null, "LEVEL1_ROLE")
    );

    // User with LEVEL1_ROLE passes
    await grantRole(hre, accessManager, "LEVEL1_ROLE", backend);

    // Cant set treasury to 0x0
    const zeroAddress = "0x0000000000000000000000000000000000000000";
    await expect(pool.connect(backend).setTreasury(zeroAddress)).to.be.revertedWith(
      "PolicyPool: treasury cannot be the zero address"
    );

    await expect(pool.connect(backend).setTreasury(newTreasury)).to.emit(pool, "ComponentChanged");

    expect(await pool.treasury()).to.equal(newTreasury);
  });

  it("Only allows LEVEL1_ROLE to add components", async () => {
    const { pool, accessManager } = await helpers.loadFixture(deployPoolFixture);
    const premiumsAccount = await deployPremiumsAccount(pool, {}, false);

    await expect(pool.connect(backend).addComponent(premiumsAccount, 3)).to.be.revertedWith(
      accessControlMessage(backend, null, "LEVEL1_ROLE")
    );

    await grantRole(hre, accessManager, "LEVEL2_ROLE", backend);
    await expect(pool.connect(backend).addComponent(premiumsAccount, 3)).to.be.revertedWith(
      accessControlMessage(backend, null, "LEVEL1_ROLE")
    );

    await grantRole(hre, accessManager, "LEVEL1_ROLE", backend);
    await expect(pool.connect(backend).addComponent(premiumsAccount, 3)).to.emit(pool, "ComponentStatusChanged");
  });

  it("Does not allow adding an existing component", async () => {
    const { pool } = await helpers.loadFixture(deployPoolFixture);
    const premiumsAccount = await deployPremiumsAccount(pool, {}, true);

    await expect(pool.addComponent(premiumsAccount, 3)).to.be.revertedWith("Component already in the pool");
  });

  it("Does not allow adding different kind of component", async () => {
    const { pool } = await helpers.loadFixture(deployPoolFixture);

    const etk = await createEToken(pool, {});
    const premiumsAccount = await deployPremiumsAccount(pool, { jrEtk: etk }, false);
    const RiskModule = await hre.ethers.getContractFactory("RiskModuleMock");
    const rm = await createRiskModule(pool, premiumsAccount, RiskModule, {});

    // EToken
    await expect(pool.addComponent(etk, 3)).to.be.revertedWith("PolicyPool: Not the right kind");
    await expect(pool.addComponent(etk, 1)).not.to.be.reverted;

    // RiskModule
    await expect(pool.addComponent(rm, 3)).to.be.revertedWith("PolicyPool: Not the right kind");
    await expect(pool.addComponent(rm, 2)).not.to.be.reverted;

    // Premiums account
    await expect(pool.addComponent(premiumsAccount, 2)).to.be.revertedWith("PolicyPool: Not the right kind");
    await expect(pool.addComponent(premiumsAccount, 3)).not.to.be.reverted;
  });

  it("Does not allow adding a component that belongs to a different pool", async () => {
    const { pool, currency } = await helpers.loadFixture(deployPoolFixture);
    const pool2 = await deployPool({
      currency: currency,
      grantRoles: ["LEVEL1_ROLE", "LEVEL2_ROLE"],
      treasuryAddress: "0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199",
    });

    const premiumsAccount = await deployPremiumsAccount(pool2, {}, false);

    await expect(pool.addComponent(premiumsAccount, 3)).to.be.revertedWith("Component not linked to this pool");
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

    await expect(pool.changeComponentStatus(premiumsAccount, 1)).to.be.revertedWith("Component not found");
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

    await expect(pool.newPolicy(policyData, cust, backend, 11)).to.be.revertedWith(
      "Only the RM can create new policies"
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

    await expect(pool.resolvePolicy([...policy], 0)).to.be.revertedWith("Only the RM can resolve policies");
  });

  it("Does not allow a bigger payout than the one setup in the policy", async () => {
    const { policy, rm } = await helpers.loadFixture(deployRmWithPolicyFixture);

    await expect(rm.connect(backend).resolvePolicy([...policy], policy.payout + _A(10))).to.be.revertedWith(
      "payout > policy.payout"
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
    await expect(pool.replacePolicy([...policy], [...policy], ZeroAddress, 1234)).to.be.revertedWith(
      "Only the RM can create new policies"
    );
  });

  it("Rejects replace policy if the pool is paused", async () => {
    const { accessManager, policy, pool } = await helpers.loadFixture(deployRmWithPolicyFixture);

    await grantRole(hre, accessManager, "GUARDIAN_ROLE", owner);
    await expect(pool.connect(owner).pause()).to.emit(pool, "Paused");

    await expect(pool.replacePolicy([...policy], [...policy], ZeroAddress, 1234)).to.be.revertedWith(
      "Pausable: paused"
    );
  });

  it("Components must be active to replace policies", async () => {
    const { policy, pool, rm, premiumsAccount } = await helpers.loadFixture(deployRmWithPolicyFixture);
    await pool.changeComponentStatus(premiumsAccount, ComponentStatus.deprecated);
    await expect(
      rm
        .connect(backend)
        .replacePolicy([...policy], policy.payout, policy.premium, policy.lossProb, policy.expiration, 1234)
    ).to.be.revertedWith("Component not found or not active");
    await pool.changeComponentStatus(premiumsAccount, ComponentStatus.active);
    await pool.changeComponentStatus(rm, ComponentStatus.deprecated);
    await expect(
      rm
        .connect(backend)
        .replacePolicy([...policy], policy.payout, policy.premium, policy.lossProb, policy.expiration, 1234)
    ).to.be.revertedWith("Component not found or not active");
  });

  it("Does not allow to replace expired policies", async () => {
    const { policy, rm } = await helpers.loadFixture(deployRmWithPolicyFixture);
    await helpers.time.increaseTo(policy.expiration + 100n);
    await expect(
      rm
        .connect(backend)
        .replacePolicy([...policy], policy.payout, policy.premium, policy.lossProb, policy.expiration, 1234)
    ).to.be.revertedWith("Old policy is expired");
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
    await expect(pool.connect(backend).setBaseURI("foobar")).to.be.revertedWith(
      accessControlMessage(backend, null, "LEVEL2_ROLE")
    );

    // User with LEVEL2_ROLE passes
    await grantRole(hre, accessManager, "LEVEL2_ROLE", backend);

    expect(await pool.tokenURI(policy.id)).to.be.equal("");

    // User with no roles fails
    await expect(pool.connect(backend).setBaseURI("https://offchain-v2.ensuro.co/api/policies/nft/"))
      .to.be.emit(pool, "ComponentChanged")
      .withArgs(4, backend);

    expect(await pool.tokenURI(policy.id)).to.be.equal(`https://offchain-v2.ensuro.co/api/policies/nft/${policy.id}`);
    await expect(pool.tokenURI(1233)).to.be.revertedWith("ERC721: invalid token ID");
  });

  it("Initialize PolicyPool without name and symbol fails", async () => {
    const currency = await initCurrency(
      { name: "Test USDC", symbol: "USDC", decimals: 6, initial_supply: _A(10000) },
      [lp, cust, backend],
      [_A(5000), _A(500), _A(1000)]
    );

    await expect(
      deployPool({
        nftName: "",
        currency: currency,
        grantRoles: ["LEVEL1_ROLE", "LEVEL2_ROLE"],
        treasuryAddress: "0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199", // Random address
      })
    ).to.be.revertedWith("PolicyPool: name cannot be empty");

    await expect(
      deployPool({
        nftSymbol: "",
        currency: currency,
        grantRoles: ["LEVEL1_ROLE", "LEVEL2_ROLE"],
        treasuryAddress: "0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199", // Random address
      })
    ).to.be.revertedWith("PolicyPool: symbol cannot be empty");
  });
});
