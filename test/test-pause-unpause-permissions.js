const { expect } = require("chai");
const {
  initCurrency,
  deployPool,
  deployPremiumsAccount,
  addRiskModule,
  amountFunction,
  grantComponentRole,
  grantRole,
  makePolicy,
  blockchainNow,
  addEToken,
  _W,
} = require("./test-utils");
const helpers = require("@nomicfoundation/hardhat-network-helpers");

describe("Test pause, unpause and upgrade contracts", function () {
  let currency;
  let pool;
  let premiumsAccount;
  let TrustfulRiskModule;
  let owner, lp, cust, guardian;
  let _A;
  let etk;
  let accessManager;
  let policyNFT;
  let rm;

  beforeEach(async () => {
    [owner, lp, cust, guardian] = await ethers.getSigners();

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

    // Roles to create and resolve policies
    await grantComponentRole(hre, accessManager, rm, "PRICER_ROLE", cust.address);
    await grantComponentRole(hre, accessManager, rm, "RESOLVER_ROLE", cust.address);

    await currency.connect(lp).approve(pool.address, _A(3000));
    await pool.connect(lp).deposit(etk.address, _A(3000));
  });

  it("Pause and Unpause PolicyPool", async function () {
    const start = await blockchainNow(owner);

    // Try to pause PolicyPool without permissions
    await expect(pool.pause()).to.be.revertedWith("AccessControl:");
    expect(await pool.paused()).to.be.equal(false);
    await currency.connect(cust).approve(pool.address, _A(100));

    // Pause PolicyPool
    await pool.connect(guardian).pause();
    expect(await pool.paused()).to.be.equal(true);

    await expect(pool.connect(lp).deposit(etk.address, _A(3000))).to.be.revertedWith("Pausable: paused");
    await expect(pool.connect(lp).withdraw(etk.address, _A(3000))).to.be.revertedWith("Pausable: paused");

    // Can't create policy
    await expect(
      rm.connect(cust).newPolicy(_A(36), _A(1), _W(1 / 37), start + 3600, cust.address, 1)
    ).to.be.revertedWith("Pausable: paused");

    // UnPause PolicyPool
    await pool.unpause();
    expect(await pool.paused()).to.be.equal(false);

    await currency.connect(lp).approve(pool.address, _A(500));
    await pool.connect(lp).deposit(etk.address, _A(500));
    expect(await etk.balanceOf(lp.address)).to.be.equal(_A(3500));
    await pool.connect(lp).withdraw(etk.address, _A(200));
    expect(await etk.balanceOf(lp.address)).to.be.equal(_A(3300));

    // Can create policy
    const newPolicyEvt = await makePolicy(pool, rm, cust, _A(36), _A(1), _W(1 / 37), start + 3600, 1);
    const policy = newPolicyEvt.args.policy;

    // Pause PolicyPool again
    await pool.connect(guardian).pause();
    // Can't resolve Policy
    await expect(rm.connect(cust).resolvePolicy(policy, _A(10))).to.be.revertedWith("Pausable: paused");
    // UnPause PolicyPool
    await pool.unpause();
    // Can resolve Policy
    await expect(rm.connect(cust).resolvePolicy(policy, _A(10))).not.to.be.reverted;
  });

  it("Pause/Unpause and resolve policy with full payout", async function () {
    const start = await blockchainNow(owner);

    await currency.connect(cust).approve(pool.address, _A(100));

    // Pause PolicyPool
    await pool.connect(guardian).pause();
    expect(await pool.paused()).to.be.equal(true);

    // Can't create policy
    await expect(
      rm.connect(cust).newPolicy(_A(36), _A(1), _W(1 / 37), start + 3600, cust.address, 1)
    ).to.be.revertedWith("Pausable: paused");

    // UnPause PolicyPool
    await pool.unpause();
    expect(await pool.paused()).to.be.equal(false);

    // Can create policy
    const newPolicyEvt = await makePolicy(pool, rm, cust, _A(36), _A(1), _W(1 / 37), start + 3600, 1);
    const policy = newPolicyEvt.args.policy;

    // Pause PolicyPool again
    await pool.connect(guardian).pause();
    // Can't resolve Policy
    await expect(rm.connect(cust).resolvePolicyFullPayout(policy, true)).to.be.revertedWith("Pausable: paused");
    // UnPause PolicyPool
    await pool.unpause();
    // Can resolve Policy
    await expect(rm.connect(cust).resolvePolicyFullPayout(policy, true)).not.to.be.reverted;
  });

  it("Pause/Unpause and expire policy", async function () {
    const start = await blockchainNow(owner);

    await currency.connect(cust).approve(pool.address, _A(100));

    // Pause PolicyPool
    await pool.connect(guardian).pause();
    expect(await pool.paused()).to.be.equal(true);

    // Can't create policy
    await expect(
      rm.connect(cust).newPolicy(_A(36), _A(1), _W(1 / 37), start + 3600, cust.address, 1)
    ).to.be.revertedWith("Pausable: paused");

    // UnPause PolicyPool
    await pool.unpause();
    expect(await pool.paused()).to.be.equal(false);

    // Can create policy
    const newPolicyEvt = await makePolicy(pool, rm, cust, _A(36), _A(1), _W(1 / 37), start + 3600, 1);
    const policy = newPolicyEvt.args.policy;

    // Pause PolicyPool again
    await pool.connect(guardian).pause();
    // Can't expire Policy
    await expect(pool.expirePolicy(policy)).to.be.revertedWith("Pausable: paused");
    // UnPause PolicyPool
    await pool.unpause();
    // Can expire Policy
    await helpers.time.increaseTo(policy.expiration + 500);
    await pool.expirePolicy(policy);
  });

  it("Pause and Unpause EToken", async function () {
    // Try to pause EToken  without permissions
    await expect(etk.pause()).to.be.revertedWith("AccessControl:");
    expect(await etk.paused()).to.be.equal(false);
    expect(await etk.balanceOf(lp.address)).to.be.equal(_A(3000));
    expect(await etk.balanceOf(cust.address)).to.be.equal(_A(0));
    // Pause EToken
    await etk.connect(guardian).pause();
    expect(await etk.paused()).to.be.equal(true);

    await currency.connect(lp).approve(pool.address, _A(500));
    await expect(pool.connect(lp).deposit(etk.address, _A(500))).to.be.revertedWith("Pausable: paused");
    await expect(pool.connect(lp).withdraw(etk.address, _A(500))).to.be.revertedWith("Pausable: paused");
    await expect(etk.connect(lp).transfer(cust.address, _A(500))).to.be.revertedWith("Pausable: paused");

    // UnPause EToken
    await etk.unpause();
    expect(await etk.paused()).to.be.equal(false);

    await expect(pool.connect(lp).deposit(etk.address, _A(500))).not.to.be.reverted;
    await expect(pool.connect(lp).withdraw(etk.address, _A(500))).not.to.be.reverted;

    await etk.connect(lp).transfer(cust.address, _A(500));
    expect(await etk.balanceOf(lp.address)).to.be.equal(_A(2500));
    expect(await etk.balanceOf(cust.address)).to.be.equal(_A(500));
  });

  it("Pause and Unpause PolicyNFT", async function () {
    const start = await blockchainNow(owner);

    // Try to pause PolicyNFT without permissions
    await expect(policyNFT.pause()).to.be.revertedWith("AccessControl:");
    expect(await policyNFT.paused()).to.be.equal(false);

    await currency.connect(cust).approve(pool.address, _A(1));
    await currency.connect(lp).approve(pool.address, _A(500));
    await pool.connect(lp).deposit(etk.address, _A(500));

    // Pause PolicyNFT
    await policyNFT.connect(guardian).pause();
    expect(await policyNFT.paused()).to.be.equal(true);

    // Can't create policy
    await expect(
      rm.connect(cust).newPolicy(_A(36), _A(1), _W(1 / 37), start + 3600, cust.address, 1)
    ).to.be.revertedWith("Pausable: paused");

    // UnPause PolicyNFT
    await policyNFT.unpause();
    expect(await policyNFT.paused()).to.be.equal(false);

    // Can create policy
    const newPolicyEvt = await makePolicy(pool, rm, cust, _A(36), _A(1), _W(1 / 37), start + 3600, 1);
    const policy = newPolicyEvt.args.policy;

    await policyNFT.connect(guardian).pause();
    await expect(policyNFT.connect(cust).transferFrom(cust.address, owner.address, policy.id)).to.be.revertedWith(
      "Pausable: paused"
    );

    await policyNFT.unpause();
    expect(await policyNFT.ownerOf(policy.id)).to.be.equal(cust.address);
    await policyNFT.connect(cust).transferFrom(cust.address, owner.address, policy.id);
    expect(await policyNFT.ownerOf(policy.id)).to.be.equal(owner.address);
  });

  it("Pause and Unpause RiskModule resolve policy", async function () {
    const start = await blockchainNow(owner);

    // Try to pause RiskModule  without permissions
    await expect(rm.pause()).to.be.revertedWith("AccessControl:");
    expect(await rm.paused()).to.be.equal(false);

    await currency.connect(cust).approve(pool.address, _A(1));

    const newPolicyEvt = await makePolicy(pool, rm, cust, _A(36), _A(1), _W(1 / 37), start + 3600, 1);
    const policy = newPolicyEvt.args.policy;

    // Pause RiskModule
    await rm.connect(guardian).pause();
    expect(await rm.paused()).to.be.equal(true);
    await expect(rm.connect(cust).resolvePolicy(policy, _A(10))).to.be.revertedWith("Pausable: paused");
    // UnPause RiskModule
    await rm.unpause();
    expect(await rm.paused()).to.be.equal(false);

    // Can resolve Policy
    await expect(rm.connect(cust).resolvePolicy(policy, _A(10))).not.to.be.reverted;
  });

  it("Pause and Unpause RiskModule resolve policy full payout", async function () {
    const start = await blockchainNow(owner);

    // Try to pause RiskModule  without permissions
    await expect(rm.pause()).to.be.revertedWith("AccessControl:");
    expect(await rm.paused()).to.be.equal(false);

    await currency.connect(cust).approve(pool.address, _A(1));

    const newPolicyEvt = await makePolicy(pool, rm, cust, _A(36), _A(1), _W(1 / 37), start + 3600, 1);
    const policy = newPolicyEvt.args.policy;

    // Pause RiskModule
    await rm.connect(guardian).pause();
    expect(await rm.paused()).to.be.equal(true);
    await expect(rm.connect(cust).resolvePolicyFullPayout(policy, true)).to.be.revertedWith("Pausable: paused");

    // UnPause RiskModule
    await rm.unpause();
    expect(await rm.paused()).to.be.equal(false);

    // Can resolve Policy
    await expect(rm.connect(cust).resolvePolicyFullPayout(policy, true)).not.to.be.reverted;
  });

  it("Pause and Unpause PremiumsAccount policyExpired", async function () {
    const start = await blockchainNow(owner);

    // Try to pause PremiumsAccount  without permissions
    await expect(premiumsAccount.pause()).to.be.revertedWith("AccessControl:");
    expect(await premiumsAccount.paused()).to.be.equal(false);

    await currency.connect(cust).approve(pool.address, _A(1));

    // Pause PremiumsAccount
    await premiumsAccount.connect(guardian).pause();
    expect(await premiumsAccount.paused()).to.be.equal(true);

    // Can't create policy
    await expect(
      rm.connect(cust).newPolicy(_A(36), _A(1), _W(1 / 37), start + 3600, cust.address, 1)
    ).to.be.revertedWith("Pausable: paused");

    // UnPause PremiumsAccount
    await premiumsAccount.unpause();
    expect(await premiumsAccount.paused()).to.be.equal(false);

    const newPolicyEvt = await makePolicy(pool, rm, cust, _A(36), _A(1), _W(1 / 37), start + 3600, 1);
    const policy = newPolicyEvt.args.policy;

    // Pause PremiumsAccount again
    await premiumsAccount.connect(guardian).pause();
    // Can't expire Policy
    await helpers.time.increaseTo(policy.expiration + 500);
    await expect(pool.expirePolicy(policy)).to.be.revertedWith("Pausable: paused");
    // UnPause PremiumsAccount
    await premiumsAccount.unpause();
    // Can expire Policy
    await expect(pool.expirePolicy(policy)).not.to.be.reverted;
  });

  it("Pause and Unpause PremiumsAccount policyResolvedWithPayout", async function () {
    const start = await blockchainNow(owner);

    // Try to pause PremiumsAccount  without permissions
    await expect(premiumsAccount.pause()).to.be.revertedWith("AccessControl:");
    expect(await premiumsAccount.paused()).to.be.equal(false);

    await currency.connect(cust).approve(pool.address, _A(1));

    // Pause PremiumsAccount
    await premiumsAccount.connect(guardian).pause();
    expect(await premiumsAccount.paused()).to.be.equal(true);

    // Can't create policy
    await expect(
      rm.connect(cust).newPolicy(_A(36), _A(1), _W(1 / 37), start + 3600, cust.address, 1)
    ).to.be.revertedWith("Pausable: paused");

    // UnPause PremiumsAccount
    await premiumsAccount.unpause();
    expect(await premiumsAccount.paused()).to.be.equal(false);

    const newPolicyEvt = await makePolicy(pool, rm, cust, _A(36), _A(1), _W(1 / 37), start + 3600, 1);
    const policy = newPolicyEvt.args.policy;

    // Pause PremiumsAccount again
    await premiumsAccount.connect(guardian).pause();

    // Can't resolve Policy
    await expect(rm.connect(cust).resolvePolicy(policy, _A(10))).to.be.revertedWith("Pausable: paused");
    // UnPause PolicyPool
    await premiumsAccount.unpause();
    // Can resolve Policy
    await expect(rm.connect(cust).resolvePolicy(policy, _A(10))).not.to.be.reverted;
  });
});
