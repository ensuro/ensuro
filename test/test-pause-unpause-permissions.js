const { expect } = require("chai");
const { amountFunction, _W, captureAny } = require("@ensuro/utils/js/utils");
const { initCurrency } = require("@ensuro/utils/js/test-utils");
const { deployPool, deployPremiumsAccount, addRiskModule, addEToken } = require("../js/test-utils");
const { makeFTUWInputData, defaultTestParams } = require("../js/utils");
const helpers = require("@nomicfoundation/hardhat-network-helpers");

describe("Test pause, unpause and upgrade contracts", function () {
  let currency;
  let pool;
  let premiumsAccount;
  let cust, guardian, level1, lp, owner;
  let _A;
  let etk;
  let rm;
  let testPolicyInput;
  let now;

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
      treasuryAddress: "0x87c47c9a5a2aa74ae714857d64911d9a091c25b1", // Random address
    });
    pool._A = _A;

    etk = await addEToken(pool, {});

    premiumsAccount = await deployPremiumsAccount(pool, { srEtk: etk });
    rm = await addRiskModule(pool, premiumsAccount, {});

    await currency.connect(lp).approve(pool, _A(3000));
    await pool.connect(lp).deposit(etk, _A(3000), lp);
    now = await helpers.time.latest();
    testPolicyInput = makeFTUWInputData({
      payout: _A(36),
      premium: _A(1),
      lossProb: _W(1 / 37),
      expiration: now + 3600,
      internalId: 123,
      params: defaultTestParams({}),
    });
  });

  it("Pause and Unpause PolicyPool", async function () {
    expect(await pool.paused()).to.be.equal(false);
    await currency.connect(cust).approve(pool, _A(100));

    // Pause PolicyPool
    await pool.connect(guardian).pause();
    expect(await pool.paused()).to.be.equal(true);

    await expect(pool.connect(lp).deposit(etk, _A(3000), lp)).to.be.revertedWithCustomError(pool, "EnforcedPause");
    await expect(pool.connect(lp).withdraw(etk, _A(3000), lp, lp)).to.be.revertedWithCustomError(pool, "EnforcedPause");

    // Can't create policy
    await expect(rm.connect(cust).newPolicy(testPolicyInput, cust)).to.be.revertedWithCustomError(
      pool,
      "EnforcedPause"
    );

    // UnPause PolicyPool
    await pool.connect(level1).unpause();
    expect(await pool.paused()).to.be.equal(false);

    await currency.connect(lp).approve(pool, _A(500));
    await pool.connect(lp).deposit(etk, _A(500), lp);
    expect(await etk.balanceOf(lp)).to.be.equal(_A(3500));
    await pool.connect(lp).withdraw(etk, _A(200), lp, lp);
    expect(await etk.balanceOf(lp)).to.be.equal(_A(3300));

    // Can create policy
    await expect(rm.connect(cust).newPolicy(testPolicyInput, cust))
      .to.emit(pool, "NewPolicy")
      .withArgs(rm, captureAny.value);
    const policy = captureAny.lastValue;

    // Pause PolicyPool again
    await pool.connect(guardian).pause();
    // Can't resolve Policy
    await expect(rm.connect(cust).resolvePolicy([...policy], _A(10))).to.be.revertedWithCustomError(
      pool,
      "EnforcedPause"
    );
    // Can't transfer NFTs
    await expect(pool.connect(cust).transferFrom(cust, owner, policy.id)).to.be.revertedWithCustomError(
      pool,
      "EnforcedPause"
    );

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
    await currency.connect(cust).approve(pool, _A(100));

    // Pause PolicyPool
    await pool.connect(guardian).pause();
    expect(await pool.paused()).to.be.equal(true);

    // Can't create policy
    await expect(rm.connect(cust).newPolicy(testPolicyInput, cust)).to.be.revertedWithCustomError(
      pool,
      "EnforcedPause"
    );

    // UnPause PolicyPool
    await pool.connect(level1).unpause();
    expect(await pool.paused()).to.be.equal(false);

    // Can create policy
    await expect(rm.connect(cust).newPolicy(testPolicyInput, cust))
      .to.emit(pool, "NewPolicy")
      .withArgs(rm, captureAny.value);

    const policy = captureAny.lastValue;

    // Pause PolicyPool again
    await pool.connect(guardian).pause();
    // Can't resolve Policy
    await expect(rm.connect(cust).resolvePolicy([...policy], policy.payout)).to.be.revertedWithCustomError(
      pool,
      "EnforcedPause"
    );
    // UnPause PolicyPool
    await pool.connect(guardian).unpause();
    // Can resolve Policy
    await expect(rm.connect(cust).resolvePolicy([...policy], policy.payout)).not.to.be.reverted;
  });

  it("Pause/Unpause and expire policy", async function () {
    await currency.connect(cust).approve(pool, _A(100));

    // Pause PolicyPool
    await pool.connect(guardian).pause();
    expect(await pool.paused()).to.be.equal(true);

    // Can't create policy
    await expect(rm.connect(cust).newPolicy(testPolicyInput, cust)).to.be.revertedWithCustomError(
      pool,
      "EnforcedPause"
    );

    // UnPause PolicyPool
    await pool.connect(guardian).unpause();
    expect(await pool.paused()).to.be.equal(false);

    // Can create policy
    await expect(rm.connect(cust).newPolicy(testPolicyInput, cust))
      .to.emit(pool, "NewPolicy")
      .withArgs(rm, captureAny.value);
    const policy = captureAny.lastValue;

    // Pause PolicyPool again
    await pool.connect(guardian).pause();
    // Can't expire Policy
    await expect(pool.expirePolicy([...policy])).to.be.revertedWithCustomError(pool, "EnforcedPause");
    // UnPause PolicyPool
    await pool.connect(level1).unpause();
    // Can expire Policy
    await helpers.time.increaseTo(policy.expiration + 500n);
    await pool.expirePolicy([...policy]);
  });
});
