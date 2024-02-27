const { expect } = require("chai");
const { amountFunction, grantComponentRole, grantRole, _W, accessControlMessage } = require("../js/utils");
const {
  initCurrency,
  deployPool,
  deployPremiumsAccount,
  addRiskModule,
  makePolicy,
  addEToken,
} = require("../js/test-utils");
const helpers = require("@nomicfoundation/hardhat-network-helpers");

describe("Test pause, unpause and upgrade contracts", function () {
  let currency;
  let pool;
  let premiumsAccount;
  let TrustfulRiskModule;
  let cust, guardian, level1, lp, owner;
  let _A;
  let etk;
  let accessManager;
  let rm;

  beforeEach(async () => {
    [owner, lp, cust, guardian, level1] = await hre.ethers.getSigners();

    _A = amountFunction(6);

    currency = await initCurrency(
      { name: "Test USDC", symbol: "USDC", decimals: 6, initial_supply: _A(10000) },
      [lp, cust],
      [_A(5000), _A(500)]
    );

    pool = await deployPool({
      currency: currency,
      grantRoles: [],
      treasuryAddress: "0x87c47c9a5a2aa74ae714857d64911d9a091c25b1", // Random address
    });
    pool._A = _A;

    etk = await addEToken(pool, {});

    premiumsAccount = await deployPremiumsAccount(pool, { srEtk: etk });
    accessManager = await hre.ethers.getContractAt("AccessManager", await pool.access());
    TrustfulRiskModule = await hre.ethers.getContractFactory("TrustfulRiskModule");
    rm = await addRiskModule(pool, premiumsAccount, TrustfulRiskModule, {});

    await grantRole(hre, accessManager, "GUARDIAN_ROLE", guardian);
    await grantRole(hre, accessManager, "LEVEL1_ROLE", level1);

    // Roles to create and resolve policies
    await grantComponentRole(hre, accessManager, rm, "PRICER_ROLE", cust);
    await grantComponentRole(hre, accessManager, rm, "RESOLVER_ROLE", cust);

    await currency.connect(lp).approve(pool, _A(3000));
    await pool.connect(lp).deposit(etk, _A(3000));
  });

  it("Pause and Unpause PolicyPool", async function () {
    const start = await helpers.time.latest();

    // Try to pause PolicyPool without permissions
    await expect(pool.pause()).to.be.revertedWith(accessControlMessage(owner, null, "GUARDIAN_ROLE"));
    expect(await pool.paused()).to.be.equal(false);
    await currency.connect(cust).approve(pool, _A(100));

    // Pause PolicyPool
    await pool.connect(guardian).pause();
    expect(await pool.paused()).to.be.equal(true);

    await expect(pool.connect(lp).deposit(etk, _A(3000))).to.be.revertedWith("Pausable: paused");
    await expect(pool.connect(lp).withdraw(etk, _A(3000))).to.be.revertedWith("Pausable: paused");

    // Can't create policy
    await expect(rm.connect(cust).newPolicy(_A(36), _A(1), _W(1 / 37), start + 3600, cust, 1)).to.be.revertedWith(
      "Pausable: paused"
    );

    // UnPause PolicyPool
    await expect(pool.connect(cust).unpause()).to.be.revertedWith(accessControlMessage(cust, null, "LEVEL1_ROLE"));
    await pool.connect(level1).unpause();
    expect(await pool.paused()).to.be.equal(false);

    await currency.connect(lp).approve(pool, _A(500));
    await pool.connect(lp).deposit(etk, _A(500));
    expect(await etk.balanceOf(lp)).to.be.equal(_A(3500));
    await pool.connect(lp).withdraw(etk, _A(200));
    expect(await etk.balanceOf(lp)).to.be.equal(_A(3300));

    // Can create policy
    const newPolicyEvt = await makePolicy(pool, rm, cust, _A(36), _A(1), _W(1 / 37), start + 3600, 1);
    const policy = newPolicyEvt.args.policy;

    // Pause PolicyPool again
    await pool.connect(guardian).pause();
    // Can't resolve Policy
    await expect(rm.connect(cust).resolvePolicy([...policy], _A(10))).to.be.revertedWith("Pausable: paused");
    // Can't transfer NFTs
    await expect(pool.connect(cust).transferFrom(cust, owner, policy.id)).to.be.revertedWith("Pausable: paused");

    // UnPause PolicyPool
    await pool.connect(guardian).unpause();
    // Can transfer
    expect(await pool.ownerOf(policy.id)).to.be.equal(cust);
    await pool.connect(cust).transferFrom(cust, owner, policy.id);
    expect(await pool.ownerOf(policy.id)).to.be.equal(owner);
    // Can resolve Policy
    await expect(rm.connect(cust).resolvePolicy([...policy], _A(10))).not.to.be.reverted;
  });

  it("Pause/Unpause and resolve policy with full payout", async function () {
    const start = await helpers.time.latest();

    await currency.connect(cust).approve(pool, _A(100));

    // Pause PolicyPool
    await pool.connect(guardian).pause();
    expect(await pool.paused()).to.be.equal(true);

    // Can't create policy
    await expect(rm.connect(cust).newPolicy(_A(36), _A(1), _W(1 / 37), start + 3600, cust, 1)).to.be.revertedWith(
      "Pausable: paused"
    );

    // UnPause PolicyPool
    await pool.connect(level1).unpause();
    expect(await pool.paused()).to.be.equal(false);

    // Can create policy
    const newPolicyEvt = await makePolicy(pool, rm, cust, _A(36), _A(1), _W(1 / 37), start + 3600, 1);
    const policy = newPolicyEvt.args.policy;

    // Pause PolicyPool again
    await pool.connect(guardian).pause();
    // Can't resolve Policy
    await expect(rm.connect(cust).resolvePolicyFullPayout([...policy], true)).to.be.revertedWith("Pausable: paused");
    // UnPause PolicyPool
    await pool.connect(guardian).unpause();
    // Can resolve Policy
    await expect(rm.connect(cust).resolvePolicyFullPayout([...policy], true)).not.to.be.reverted;
  });

  it("Pause/Unpause and expire policy", async function () {
    const start = await helpers.time.latest();

    await currency.connect(cust).approve(pool, _A(100));

    // Pause PolicyPool
    await pool.connect(guardian).pause();
    expect(await pool.paused()).to.be.equal(true);

    // Can't create policy
    await expect(rm.connect(cust).newPolicy(_A(36), _A(1), _W(1 / 37), start + 3600, cust, 1)).to.be.revertedWith(
      "Pausable: paused"
    );

    // UnPause PolicyPool
    await pool.connect(guardian).unpause();
    expect(await pool.paused()).to.be.equal(false);

    // Can create policy
    const newPolicyEvt = await makePolicy(pool, rm, cust, _A(36), _A(1), _W(1 / 37), start + 3600, 1);
    const policy = newPolicyEvt.args.policy;

    // Pause PolicyPool again
    await pool.connect(guardian).pause();
    // Can't expire Policy
    await expect(pool.expirePolicy([...policy])).to.be.revertedWith("Pausable: paused");
    // UnPause PolicyPool
    await pool.connect(level1).unpause();
    // Can expire Policy
    await helpers.time.increaseTo(policy.expiration + 500n);
    await pool.expirePolicy([...policy]);
  });

  it("Pause and Unpause EToken", async function () {
    // Try to pause EToken  without permissions
    await expect(etk.pause()).to.be.revertedWith(accessControlMessage(owner, etk, "GUARDIAN_ROLE"));
    expect(await etk.paused()).to.be.equal(false);
    expect(await etk.balanceOf(lp)).to.be.equal(_A(3000));
    expect(await etk.balanceOf(cust)).to.be.equal(_A(0));
    // Pause EToken
    await etk.connect(guardian).pause();
    expect(await etk.paused()).to.be.equal(true);

    await currency.connect(lp).approve(pool, _A(500));
    await expect(pool.connect(lp).deposit(etk, _A(500))).to.be.revertedWith("Pausable: paused");
    await expect(pool.connect(lp).withdraw(etk, _A(500))).to.be.revertedWith("Pausable: paused");
    await expect(etk.connect(lp).transfer(cust, _A(500))).to.be.revertedWith("Pausable: paused");
    await expect(etk.connect(lp).repayLoan(_A(100), cust)).to.be.revertedWith("Pausable: paused");

    // UnPause EToken
    await etk.unpause();
    expect(await etk.paused()).to.be.equal(false);

    await expect(pool.connect(lp).deposit(etk, _A(500))).not.to.be.reverted;
    await expect(pool.connect(lp).withdraw(etk, _A(500))).not.to.be.reverted;

    await etk.connect(lp).transfer(cust, _A(500));
    expect(await etk.balanceOf(lp)).to.be.equal(_A(2500));
    expect(await etk.balanceOf(cust)).to.be.equal(_A(500));

    await expect(etk.connect(cust).pause()).to.be.revertedWith(accessControlMessage(cust, etk, "GUARDIAN_ROLE"));
    await grantComponentRole(hre, accessManager, etk, "GUARDIAN_ROLE", cust);
    await expect(etk.connect(cust).pause()).not.to.be.reverted;
    // The permission is not global, it's only for this component
    await expect(pool.connect(cust).pause()).to.be.revertedWith(accessControlMessage(cust, null, "GUARDIAN_ROLE"));
  });

  it("Pause and Unpause RiskModule resolve policy", async function () {
    const start = await helpers.time.latest();

    // Try to pause RiskModule  without permissions
    await expect(rm.pause()).to.be.revertedWith(accessControlMessage(owner, rm, "GUARDIAN_ROLE"));
    expect(await rm.paused()).to.be.equal(false);

    await currency.connect(cust).approve(pool, _A(1));

    const newPolicyEvt = await makePolicy(pool, rm, cust, _A(36), _A(1), _W(1 / 37), start + 3600, 1);
    const policy = newPolicyEvt.args.policy;

    // Pause RiskModule
    await rm.connect(guardian).pause();
    expect(await rm.paused()).to.be.equal(true);
    await expect(rm.connect(cust).resolvePolicy([...policy], _A(10))).to.be.revertedWith("Pausable: paused");
    // UnPause RiskModule
    await expect(rm.connect(lp).unpause()).to.be.revertedWith(accessControlMessage(lp, rm, "LEVEL1_ROLE"));
    await grantComponentRole(hre, accessManager, rm, "LEVEL1_ROLE", lp);
    await rm.connect(lp).unpause();
    expect(await rm.paused()).to.be.equal(false);

    // Can resolve Policy
    await expect(rm.connect(cust).resolvePolicy([...policy], _A(10))).not.to.be.reverted;
  });

  it("Pause and Unpause RiskModule resolve policy full payout", async function () {
    const start = await helpers.time.latest();

    // Try to pause RiskModule  without permissions
    await expect(rm.pause()).to.be.revertedWith(accessControlMessage(owner, rm, "GUARDIAN_ROLE"));
    expect(await rm.paused()).to.be.equal(false);

    await currency.connect(cust).approve(pool, _A(1));

    const newPolicyEvt = await makePolicy(pool, rm, cust, _A(36), _A(1), _W(1 / 37), start + 3600, 1);
    const policy = newPolicyEvt.args.policy;

    // Pause RiskModule
    await rm.connect(guardian).pause();
    expect(await rm.paused()).to.be.equal(true);
    await expect(rm.connect(cust).resolvePolicyFullPayout([...policy], true)).to.be.revertedWith("Pausable: paused");

    // UnPause RiskModule
    await rm.unpause();
    expect(await rm.paused()).to.be.equal(false);

    // Can resolve Policy
    await expect(rm.connect(cust).resolvePolicyFullPayout([...policy], true)).not.to.be.reverted;
  });

  it("Pause and Unpause PremiumsAccount policyExpired", async function () {
    const start = await helpers.time.latest();

    // Try to pause PremiumsAccount  without permissions
    await expect(premiumsAccount.pause()).to.be.revertedWith(
      accessControlMessage(owner, premiumsAccount, "GUARDIAN_ROLE")
    );
    expect(await premiumsAccount.paused()).to.be.equal(false);

    await currency.connect(cust).approve(pool, _A(1));

    // Pause PremiumsAccount
    await premiumsAccount.connect(guardian).pause();
    expect(await premiumsAccount.paused()).to.be.equal(true);

    // Can't create policy
    await expect(rm.connect(cust).newPolicy(_A(36), _A(1), _W(1 / 37), start + 3600, cust, 1)).to.be.revertedWith(
      "Pausable: paused"
    );

    // UnPause PremiumsAccount
    await premiumsAccount.unpause();
    expect(await premiumsAccount.paused()).to.be.equal(false);

    const newPolicyEvt = await makePolicy(pool, rm, cust, _A(36), _A(1), _W(1 / 37), start + 3600, 1);
    const policy = newPolicyEvt.args.policy;

    // Pause PremiumsAccount again
    await premiumsAccount.connect(guardian).pause();
    // Can't expire Policy
    await helpers.time.increaseTo(policy.expiration + 500n);
    await expect(pool.expirePolicy([...policy])).to.be.revertedWith("Pausable: paused");
    // UnPause PremiumsAccount
    await premiumsAccount.unpause();
    // Can expire Policy
    await expect(pool.expirePolicy([...policy])).not.to.be.reverted;
  });

  it("Pause and Unpause PremiumsAccount policyResolvedWithPayout", async function () {
    const start = await helpers.time.latest();

    // Try to pause PremiumsAccount  without permissions
    await expect(premiumsAccount.pause()).to.be.revertedWith(
      accessControlMessage(owner, premiumsAccount, "GUARDIAN_ROLE")
    );
    expect(await premiumsAccount.paused()).to.be.equal(false);

    await currency.connect(cust).approve(pool, _A(1));

    // Pause PremiumsAccount
    await premiumsAccount.connect(guardian).pause();
    expect(await premiumsAccount.paused()).to.be.equal(true);

    // Can't create policy
    await expect(rm.connect(cust).newPolicy(_A(36), _A(1), _W(1 / 37), start + 3600, cust, 1)).to.be.revertedWith(
      "Pausable: paused"
    );

    // UnPause PremiumsAccount
    await premiumsAccount.unpause();
    expect(await premiumsAccount.paused()).to.be.equal(false);

    const newPolicyEvt = await makePolicy(pool, rm, cust, _A(36), _A(1), _W(1 / 37), start + 3600, 1);
    const policy = newPolicyEvt.args.policy;

    // Pause PremiumsAccount again
    await premiumsAccount.connect(guardian).pause();

    // Can't resolve Policy
    await expect(rm.connect(cust).resolvePolicy([...policy], _A(10))).to.be.revertedWith("Pausable: paused");
    // UnPause PolicyPool
    await premiumsAccount.unpause();
    // Can resolve Policy
    await expect(rm.connect(cust).resolvePolicy([...policy], _A(10))).not.to.be.reverted;

    // Pause PremiumsAccount again
    await premiumsAccount.connect(guardian).pause();

    await grantComponentRole(hre, accessManager, premiumsAccount, "REPAY_LOANS_ROLE", cust);
    // Can't resolve repayLoans
    await expect(premiumsAccount.connect(cust).repayLoans()).to.be.revertedWith("Pausable: paused");

    // UnPause PolicyPool
    await premiumsAccount.unpause();

    // Can repayLoans
    await expect(premiumsAccount.connect(cust).repayLoans()).not.to.be.reverted;
  });

  it("Pause and Unpause EToken trying to create and expire policies", async function () {
    const start = await helpers.time.latest();
    await currency.connect(cust).approve(pool, _A(1));

    // Pause EToken
    await etk.connect(guardian).pause();
    expect(await etk.paused()).to.be.equal(true);

    // Can't create policy because EToken is paused and can't call lockScr
    // Can call lockScr only whenNotPaused
    await expect(rm.connect(cust).newPolicy(_A(36), _A(1), _W(1 / 37), start + 3600, cust, 1)).to.be.revertedWith(
      "Pausable: paused"
    );

    // UnPause EToken
    await etk.unpause();
    expect(await etk.paused()).to.be.equal(false);

    const newPolicyEvt = await makePolicy(pool, rm, cust, _A(36), _A(1), _W(1 / 37), start + 3600, 1);
    const policy = newPolicyEvt.args.policy;

    // Pause EToken again
    await etk.connect(guardian).pause();

    // Can't expire Policy because EToken is paused and can't call unlockScr
    // Can call unlockScr only whenNotPaused
    await helpers.time.increaseTo(policy.expiration + 500n);
    await expect(pool.expirePolicy([...policy])).to.be.revertedWith("Pausable: paused");
    // UnPause EToken
    await etk.unpause();
    // Can expire Policy
    await expect(pool.expirePolicy([...policy])).not.to.be.reverted;
  });
});
