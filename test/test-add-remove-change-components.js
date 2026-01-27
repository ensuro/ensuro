const { expect } = require("chai");
const { amountFunction, _W, getTransactionEvent } = require("@ensuro/utils/js/utils");
const { initCurrency } = require("@ensuro/utils/js/test-utils");
const { deployPool, deployPremiumsAccount, addRiskModule, makePolicy, addEToken } = require("../js/test-utils");
const { ComponentKind, ComponentStatus } = require("../js/enums");
const helpers = require("@nomicfoundation/hardhat-network-helpers");
const { defaultTestParams, makeFTUWInputData } = require("../js/utils");

const { MaxUint256 } = hre.ethers;

const _A = amountFunction(6);

function makeInputData({ payout, premium, lossProb, expiration, internalId, params }) {
  return makeFTUWInputData({
    payout: payout || _A(36),
    premium: premium || _A(1),
    lossProb: lossProb || _W(1 / 37),
    expiration,
    internalId: internalId || 123,
    params: defaultTestParams(params || {}),
  });
}

describe("Test add, remove and change status of PolicyPool components", function () {
  let currency;
  let pool;
  let cust, guardian, level1, lp;
  let etk;
  let rm;
  let premiumsAccount;

  beforeEach(async () => {
    [, lp, cust, guardian, level1] = await hre.ethers.getSigners();

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
  });

  it("Can't add component of kind unknown", async function () {
    const newPA = await deployPremiumsAccount(pool, {}, false);
    await expect(pool.addComponent(newPA, ComponentKind.unknown))
      .to.be.revertedWithCustomError(pool, "ComponentNotTheRightKind")
      .withArgs(newPA, ComponentKind.unknown);
  });

  it("Change status and remove eToken", async function () {
    // When active deposits are OK
    expect(await pool.getComponentStatus(etk)).to.be.equal(ComponentStatus.active);
    await currency.connect(lp).approve(pool, _A(500));
    await expect(pool.connect(lp).deposit(etk, _A(300), lp)).not.to.be.reverted;

    await expect(pool.connect(level1).changeComponentStatus(etk, ComponentStatus.deprecated)).not.to.be.reverted;
    expect(await pool.getComponentStatus(etk)).to.be.equal(ComponentStatus.deprecated);

    // When deprecated, deposits aren't allowed, but withdrawals are allowed
    await expect(pool.connect(lp).deposit(etk, _A(200), lp)).to.be.revertedWithCustomError(
      pool,
      "ComponentNotFoundOrNotActive"
    );
    await expect(pool.connect(lp).withdraw(etk, _A(200), lp, lp)).not.to.be.reverted;

    await expect(pool.connect(guardian).changeComponentStatus(etk, ComponentStatus.suspended)).not.to.be.reverted;
    expect(await pool.getComponentStatus(etk)).to.be.equal(ComponentStatus.suspended);

    // When suspended, withdrawals are not allowed
    await expect(pool.connect(lp).withdraw(etk, _A(100), lp, lp)).to.be.revertedWithCustomError(
      pool,
      "ComponentMustBeActiveOrDeprecated"
    );

    await expect(pool.connect(level1).changeComponentStatus(etk, ComponentStatus.active)).not.to.be.reverted;
    expect(await pool.getComponentStatus(etk)).to.be.equal(ComponentStatus.active);

    await expect(pool.connect(lp).deposit(etk, _A(200), lp)).not.to.be.reverted;

    await expect(pool.connect(level1).changeComponentStatus(etk, ComponentStatus.deprecated)).not.to.be.reverted;
    await expect(pool.connect(level1).removeComponent(etk))
      .to.be.revertedWithCustomError(pool, "ComponentInUseCannotRemove")
      .withArgs(ComponentKind.eToken, await etk.totalSupply());

    await expect(pool.connect(lp).withdraw(etk, MaxUint256, lp, lp)).not.to.be.reverted;

    // Reverts when newStatus is inactive (use removeComponent() instead)
    await expect(
      pool.connect(level1).changeComponentStatus(etk, ComponentStatus.inactive)
    ).to.be.revertedWithCustomError(pool, "InvalidComponentStatus");

    await expect(pool.connect(level1).removeComponent(etk)).not.to.be.reverted;
    expect(await pool.getComponentStatus(etk)).to.be.equal(ComponentStatus.inactive);

    await expect(pool.connect(level1).changeComponentStatus(etk, ComponentStatus.active)).to.be.revertedWithCustomError(
      pool,
      "ComponentNotFound"
    );

    await expect(pool.connect(lp).deposit(etk, _A(200), lp))
      .to.be.revertedWithCustomError(pool, "ComponentNotTheRightKind")
      .withArgs(etk, ComponentKind.eToken);
  });

  it("Change status and remove RiskModule", async function () {
    const start = await helpers.time.latest();
    await currency.connect(cust).approve(pool, _A(100));

    // When active newPolicies are OK
    let newPolicyEvt = await makePolicy(
      pool,
      rm.connect(cust),
      cust,
      _A(36),
      _A(1),
      _W(1 / 37),
      start + 3600,
      1,
      defaultTestParams({})
    );
    let policy = newPolicyEvt.args.policy;

    expect(await pool.getComponentStatus(rm)).to.be.equal(ComponentStatus.active);

    // Only LEVEL1 can deprecate
    await expect(pool.connect(level1).changeComponentStatus(rm, ComponentStatus.deprecated)).not.to.be.reverted;
    expect(await pool.getComponentStatus(rm)).to.be.equal(ComponentStatus.deprecated);

    // When deprecated can't create policy
    await expect(
      rm.connect(cust).newPolicy(makeInputData({ expiration: start + 3600 }), cust)
    ).to.be.revertedWithCustomError(pool, "ComponentNotFoundOrNotActive");

    // But policies can be resolved
    await expect(rm.connect(cust).resolvePolicy([...policy], _A(10))).not.to.be.reverted;

    // Reactivate RM
    await expect(pool.connect(level1).changeComponentStatus(rm, ComponentStatus.active)).not.to.be.reverted;
    expect(await pool.getComponentStatus(rm)).to.be.equal(ComponentStatus.active);

    newPolicyEvt = await makePolicy(
      pool,
      rm.connect(cust),
      cust,
      _A(36),
      _A(1),
      _W(1 / 37),
      start + 3600,
      3,
      defaultTestParams({})
    );
    policy = newPolicyEvt.args.policy;

    await expect(pool.connect(guardian).changeComponentStatus(rm, ComponentStatus.suspended)).not.to.be.reverted;
    expect(await pool.getComponentStatus(rm)).to.be.equal(ComponentStatus.suspended);

    // When suspended, policy creation / resolutions are not allowed
    await expect(rm.connect(cust).resolvePolicy([...policy], _A(10))).to.be.revertedWithCustomError(
      pool,
      "ComponentMustBeActiveOrDeprecated"
    );
    await expect(
      rm.connect(cust).newPolicy(makeInputData({ expiration: start + 3600 }), cust)
    ).to.be.revertedWithCustomError(pool, "ComponentNotFoundOrNotActive");

    // Can't be removed if not deprecated before, or if has active policies
    await expect(pool.connect(level1).removeComponent(rm)).to.be.revertedWithCustomError(
      pool,
      "ComponentNotDeprecated"
    );
    await expect(pool.connect(level1).changeComponentStatus(rm, ComponentStatus.deprecated)).not.to.be.reverted;

    // Reverts when newStatus is inactive (use removeComponent() instead)
    await expect(
      pool.connect(level1).changeComponentStatus(rm, ComponentStatus.inactive)
    ).to.be.revertedWithCustomError(pool, "InvalidComponentStatus");

    await expect(pool.connect(level1).removeComponent(rm))
      .to.be.revertedWithCustomError(pool, "ComponentInUseCannotRemove")
      .withArgs(ComponentKind.riskModule, (await pool.getExposure(rm))[0]);

    await expect(rm.connect(cust).resolvePolicy([...policy], _A(10))).not.to.be.reverted;
    await expect(pool.connect(level1).removeComponent(rm)).not.to.be.reverted;
    expect(await pool.getComponentStatus(rm)).to.be.equal(ComponentStatus.inactive);

    await expect(pool.connect(level1).changeComponentStatus(rm, ComponentStatus.active)).to.be.revertedWithCustomError(
      pool,
      "ComponentNotFound"
    );

    await expect(rm.connect(cust).newPolicy(makeInputData({ expiration: start + 3600 }), cust))
      .to.be.revertedWithCustomError(pool, "ComponentNotTheRightKind")
      .withArgs(rm, ComponentKind.riskModule);
  });

  it("Change status and remove PremiumsAccount", async function () {
    const start = await helpers.time.latest();
    await currency.connect(cust).approve(pool, _A(100));

    // When active newPolicies are OK
    let newPolicyEvt = await makePolicy(
      pool,
      rm.connect(cust),
      cust,
      _A(36),
      _A(1),
      _W(1 / 37),
      start + 3600,
      1,
      defaultTestParams({})
    );
    let policy = newPolicyEvt.args.policy;

    expect(await pool.getComponentStatus(premiumsAccount)).to.be.equal(ComponentStatus.active);

    // Only LEVEL1 can deprecate
    await expect(pool.connect(level1).changeComponentStatus(premiumsAccount, ComponentStatus.deprecated)).not.to.be
      .reverted;
    expect(await pool.getComponentStatus(premiumsAccount)).to.be.equal(ComponentStatus.deprecated);

    // When deprecated can't create policy
    await expect(
      rm.connect(cust).newPolicy(makeInputData({ expiration: start + 3600 }), cust)
    ).to.be.revertedWithCustomError(pool, "ComponentNotFoundOrNotActive");

    // But policies can be resolved
    await expect(rm.connect(cust).resolvePolicy([...policy], _A(10))).not.to.be.reverted;

    // Reactivate PA
    await expect(pool.connect(level1).changeComponentStatus(premiumsAccount, ComponentStatus.active)).not.to.be
      .reverted;
    expect(await pool.getComponentStatus(premiumsAccount)).to.be.equal(ComponentStatus.active);

    newPolicyEvt = await makePolicy(
      pool,
      rm.connect(cust),
      cust,
      _A(36),
      _A(1),
      _W(1 / 37),
      start + 3600,
      3,
      defaultTestParams({})
    );
    policy = newPolicyEvt.args.policy;

    // Only GUARDIAN can suspend
    await pool.connect(guardian).changeComponentStatus(premiumsAccount, ComponentStatus.suspended);
    expect(await pool.getComponentStatus(premiumsAccount)).to.be.equal(ComponentStatus.suspended);

    // When suspended, policy creation / resolutions are not allowed
    await expect(rm.connect(cust).resolvePolicy([...policy], _A(10))).to.be.revertedWithCustomError(
      pool,
      "ComponentMustBeActiveOrDeprecated"
    );
    await expect(
      rm.connect(cust).newPolicy(makeInputData({ expiration: start + 3600 }), cust)
    ).to.be.revertedWithCustomError(pool, "ComponentNotFoundOrNotActive");

    // Can't be removed if not deprecated before, or if has active policies
    await expect(pool.connect(level1).removeComponent(premiumsAccount)).to.be.revertedWithCustomError(
      pool,
      "ComponentNotDeprecated"
    );
    await pool.connect(level1).changeComponentStatus(premiumsAccount, ComponentStatus.deprecated);

    await expect(pool.connect(level1).removeComponent(premiumsAccount))
      .to.be.revertedWithCustomError(pool, "ComponentInUseCannotRemove")
      .withArgs(ComponentKind.premiumsAccount, await premiumsAccount.purePremiums());

    await expect(rm.connect(cust).resolvePolicy([...policy], _A(10))).not.to.be.reverted;
    let internalLoan = await etk.getLoan(premiumsAccount);
    expect(internalLoan > _A(0)).to.be.true;

    // Reverts when newStatus is inactive (use removeComponent() instead)
    await expect(
      pool.connect(level1).changeComponentStatus(premiumsAccount, ComponentStatus.inactive)
    ).to.be.revertedWithCustomError(pool, "InvalidComponentStatus");

    const tx = await pool.connect(level1).removeComponent(premiumsAccount);
    const receipt = await tx.wait();
    const borrowerRemovedEvt = getTransactionEvent(etk.interface, receipt, "InternalBorrowerRemoved");

    await expect(
      pool.connect(level1).changeComponentStatus(premiumsAccount, ComponentStatus.active)
    ).to.be.revertedWithCustomError(pool, "ComponentNotFound");

    await expect(etk.getLoan(premiumsAccount))
      .to.be.revertedWithCustomError(etk, "InvalidBorrower")
      .withArgs(premiumsAccount); // debt defaulted
    expect(borrowerRemovedEvt.args.defaultedDebt).to.be.equal(internalLoan);
    expect(await pool.getComponentStatus(premiumsAccount)).to.be.equal(ComponentStatus.inactive);

    await expect(rm.connect(cust).newPolicy(makeInputData({ expiration: start + 3600 }), cust))
      .to.be.revertedWithCustomError(pool, "ComponentNotTheRightKind")
      .withArgs(premiumsAccount, ComponentKind.premiumsAccount);
  });
});
