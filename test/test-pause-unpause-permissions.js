const { expect } = require("chai");
const {
  initCurrency,
  deployPool,
  deployPremiumsAccount,
  addRiskModule,
  amountFunction,
  grantComponentRole,
  grantRole,
  addEToken,
  getTransactionEvent,
} = require("./test-utils");

describe("Test pause, unpause and upgrade contracts", function () {
  let currency;
  let pool;
  let premiumsAccount;
  let TrustfulRiskModule;
  let owner, lp, cust;
  let _A;
  let etk;
  let accessManager;
  let policyNFT;

  beforeEach(async () => {
    [owner, lp, cust] = await ethers.getSigners();

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

    await currency.connect(lp).approve(pool.address, _A(3000));
    await pool.connect(lp).deposit(etk.address, _A(3000));
  });

  it("Pause and Unpause PolicyPool", async function () {
    const rm = await addRiskModule(pool, premiumsAccount, TrustfulRiskModule, {});
    const start = (await owner.provider.getBlock("latest")).timestamp;

    // Try to pause PolicyPool without permissions
    await expect(pool.pause()).to.be.revertedWith("AccessControl:");
    expect(await pool.paused()).to.be.equal(false);

    await currency.connect(cust).approve(pool.address, _A(100));
    await grantRole(hre, accessManager, "GUARDIAN_ROLE", owner.address);
    await grantComponentRole(hre, accessManager, rm, "PRICER_ROLE", cust.address);
    await grantComponentRole(hre, accessManager, rm, "RESOLVER_ROLE", cust.address);

    // Pause PolicyPool
    await pool.pause();
    expect(await pool.paused()).to.be.equal(true);

    await expect(pool.connect(lp).deposit(etk.address, _A(3000))).to.be.revertedWith("Pausable: paused");
    await expect(pool.connect(lp).withdraw(etk.address, _A(3000))).to.be.revertedWith("Pausable: paused");

    // Can't create policy
    await expect(
      rm.connect(cust).newPolicy(_A(36), _A(1), _A(1 / 37), start + 3600, cust.address, 1)
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
    let tx = await rm.connect(cust).newPolicy(_A(36), _A(1), _A(1 / 37), start + 3600, cust.address, 1);
    let receipt = await tx.wait();
    const newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");
    const policy = newPolicyEvt.args.policy;

    // Pause PolicyPool again
    await pool.pause();
    // Can't resolve Policy
    await expect(rm.connect(cust).resolvePolicy(policy, _A(10))).to.be.revertedWith("Pausable: paused");
    // UnPause PolicyPool
    await pool.unpause();
    // Can resolve Policy
    await expect(rm.connect(cust).resolvePolicy(policy, _A(10))).not.to.be.reverted;
  });

  it("Pause/Unpause and resolve policy with full payout", async function () {
    const rm = await addRiskModule(pool, premiumsAccount, TrustfulRiskModule, {});
    const start = (await owner.provider.getBlock("latest")).timestamp;

    await currency.connect(cust).approve(pool.address, _A(100));
    await grantRole(hre, accessManager, "GUARDIAN_ROLE", owner.address);
    await grantComponentRole(hre, accessManager, rm, "PRICER_ROLE", cust.address);
    await grantComponentRole(hre, accessManager, rm, "RESOLVER_ROLE", cust.address);

    // Pause PolicyPool
    await pool.pause();
    expect(await pool.paused()).to.be.equal(true);

    // Can't create policy
    await expect(
      rm.connect(cust).newPolicy(_A(36), _A(1), _A(1 / 37), start + 3600, cust.address, 1)
    ).to.be.revertedWith("Pausable: paused");

    // UnPause PolicyPool
    await pool.unpause();
    expect(await pool.paused()).to.be.equal(false);

    // Can create policy
    let tx = await rm.connect(cust).newPolicy(_A(36), _A(1), _A(1 / 37), start + 3600, cust.address, 1);
    let receipt = await tx.wait();
    const newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");
    const policy = newPolicyEvt.args.policy;

    // Pause PolicyPool again
    await pool.pause();
    // Can't resolve Policy
    await expect(rm.connect(cust).resolvePolicyFullPayout(policy, true)).to.be.revertedWith("Pausable: paused");
    // UnPause PolicyPool
    await pool.unpause();
    // Can resolve Policy
    await expect(rm.connect(cust).resolvePolicyFullPayout(policy, true)).not.to.be.reverted;
  });

  it("Pause and Unpause EToken", async function () {
    // Try to pause EToken  without permissions
    await expect(etk.pause()).to.be.revertedWith("AccessControl:");
    expect(await etk.paused()).to.be.equal(false);

    await grantRole(hre, accessManager, "GUARDIAN_ROLE", owner.address);

    // Pause EToken
    await etk.pause();
    expect(await etk.paused()).to.be.equal(true);

    await currency.connect(lp).approve(pool.address, _A(500));
    await expect(pool.connect(lp).deposit(etk.address, _A(500))).to.be.revertedWith("Pausable: paused");
    await expect(pool.connect(lp).withdraw(etk.address, _A(500))).to.be.revertedWith("Pausable: paused");

    // UnPause EToken
    await etk.unpause();
    expect(await etk.paused()).to.be.equal(false);

    await expect(pool.connect(lp).deposit(etk.address, _A(500))).not.to.be.reverted;
    await expect(pool.connect(lp).withdraw(etk.address, _A(500))).not.to.be.reverted;
  });

  it("Pause and Unpause PolicyNFT", async function () {
    const rm = await addRiskModule(pool, premiumsAccount, TrustfulRiskModule, {});
    const start = (await owner.provider.getBlock("latest")).timestamp;

    // Try to pause PolicyNFT without permissions
    await expect(policyNFT.pause()).to.be.revertedWith("AccessControl:");
    expect(await policyNFT.paused()).to.be.equal(false);

    await currency.connect(cust).approve(pool.address, _A(1));
    await grantRole(hre, accessManager, "GUARDIAN_ROLE", owner.address);
    await grantComponentRole(hre, accessManager, rm, "PRICER_ROLE", cust.address);
    await currency.connect(lp).approve(pool.address, _A(500));
    await pool.connect(lp).deposit(etk.address, _A(500));

    // Pause PolicyNFT
    await policyNFT.pause();
    expect(await policyNFT.paused()).to.be.equal(true);

    // Can't create policy
    await expect(
      rm.connect(cust).newPolicy(_A(36), _A(1), _A(1 / 37), start + 3600, cust.address, 1)
    ).to.be.revertedWith("Pausable: paused");

    // UnPause PolicyNFT
    await policyNFT.unpause();
    expect(await policyNFT.paused()).to.be.equal(false);

    // Can create policy
    await expect(rm.connect(cust).newPolicy(_A(36), _A(1), _A(1 / 37), start + 3600, cust.address, 1)).not.to.be
      .reverted;
  });
});
