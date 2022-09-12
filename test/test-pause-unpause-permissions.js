const { expect } = require("chai");
const {
  initCurrency,
  deployPool,
  deployPremiumsAccount,
  addRiskModule,
  amountFunction,
  grantRole,
  addEToken,
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

  // Testear ETK, PolicyNFT, PolicyPool
  it("Pause, Unpause and Upgrade PolicyPool", async function () {
    const start = (await owner.provider.getBlock("latest")).timestamp;
    const expiration = start + 3600;

    // Try to pause PolicyPool
    await expect(pool.pause()).to.be.revertedWith("AccessControl:");
    expect(await pool.paused()).to.be.equal(false);

    await grantRole(hre, accessManager, "GUARDIAN_ROLE", owner.address);

    // Pause PolicyPool
    await pool.pause();
    expect(await pool.paused()).to.be.equal(true);

    await expect(pool.connect(lp).deposit(etk.address, _A(3000))).to.be.revertedWith("Pausable: paused");
    await expect(pool.connect(lp).withdraw(etk.address, _A(3000))).to.be.revertedWith("Pausable: paused");

    // UnPause PolicyPool
    await pool.unpause();
    expect(await pool.paused()).to.be.equal(false);

    // await pool.connect(lp).createPolicy(policy);
    // await expect(pool.connect(lp).newPolicy(policy)).to.be.revertedWith("Pausable: paused");

    //  eToken.deposit(eToken.address, _A(500));
  });

  it("Pause, Unpause and Upgrade EToken", async function () {
    // Try to pause EToken
    await expect(etk.pause()).to.be.revertedWith("AccessControl:");
    expect(await etk.paused()).to.be.equal(false);

    await grantRole(hre, accessManager, "GUARDIAN_ROLE", owner.address);
    expect(await etk.balanceOf(lp.address)).to.be.equal(_A(3000));

    // Pause EToken
    await etk.pause();
    expect(await etk.paused()).to.be.equal(true);

    await currency.connect(lp).approve(pool.address, _A(500));
    await expect(pool.connect(lp).deposit(etk.address, _A(500))).to.be.revertedWith("Pausable: paused");
    expect(await etk.balanceOf(lp.address)).to.be.equal(_A(3000));
    await expect(pool.connect(lp).withdraw(etk.address, _A(500))).to.be.revertedWith("Pausable: paused");
    expect(await etk.balanceOf(lp.address)).to.be.equal(_A(3000));

    // UnPause EToken
    await etk.unpause();
    expect(await etk.paused()).to.be.equal(false);

    expect(await etk.balanceOf(lp.address)).to.be.equal(_A(3000));
    await pool.connect(lp).deposit(etk.address, _A(500));
    expect(await etk.balanceOf(lp.address)).to.be.equal(_A(3500));
    await pool.connect(lp).withdraw(etk.address, _A(500));
    expect(await etk.balanceOf(lp.address)).to.be.equal(_A(3000));
  });

  it("Pause, Unpause and Upgrade PolicyNFT", async function () {
    // Try to pause PolicyNFT
    await expect(policyNFT.pause()).to.be.revertedWith("AccessControl:");
    expect(await policyNFT.paused()).to.be.equal(false);

    await grantRole(hre, accessManager, "GUARDIAN_ROLE", owner.address);
    await currency.connect(lp).approve(pool.address, _A(500));
    await pool.connect(lp).deposit(etk.address, _A(500));

    // Pause PolicyNFT
    await policyNFT.pause();
    expect(await policyNFT.paused()).to.be.equal(true);

    // UnPause PolicyNFT
    await policyNFT.unpause();
    expect(await policyNFT.paused()).to.be.equal(false);
  });
});
