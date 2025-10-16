const { expect } = require("chai");
const { amountFunction, _W, getTransactionEvent } = require("@ensuro/utils/js/utils");
const { initCurrency } = require("@ensuro/utils/js/test-utils");
const { addEToken, createEToken, deployPool, deployPremiumsAccount } = require("../js/test-utils");
const hre = require("hardhat");
const helpers = require("@nomicfoundation/hardhat-network-helpers");
const { ComponentStatus, ComponentKind } = require("../js/enums.js");
const { ZeroAddress, ZeroHash } = hre.ethers;

const _A = amountFunction(6);
const TREASURY = "0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199"; // Random address

async function createNewPolicy(rm, cust, pool, payout, premium, lossProb, expiration, payer, holder, internalId) {
  const policyData = [
    0, // id - ignored
    payout,
    _A(0), // jrScr
    _A(0), // srScr
    lossProb,
    premium,
    _A(0), // ensuroCommission
    _A(0), // partnerCommission
    _A(0), // jrCoc
    _A(0), // srCoc
    await helpers.time.latest(),
    expiration,
  ];

  const tx = await rm.connect(cust).newPolicy([...policyData], payer, holder, internalId);
  const receipt = await tx.wait();
  const newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");
  const policy = newPolicyEvt.args.policy;
  return policy;
}

async function deployPoolFixture() {
  const [owner, lp, cust, backend] = await hre.ethers.getSigners();
  const currency = await initCurrency(
    { name: "Test USDC", symbol: "USDC", decimals: 6, initial_supply: _A(10000) },
    [lp, cust, backend],
    [_A(5000), _A(500), _A(1000)]
  );

  const pool = await deployPool({
    currency: currency,
    treasuryAddress: TREASURY,
  });
  pool._A = _A;

  return { owner, lp, cust, backend, pool, currency };
}

async function deployRiskModuleFixture() {
  const ret = await helpers.loadFixture(deployPoolFixture);
  const { pool, currency, lp } = ret;
  // Setup the liquidity sources
  const etk = await addEToken(pool, {});
  const premiumsAccount = await deployPremiumsAccount(pool, { srEtk: etk });

  await currency.connect(lp).approve(pool, _A(5000));
  await pool.connect(lp).deposit(etk, _A(5000), lp);

  // Setup the risk module
  const RiskModuleMock = await hre.ethers.getContractFactory("RiskModuleMock");
  const rmMock = await RiskModuleMock.deploy(pool, premiumsAccount, lp);
  const PolicyPool = await hre.ethers.getContractFactory("PolicyPool");
  const rm = PolicyPool.attach(rmMock);
  await pool.addComponent(rm, ComponentKind.riskModule);

  return { etk, premiumsAccount, rm, ...ret };
}

async function deployRmWithPolicyFixture() {
  const ret = await helpers.loadFixture(deployRiskModuleFixture);
  const { rm, pool, currency, cust } = ret;
  const now = await helpers.time.latest();

  await pool.setExposureLimit(rm, _A(2000));

  // Deploy a new policy
  await currency.connect(cust).approve(pool, _A(110));

  const policyData = [
    0, // id - Ignored
    _A(1000), // payout
    _A(0), // jrScr
    _A(0), // srScr
    _W("0.1"), // lossProb
    _A(100), // purePremium
    _A(0), // ensuroCommission
    _A(0), // partnerCommission
    _A(0), // jrCoc
    _A(0), // srCoc
    0, // start
    now + 3600 * 5, // expiration
  ];

  const tx = await rm.newPolicy(policyData, cust, cust, 123);

  const receipt = await tx.wait();

  // Try to resolve it without going through the riskModule
  const newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");

  const [active, limit] = await pool.getExposure(rm);
  expect(active).to.be.equal(_A(1000));
  expect(limit).to.be.equal(_A(2000));

  return { policy: newPolicyEvt.args.policy, receipt, now, ...ret };
}

