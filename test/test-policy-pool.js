const { expect } = require("chai");
const {
  amountFunction,
  _W,
  getTransactionEvent,
  makeEIP2612Signature,
  newCaptureAny,
} = require("@ensuro/utils/js/utils");
const { HOUR } = require("@ensuro/utils/js/constants");
const { initCurrency } = require("@ensuro/utils/js/test-utils");
const { addEToken, createEToken, deployPool, deployPremiumsAccount } = require("../js/test-utils");
const helpers = require("@nomicfoundation/hardhat-network-helpers");
const { ComponentStatus, ComponentKind } = require("../js/enums.js");
const hre = require("hardhat");
const { ethers } = hre;
const { ZeroAddress, ZeroHash } = ethers;

const _A = amountFunction(6);
const TREASURY = "0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199"; // Random address

async function createNewPolicy(
  rm,
  cust,
  pool,
  payout,
  purePremium,
  lossProb,
  expiration,
  payer,
  holder,
  internalId,
  overrides = {}
) {
  const policyData = [
    0, // id - ignored
    payout,
    overrides.jrScr || _A(0), // jrScr
    overrides.srScr || _A(0), // srScr
    lossProb,
    purePremium,
    overrides.ensuroCommission || _A(0), // ensuroCommission
    overrides.partnerCommission || _A(0), // partnerCommission
    overrides.jrCoc || _A(0), // jrCoc
    overrides.srCoc || _A(0), // srCoc
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
  const [owner, lp, cust, backend, lp2] = await hre.ethers.getSigners();
  const currency = await initCurrency(
    { name: "Test USDC", symbol: "USDC", decimals: 6, initial_supply: _A(10000), contractClass: "TestCurrencyPermit" },
    [lp, cust, backend],
    [_A(5000), _A(500), _A(1000)]
  );

  const pool = await deployPool({
    currency: currency,
    treasuryAddress: TREASURY,
  });
  pool._A = _A;

  return { owner, lp, cust, backend, pool, currency, lp2 };
}

async function deployETKFixture() {
  const ret = await helpers.loadFixture(deployPoolFixture);
  const { pool } = ret;
  // Setup the liquidity sources
  const etk = await addEToken(pool, {});

  return { etk, ...ret };
}

async function deployRiskModuleFixture() {
  const ret = await helpers.loadFixture(deployPoolFixture);
  const { pool, currency, lp } = ret;
  // Setup the liquidity sources
  const jrEtk = await addEToken(pool, {});
  const srEtk = await addEToken(pool, {});
  const premiumsAccount = await deployPremiumsAccount(pool, { srEtk, jrEtk });

  await currency.connect(lp).approve(pool, _A(5000));
  await pool.connect(lp).deposit(srEtk, _A(4000), lp);

  await pool.connect(lp).deposit(jrEtk, _A(1000), lp);

  // Setup the risk module
  const RiskModuleMock = await hre.ethers.getContractFactory("RiskModuleMock");
  const rmMock = await RiskModuleMock.deploy(pool, premiumsAccount, lp);
  const PolicyPool = await hre.ethers.getContractFactory("PolicyPool");
  const rm = PolicyPool.attach(rmMock);
  await pool.addComponent(rm, ComponentKind.riskModule);

  return { jrEtk, srEtk, premiumsAccount, rm, ...ret };
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
    now + HOUR * 5, // expiration
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
      now + HOUR * 5, // expiration
    ];

    await expect(pool.newPolicy(policyData, cust, backend, 11))
      .to.be.revertedWithCustomError(pool, "ComponentNotTheRightKind")
      .withArgs(owner, ComponentKind.riskModule);
  });

  it("Fails if doing deposits to ZeroAddress receiver", async () => {
    const { pool, lp, lp2, etk, currency } = await helpers.loadFixture(deployETKFixture);

    await expect(pool.connect(lp).deposit(etk, _A(100), ZeroAddress))
      .to.be.revertedWithCustomError(pool, "InvalidReceiver")
      .withArgs(ZeroAddress);

    // Same, but using depositWithPermit
    const { sig, deadline } = await makeEIP2612Signature(hre, currency, lp, await ethers.resolveAddress(lp2), _A(300));
    await expect(pool.connect(lp2).depositWithPermit(etk, _A(100), ZeroAddress, deadline, sig.v, sig.r, sig.s))
      .to.be.revertedWithCustomError(pool, "InvalidReceiver")
      .withArgs(ZeroAddress);
  });

  it("Can deposit with permit, even if front-runned", async () => {
    const { pool, lp, lp2, etk, currency } = await helpers.loadFixture(deployETKFixture);

    const { sig, deadline } = await makeEIP2612Signature(hre, currency, lp, await ethers.resolveAddress(pool), _A(300));
    await expect(pool.connect(lp).depositWithPermit(etk, _A(300), lp2, deadline, sig.v, sig.r, sig.s))
      .to.emit(pool, "Deposit")
      .withArgs(etk, lp, lp2, _A(300));
    expect(await currency.allowance(lp, pool)).to.equal(0);

    // Repeat the same front-running the permit call
    const { sig: sig2, deadline: deadline2 } = await makeEIP2612Signature(
      hre,
      currency,
      lp,
      await ethers.resolveAddress(pool),
      _A(120)
    );
    await expect(currency.permit(lp, pool, _A(120), deadline2, sig2.v, sig2.r, sig2.s)).to.emit(currency, "Approval");
    await expect(pool.connect(lp).depositWithPermit(etk, _A(120), lp2, deadline2, sig2.v, sig2.r, sig2.s)).to.emit(
      pool,
      "Deposit"
    );

    expect(await etk.balanceOf(lp2)).to.be.equal(_A(420));
  });

  it("Fails if doing withdrawals to ZeroAddress receiver, otherwise sends the money to receiver", async () => {
    const { pool, lp, etk, currency, lp2 } = await helpers.loadFixture(deployETKFixture);

    await currency.connect(lp).approve(pool, _A(100));
    await expect(pool.connect(lp).deposit(etk, _A(100), lp)).to.emit(pool, "Deposit");

    await expect(pool.connect(lp).withdraw(etk, _A(100), ZeroAddress, lp))
      .to.be.revertedWithCustomError(pool, "InvalidReceiver")
      .withArgs(ZeroAddress);

    expect(await currency.balanceOf(lp2)).to.equal(0);
    await expect(pool.connect(lp).withdraw(etk, _A(100), lp2, lp))
      .to.emit(pool, "Withdraw")
      .withArgs(etk, lp, lp2, lp, _A(100));
    expect(await currency.balanceOf(lp2)).to.equal(_A(100));
  });

  it("Can do withdrawals on behalf of other user, if I have allowance", async () => {
    const { pool, lp, etk, currency, lp2 } = await helpers.loadFixture(deployETKFixture);

    await currency.connect(lp).approve(pool, _A(100));
    await expect(pool.connect(lp).deposit(etk, _A(100), lp)).to.emit(pool, "Deposit");

    await etk.connect(lp).approve(lp2, _A(90));

    expect(await currency.balanceOf(lp2)).to.equal(0);
    await expect(pool.connect(lp2).withdraw(etk, _A(100), lp2, lp))
      .to.be.revertedWithCustomError(etk, "ERC20InsufficientAllowance")
      .withArgs(lp2, _A(90), _A(100));
    await expect(pool.connect(lp2).withdraw(etk, _A(80), lp2, lp))
      .to.emit(pool, "Withdraw")
      .withArgs(etk, lp2, lp2, lp, _A(80));
    expect(await currency.balanceOf(lp2)).to.equal(_A(80));
    expect(await etk.allowance(lp, lp2)).to.equal(_A(10));
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
      now + HOUR * 5, // expiration
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

  it("Does not allow to replace with expired policy", async () => {
    const { policy, rm, pool, backend } = await helpers.loadFixture(deployRmWithPolicyFixture);
    await helpers.time.increaseTo(policy.expiration - BigInt(HOUR));
    const newPolicy = [...policy];
    newPolicy[11] = policy.expiration - BigInt(2 * HOUR); // change expiration
    await expect(rm.replacePolicy([...policy], [...newPolicy], backend, 1234))
      .to.be.revertedWithCustomError(pool, "PolicyAlreadyExpired")
      .withArgs(policy.id);
  });

  it("Must revert if new policy premiums components are lower than old policy", async () => {
    const { rm, pool, backend, cust } = await helpers.loadFixture(deployRmWithPolicyFixture);

    const now = await helpers.time.latest();
    const p1 = await createNewPolicy(rm, backend, pool, _A(1000), _A(9), _W(0), now + HOUR * 5, cust, cust, 222, {
      partnerCommission: _A("0.4"),
      jrCoc: _A("0.3"),
      srCoc: _A("0.2"),
      ensuroCommission: _A("0.1"),
    });
    let p2 = [...p1];
    p2[7] -= _A("0.1"); // decrease partnerCommission
    await expect(rm.replacePolicy([...p1], [...p2], backend, 1234))
      .to.be.revertedWithCustomError(pool, "InvalidPolicyReplacement")
      .withArgs(p1, p2);

    p2 = [...p1];
    p2[6] -= _A("0.1"); // decrease ensuroCommission
    await expect(rm.replacePolicy([...p1], [...p2], backend, 1234))
      .to.be.revertedWithCustomError(pool, "InvalidPolicyReplacement")
      .withArgs(p1, p2);

    p2 = [...p1];
    p2[8] -= _A("0.1"); // decrease jrCoc
    await expect(rm.replacePolicy([...p1], [...p2], backend, 1234))
      .to.be.revertedWithCustomError(pool, "InvalidPolicyReplacement")
      .withArgs(p1, p2);

    p2 = [...p1];
    p2[9] -= _A("0.1"); // decrease srCoc
    await expect(rm.replacePolicy([...p1], [...p2], backend, 1234))
      .to.be.revertedWithCustomError(pool, "InvalidPolicyReplacement")
      .withArgs(p1, p2);

    p2 = [...p1];
    p2[5] -= _A("0.1"); // decrease purePremium
    await expect(rm.replacePolicy([...p1], [...p2], backend, 1234))
      .to.be.revertedWithCustomError(pool, "InvalidPolicyReplacement")
      .withArgs(p1, p2);
  });

  it("Must revert if new policy have different start date", async () => {
    const { rm, pool, policy, backend, cust } = await helpers.loadFixture(deployRmWithPolicyFixture);

    await helpers.time.increaseTo(policy.start + 100n);
    const now = await helpers.time.latest();
    const p = await createNewPolicy(rm, backend, pool, _A(1000), _A(10), _W(0), now + HOUR * 5, cust, cust, 1234);
    await expect(rm.replacePolicy([...policy], [...p], backend, 123))
      .to.be.revertedWithCustomError(pool, "InvalidPolicyReplacement")
      .withArgs(policy, p);
  });

  it("Should accept changes in the interest rate - Longer policy", async () => {
    const { rm, pool, jrEtk, srEtk, backend, cust } = await helpers.loadFixture(deployRmWithPolicyFixture);

    const now = await helpers.time.latest();
    const p1 = await createNewPolicy(rm, backend, pool, _A(1000), _A(9), _W(0), now + HOUR * 10, cust, cust, 222, {
      partnerCommission: _A("0.4"),
      jrScr: _A(100),
      srScr: _A(500),
      jrCoc: _A("0.3"),
      srCoc: _A("0.2"),
      ensuroCommission: _A("0.1"),
    });
    let p2 = [...p1];
    p2[11] = now + HOUR * 20; // Double duration
    await helpers.time.increaseTo(now + HOUR * 7);
    const replacementIRJr = newCaptureAny();
    const originalIRJr = newCaptureAny();
    const adjustmentJr = newCaptureAny();
    const replacementIRSr = newCaptureAny();
    const originalIRSr = newCaptureAny();
    const adjustmentSr = newCaptureAny();
    const [oldPolicyId, newPolicyId] = [p1[0], p1[0] - 222n + 234n];
    await expect(rm.replacePolicy([...p1], [...p2], backend, 234))
      .to.emit(pool, "PolicyReplaced")
      .withArgs(rm, oldPolicyId, newPolicyId)
      .to.emit(jrEtk, "SCRLocked")
      .withArgs(newPolicyId, replacementIRJr.uint, p1[2])
      .to.emit(jrEtk, "SCRUnlocked")
      .withArgs(oldPolicyId, originalIRJr.uint, p1[2], adjustmentJr.value)
      .to.emit(srEtk, "SCRLocked")
      .withArgs(newPolicyId, replacementIRSr.uint, p1[3])
      .to.emit(srEtk, "SCRUnlocked")
      .withArgs(oldPolicyId, originalIRSr.uint, p1[3], adjustmentSr.value);

    // Interest rate halfs (because same CoC for double of the duration)
    expect(replacementIRJr.lastUint).to.closeTo(originalIRJr.lastUint / 2n, originalIRJr.lastUint / 1000n);
    // Adjustment happens at 7/10 duration, for an amount that is half of the accrued so far (because IR is 1/2)
    expect(adjustmentJr.lastValue).to.closeTo((_A("0.3") * -7n) / 10n / 2n, 10n);
    // Interest rate doubles (because same CoC for half of the duration)
    expect(replacementIRSr.lastUint).to.closeTo(originalIRSr.lastUint / 2n, originalIRSr.lastUint / 1000n);
    // Adjustment happens at 3/5 duration, for an amount that is half of the accrued so far (because IR is 2x)
    expect(adjustmentSr.lastValue).to.closeTo((_A("0.2") * -7n) / 10n / 2n, 10n);
  });

  it("Should accept changes in the interest rate - Shorter policy", async () => {
    const { rm, pool, jrEtk, srEtk, backend, cust } = await helpers.loadFixture(deployRmWithPolicyFixture);

    const now = await helpers.time.latest();
    const p1 = await createNewPolicy(rm, backend, pool, _A(1000), _A(9), _W(0), now + HOUR * 10, cust, cust, 222, {
      partnerCommission: _A("0.4"),
      jrScr: _A(100),
      srScr: _A(500),
      jrCoc: _A("0.3"),
      srCoc: _A("0.2"),
      ensuroCommission: _A("0.1"),
    });
    let p2 = [...p1];
    p2[11] = now + HOUR * 5; // Cut duration by half
    await helpers.time.increaseTo(now + HOUR * 3);
    const replacementIRJr = newCaptureAny();
    const originalIRJr = newCaptureAny();
    const adjustmentJr = newCaptureAny();
    const replacementIRSr = newCaptureAny();
    const originalIRSr = newCaptureAny();
    const adjustmentSr = newCaptureAny();
    const [oldPolicyId, newPolicyId] = [p1[0], p1[0] - 222n + 234n];
    await expect(rm.replacePolicy([...p1], [...p2], backend, 234))
      .to.emit(pool, "PolicyReplaced")
      .withArgs(rm, oldPolicyId, newPolicyId)
      .to.emit(jrEtk, "SCRLocked")
      .withArgs(newPolicyId, replacementIRJr.uint, p1[2])
      .to.emit(jrEtk, "SCRUnlocked")
      .withArgs(oldPolicyId, originalIRJr.uint, p1[2], adjustmentJr.uint)
      .to.emit(srEtk, "SCRLocked")
      .withArgs(newPolicyId, replacementIRSr.uint, p1[3])
      .to.emit(srEtk, "SCRUnlocked")
      .withArgs(oldPolicyId, originalIRSr.uint, p1[3], adjustmentSr.uint);

    // Interest rate doubles (because same CoC for half of the duration)
    expect(replacementIRJr.lastUint).to.closeTo(originalIRJr.lastUint * 2n, originalIRJr.lastUint / 1000n);
    // Adjustment happens at 3/5 duration, for an amount that is half of the accrued so far (because IR is 2x)
    expect(adjustmentJr.lastUint).to.closeTo((_A("0.3") * 3n) / 5n / 2n, 10n);
    // Interest rate doubles (because same CoC for half of the duration)
    expect(replacementIRSr.lastUint).to.closeTo(originalIRSr.lastUint * 2n, originalIRSr.lastUint / 1000n);
    // Adjustment happens at 3/5 duration, for an amount that is half of the accrued so far (because IR is 2x)
    expect(adjustmentSr.lastUint).to.closeTo((_A("0.2") * 3n) / 5n / 2n, 10n);
  });

  it("Should accept changes in the payout and locked capital", async () => {
    const { rm, pool, jrEtk, srEtk, backend, cust, currency } = await helpers.loadFixture(deployRmWithPolicyFixture);

    const now = await helpers.time.latest();
    const p1 = await createNewPolicy(rm, backend, pool, _A(1000), _A(9), _W(0), now + HOUR * 10, cust, cust, 222, {
      partnerCommission: _A("0.4"),
      jrScr: _A(100),
      srScr: _A(500),
      jrCoc: _A("0.3"),
      srCoc: _A("0.2"),
      ensuroCommission: _A("0.1"),
    });
    let p2 = [...p1];
    p2[1] = _A(2000); // payout 2x
    p2[2] = _A(50); // jrScr 1/2x
    p2[3] = _A(1000); // srScr 2x
    p2[9] = _A("0.6"); // srCoc 3x

    await helpers.time.increaseTo(now + HOUR * 3);

    // Check exposure is increased
    await expect(rm.replacePolicy([...p1], [...p2], backend, 234))
      .to.be.revertedWithCustomError(pool, "ExposureLimitExceeded")
      .withArgs(_A(3000), _A(2000));

    await pool.setExposureLimit(rm, _A(3000));

    // Increase in srCoc requires new allowance
    await expect(rm.replacePolicy([...p1], [...p2], backend, 234))
      .to.be.revertedWithCustomError(currency, "ERC20InsufficientAllowance")
      .withArgs(pool, _A(0), _A("0.4"));

    await currency.connect(backend).approve(pool, _A("0.4"));

    const replacementIRJr = newCaptureAny();
    const originalIRJr = newCaptureAny();
    const adjustmentJr = newCaptureAny();
    const replacementIRSr = newCaptureAny();
    const originalIRSr = newCaptureAny();
    const adjustmentSr = newCaptureAny();
    const [oldPolicyId, newPolicyId] = [p1[0], p1[0] - 222n + 234n];
    await expect(rm.replacePolicy([...p1], [...p2], backend, 234))
      .to.emit(pool, "PolicyReplaced")
      .withArgs(rm, oldPolicyId, newPolicyId)
      .to.emit(jrEtk, "SCRLocked")
      .withArgs(newPolicyId, replacementIRJr.uint, _A(50))
      .to.emit(jrEtk, "SCRUnlocked")
      .withArgs(oldPolicyId, originalIRJr.uint, _A(100), adjustmentJr.uint)
      .to.emit(srEtk, "SCRLocked")
      .withArgs(newPolicyId, replacementIRSr.uint, _A(1000))
      .to.emit(srEtk, "SCRUnlocked")
      .withArgs(oldPolicyId, originalIRSr.uint, _A(500), adjustmentSr.uint);

    // Interest rate doubles (because same CoC for half of the SCR)
    expect(replacementIRJr.lastUint).to.closeTo(originalIRJr.lastUint * 2n, originalIRJr.lastUint / 1000n);
    // Adjustment is zero because even when IR doubles, SCR cuts by half, then accrued interest remains the same
    expect(adjustmentJr.lastUint).to.closeTo(0n, 10n);
    // Interest rate increases 50% (2x SCR vs 3x CoC)
    expect(replacementIRSr.lastUint).to.closeTo((originalIRSr.lastUint * 3n) / 2n, originalIRSr.lastUint / 1000n);
    // Adjustment is the difference of accrued interest with 0.6 CoC vs 0.2 CoC.
    expect(adjustmentSr.lastUint).to.closeTo((_A("0.6") * 3n) / 10n - (_A("0.2") * 3n) / 10n, 100n);
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