describe("PolicyPool contract", function () {
  it("can change the treasury", async () => {
    const { pool } = await helpers.loadFixture(deployPoolFixture);
    const newTreasury = "0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199";

    // Cant set treasury to 0x0
    await expect(pool.setTreasury(ZeroAddress)).to.be.revertedWithCustomError(pool, "NoZeroTreasury");

    await expect(pool.setTreasury(newTreasury)).to.emit(pool, "TreasuryChanged").withArgs(TREASURY, newTreasury);

    expect(await pool.treasury()).to.equal(newTreasury);
  });

  it("can add components", async () => {
    const { pool } = await helpers.loadFixture(deployPoolFixture);
    const premiumsAccount = await deployPremiumsAccount(pool, {}, false);

    await expect(pool.addComponent(premiumsAccount, ComponentKind.premiumsAccount)).to.emit(
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
    const RiskModuleMock = await hre.ethers.getContractFactory("RiskModuleMock");
    const rm = await RiskModuleMock.deploy(pool, premiumsAccount, ZeroAddress);

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
    const { pool } = await helpers.loadFixture(deployPoolFixture);
    const premiumsAccount = await deployPremiumsAccount(pool, {}, false);

    await expect(pool.changeComponentStatus(premiumsAccount, 1)).to.be.revertedWithCustomError(
      pool,
      "ComponentNotFound"
    );
  });

  it("Only allows riskmodule to create policies", async () => {
    const { pool, cust, backend, owner } = await helpers.loadFixture(deployPoolFixture);
    const now = await helpers.time.latest();
    const policyData = [
      1, // id
      _A(1000), // payout
      _W(0), // jrScr
      _W(0), // srScr
      _W("0.1"), // lossProb
      _W(10), // purePremium
      _W(0), // ensuroCommission
      _W(0), // partnerCommission
      _W(0), // jrCoc
      _W(0), // srCoc
      now, // start
      now + 3600 * 5, // expiration
    ];

    await expect(pool.newPolicy(policyData, cust, backend, 11))
      .to.be.revertedWithCustomError(pool, "ComponentNotTheRightKind")
      .withArgs(owner, ComponentKind.riskModule);
  });

  it("Can't change the exposure limit to something lower than the active exposure", async () => {
    const { pool, rm } = await helpers.loadFixture(deployRmWithPolicyFixture);
    const [active, limit] = await pool.getExposure(rm);
    expect(limit).to.equal(_A(2000));
    expect(active).to.equal(_A(1000));
    await expect(pool.setExposureLimit(rm, _A(999)))
      .to.be.revertedWithCustomError(pool, "ExposureLimitExceeded")
      .withArgs(active, _A(999));
  });

  it("Can't have two policies with the same internalId", async () => {
    const { pool, rm, cust, backend, policy } = await helpers.loadFixture(deployRmWithPolicyFixture);
    const now = await helpers.time.latest();
    const policyData = [
      1, // id
      _A(1000), // payout
      _W(0), // jrScr
      _W(0), // srScr
      _W("0.1"), // lossProb
      _W(10), // purePremium
      _W(0), // ensuroCommission
      _W(0), // partnerCommission
      _W(0), // jrCoc
      _W(0), // srCoc
      now, // start
      now + 3600 * 5, // expiration
    ];

    await expect(rm.newPolicy(policyData, cust, backend, 123))
      .to.be.revertedWithCustomError(pool, "PolicyAlreadyExists")
      .withArgs(policy.id);
  });

  it("Only allows to resolve a policy once", async () => {
    const { policy, rm, pool } = await helpers.loadFixture(deployRmWithPolicyFixture);
    expect(await pool.isActive(policy.id)).to.be.true;
    // At least check it's not equal to 0. Doesn't make sense to add in the test the hash calculation
    expect(await pool.getPolicyHash(policy.id)).not.to.be.equal(ZeroHash);
    await expect(rm.resolvePolicy([...policy], policy.payout)).not.to.be.reverted;
    expect(await pool.isActive(policy.id)).to.be.false;
    expect(await pool.getPolicyHash(policy.id)).to.be.equal(ZeroHash);
    await expect(rm.resolvePolicy([...policy], _A(100)))
      .to.be.revertedWithCustomError(pool, "PolicyNotFound")
      .withArgs(policy.id);
  });

  it("Only allows riskmodule to resolve unexpired policies", async () => {
    const { policy, pool } = await helpers.loadFixture(deployRmWithPolicyFixture);

    await expect(pool.resolvePolicy([...policy], 0)).to.be.revertedWithCustomError(pool, "OnlyRiskModuleAllowed");
  });

  it("Does not allow a bigger payout than the one setup in the policy", async () => {
    const { policy, rm, pool } = await helpers.loadFixture(deployRmWithPolicyFixture);

    await expect(rm.resolvePolicy([...policy], policy.payout + _A(10)))
      .to.be.revertedWithCustomError(pool, "PayoutExceedsLimit")
      .withArgs(policy.payout + _A(10), policy.payout);
  });

  it("Can't expire policies when the pool is paused", async () => {
    const { policy, pool } = await helpers.loadFixture(deployRmWithPolicyFixture);

    await expect(pool.pause()).to.emit(pool, "Paused");

    await expect(pool.expirePolicies([[...policy]])).to.be.revertedWithCustomError(pool, "EnforcedPause");
  });

  it("Can't replace resolved policies", async () => {
    const { policy, rm, pool } = await helpers.loadFixture(deployRmWithPolicyFixture);
    await expect(rm.resolvePolicy([...policy], policy.payout)).not.to.be.reverted;
    expect(await pool.isActive(policy.id)).to.be.false;
    await expect(pool.replacePolicy([...policy], [...policy], ZeroAddress, 1234))
      .to.be.revertedWithCustomError(pool, "PolicyNotFound")
      .withArgs(policy.id);
  });

  it("Only RM can replace policies", async () => {
    const { policy, pool } = await helpers.loadFixture(deployRmWithPolicyFixture);
    await expect(pool.replacePolicy([...policy], [...policy], ZeroAddress, 1234)).to.be.revertedWithCustomError(
      pool,
      "OnlyRiskModuleAllowed"
    );
  });

  it("Rejects replace policy if the pool is paused", async () => {
    const { policy, pool } = await helpers.loadFixture(deployRmWithPolicyFixture);

    await expect(pool.pause()).to.emit(pool, "Paused");

    await expect(pool.replacePolicy([...policy], [...policy], ZeroAddress, 1234)).to.be.revertedWithCustomError(
      pool,
      "EnforcedPause"
    );
  });

  it("Components must be active to replace policies", async () => {
    const { policy, pool, rm, premiumsAccount, backend } = await helpers.loadFixture(deployRmWithPolicyFixture);
    await pool.changeComponentStatus(premiumsAccount, ComponentStatus.deprecated);

    await expect(rm.replacePolicy([...policy], [...policy], backend, 1234)).to.be.revertedWithCustomError(
      pool,
      "ComponentNotFoundOrNotActive"
    );
    await pool.changeComponentStatus(premiumsAccount, ComponentStatus.active);
    await pool.changeComponentStatus(rm, ComponentStatus.deprecated);
    await expect(rm.replacePolicy([...policy], [...policy], backend, 1234)).to.be.revertedWithCustomError(
      pool,
      "ComponentNotFoundOrNotActive"
    );
  });

  it("Does not allow to replace expired policies", async () => {
    const { policy, rm, pool, backend } = await helpers.loadFixture(deployRmWithPolicyFixture);
    await helpers.time.increaseTo(policy.expiration + 100n);
    const newPolicy = [...policy];
    newPolicy[11] += 1000n; // change expiration
    await expect(rm.replacePolicy([...policy], [...newPolicy], backend, 1234))
      .to.be.revertedWithCustomError(pool, "PolicyAlreadyExpired")
      .withArgs(policy.id);
  });

  it("Must revert if new policy values must be greater or equal than old policy", async () => {
    const { rm, pool, backend, cust } = await helpers.loadFixture(deployRmWithPolicyFixture);

    const now = await helpers.time.latest();
    const p1 = await createNewPolicy(rm, backend, pool, _A(1000), _A(10), _W(0), now + 3600 * 5, cust, cust, 222);
    let p2 = [...p1];
    p2[1] -= _A(1); // change new policy payout
    await expect(rm.replacePolicy([...p1], [...p2], backend, 1234))
      .to.be.revertedWithCustomError(pool, "InvalidPolicyReplacement")
      .withArgs(p1, p2);
  });

  it("Must revert if new policy have different start date", async () => {
    const { rm, pool, policy, backend, cust } = await helpers.loadFixture(deployRmWithPolicyFixture);

    await helpers.time.increaseTo(policy.start + 100n);
    const now = await helpers.time.latest();
    const p = await createNewPolicy(rm, backend, pool, _A(1000), _A(10), _W(0), now + 3600 * 5, cust, cust, 1234);
    await expect(rm.replacePolicy([...policy], [...p], backend, 123))
      .to.be.revertedWithCustomError(pool, "InvalidPolicyReplacement")
      .withArgs(policy, p);
  });

  it("Only PolicyPool can call PA policyReplaced", async () => {
    const { pool, policy } = await helpers.loadFixture(deployRmWithPolicyFixture);

    const etk = await createEToken(pool, {});
    const pa = await deployPremiumsAccount(pool, { srEtk: etk });
    await expect(pa.policyReplaced([...policy], [...policy])).to.be.revertedWithCustomError(pa, "OnlyPolicyPool");
  });

  it("Replacement policy must have a new unique internalId", async () => {
    const { policy, rm, pool, backend } = await helpers.loadFixture(deployRmWithPolicyFixture);
    await expect(rm.replacePolicy([...policy], [...policy], backend, 123))
      .to.be.revertedWithCustomError(pool, "PolicyAlreadyExists")
      .withArgs(policy.id);
  });

  it("Can change the baseURI and after the change the tokenURI works", async () => {
    const { policy, pool, backend } = await helpers.loadFixture(deployRmWithPolicyFixture);

    expect(await pool.tokenURI(policy.id)).to.be.equal("");

    // User with no roles fails
    await expect(pool.connect(backend).setBaseURI("https://offchain-v2.ensuro.co/api/policies/nft/"))
      .to.be.emit(pool, "BaseURIChanged")
      .withArgs("", "https://offchain-v2.ensuro.co/api/policies/nft/");

    expect(await pool.tokenURI(policy.id)).to.be.equal(`https://offchain-v2.ensuro.co/api/policies/nft/${policy.id}`);
    await expect(pool.tokenURI(1233)).to.be.revertedWithCustomError(pool, "ERC721NonexistentToken").withArgs(1233);
  });

  it("Initialize PolicyPool without name and symbol fails", async () => {
    const [, lp, cust, backend] = await hre.ethers.getSigners();
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
        treasuryAddress: "0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199", // Random address
      })
    ).to.be.revertedWithCustomError(PolicyPool, "NoEmptyName");

    await expect(
      deployPool({
        nftSymbol: "",
        currency: currency,
        treasuryAddress: "0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199", // Random address
      })
    ).to.be.revertedWithCustomError(PolicyPool, "NoEmptySymbol");
  });
});
