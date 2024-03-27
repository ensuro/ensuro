const { expect } = require("chai");
const {
  amountFunction,
  _W,
  grantComponentRole,
  grantRole,
  getTransactionEvent,
  accessControlMessage,
} = require("../js/utils");
const {
  initCurrency,
  deployPool,
  deployPremiumsAccount,
  addRiskModule,
  makePolicy,
  addEToken,
} = require("../js/test-utils");
const { ComponentKind, ComponentStatus } = require("../js/enums");
const helpers = require("@nomicfoundation/hardhat-network-helpers");

const { MaxUint256 } = hre.ethers;

describe("Test add, remove and change status of PolicyPool components", function () {
  let currency;
  let pool;
  let premiumsAccount;
  let TrustfulRiskModule;
  let cust, guardian, johndoe, level1, lp;
  let _A;
  let etk;
  let accessManager;
  let rm;

  beforeEach(async () => {
    [, lp, cust, guardian, level1, johndoe] = await hre.ethers.getSigners();

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

  it("Change status and remove eToken", async function () {
    // When active deposits are OK
    expect(await pool.getComponentStatus(etk)).to.be.equal(ComponentStatus.active);
    await currency.connect(lp).approve(pool, _A(500));
    await expect(pool.connect(lp).deposit(etk, _A(300))).not.to.be.reverted;

    // Only LEVEL1 can deprecate
    await expect(pool.connect(johndoe).changeComponentStatus(etk, ComponentStatus.deprecated)).to.be.revertedWith(
      accessControlMessage(johndoe, null, "LEVEL1_ROLE")
    );
    await expect(pool.connect(guardian).changeComponentStatus(etk, ComponentStatus.deprecated)).to.be.revertedWith(
      accessControlMessage(guardian, null, "LEVEL1_ROLE")
    );
    await expect(pool.connect(level1).changeComponentStatus(etk, ComponentStatus.deprecated)).not.to.be.reverted;
    expect(await pool.getComponentStatus(etk)).to.be.equal(ComponentStatus.deprecated);

    // When deprecated, deposits aren't allowed, but withdrawals are allowed
    await expect(pool.connect(lp).deposit(etk, _A(200))).to.be.revertedWithCustomError(
      pool,
      "ComponentNotFoundOrNotActive"
    );
    await expect(pool.connect(lp).withdraw(etk, _A(200))).not.to.be.reverted;

    // Only GUARDIAN can suspend
    await expect(pool.connect(level1).changeComponentStatus(etk, ComponentStatus.suspended)).to.be.revertedWith(
      accessControlMessage(level1, null, "GUARDIAN_ROLE")
    );
    await expect(pool.connect(guardian).changeComponentStatus(etk, ComponentStatus.suspended)).not.to.be.reverted;
    expect(await pool.getComponentStatus(etk)).to.be.equal(ComponentStatus.suspended);

    // When suspended, withdrawals are not allowed
    await expect(pool.connect(lp).withdraw(etk, _A(100))).to.be.revertedWithCustomError(
      pool,
      "ComponentMustBeActiveOrDeprecated"
    );

    // Only LEVEL1 can reactivate
    await expect(pool.connect(guardian).changeComponentStatus(etk, ComponentStatus.active)).to.be.revertedWith(
      accessControlMessage(guardian, null, "LEVEL1_ROLE")
    );
    await expect(pool.connect(level1).changeComponentStatus(etk, ComponentStatus.active)).not.to.be.reverted;
    expect(await pool.getComponentStatus(etk)).to.be.equal(ComponentStatus.active);

    await expect(pool.connect(lp).deposit(etk, _A(200))).not.to.be.reverted;

    await expect(pool.connect(level1).changeComponentStatus(etk, ComponentStatus.deprecated)).not.to.be.reverted;
    await expect(pool.connect(level1).removeComponent(etk))
      .to.be.revertedWithCustomError(pool, "ComponentInUseCannotRemove")
      .withArgs(ComponentKind.eToken, await etk.totalSupply());

    await expect(pool.connect(lp).withdraw(etk, MaxUint256)).not.to.be.reverted;

    await expect(pool.connect(guardian).removeComponent(etk)).to.be.revertedWith(
      accessControlMessage(guardian, null, "LEVEL1_ROLE") // Only LEVEL1 can remove
    );

    await expect(pool.connect(level1).removeComponent(etk)).not.to.be.reverted;
    expect(await pool.getComponentStatus(etk)).to.be.equal(ComponentStatus.inactive);

    await expect(pool.connect(lp).deposit(etk, _A(200)))
      .to.be.revertedWithCustomError(pool, "ComponentNotTheRightKind")
      .withArgs(etk, ComponentKind.eToken);
  });

  it("Change status and remove RiskModule", async function () {
    const start = await helpers.time.latest();
    await currency.connect(cust).approve(pool, _A(100));

    // When active newPolicies are OK
    let newPolicyEvt = await makePolicy(pool, rm, cust, _A(36), _A(1), _W(1 / 37), start + 3600, 1, "newPolicyFull");
    let policy = newPolicyEvt.args.policy;

    expect(await pool.getComponentStatus(rm)).to.be.equal(ComponentStatus.active);

    // Only LEVEL1 can deprecate
    await expect(pool.connect(level1).changeComponentStatus(rm, ComponentStatus.deprecated)).not.to.be.reverted;
    expect(await pool.getComponentStatus(rm)).to.be.equal(ComponentStatus.deprecated);

    // When deprecated can't create policy
    rm.connect(cust).newPolicy(_A(36), _A(1), _W(1 / 37), start + 3600, cust, 2);
    await expect(
      rm.connect(cust).newPolicy(_A(36), _A(1), _W(1 / 37), start + 3600, cust, 2)
    ).to.be.revertedWithCustomError(pool, "ComponentNotFoundOrNotActive");

    // But policies can be resolved
    await expect(rm.connect(cust).resolvePolicy([...policy], _A(10))).not.to.be.reverted;

    // Reactivate RM
    await expect(pool.connect(level1).changeComponentStatus(rm, ComponentStatus.active)).not.to.be.reverted;
    expect(await pool.getComponentStatus(rm)).to.be.equal(ComponentStatus.active);

    newPolicyEvt = await makePolicy(pool, rm, cust, _A(36), _A(1), _W(1 / 37), start + 3600, 3);
    policy = newPolicyEvt.args.policy;

    // Only GUARDIAN can suspend
    await expect(pool.connect(level1).changeComponentStatus(rm, ComponentStatus.suspended)).to.be.revertedWith(
      accessControlMessage(level1, null, "GUARDIAN_ROLE")
    );
    await expect(pool.connect(guardian).changeComponentStatus(rm, ComponentStatus.suspended)).not.to.be.reverted;
    expect(await pool.getComponentStatus(rm)).to.be.equal(ComponentStatus.suspended);

    // When suspended, policy creation / resolutions are not allowed
    await expect(rm.connect(cust).resolvePolicy([...policy], _A(10))).to.be.revertedWithCustomError(
      pool,
      "ComponentMustBeActiveOrDeprecated"
    );
    await expect(
      rm.connect(cust).newPolicy(_A(36), _A(1), _W(1 / 37), start + 3600, cust, 4)
    ).to.be.revertedWithCustomError(pool, "ComponentNotFoundOrNotActive");

    // Can't be removed if not deprecated before, or if has active policies
    await expect(pool.connect(level1).removeComponent(rm)).to.be.revertedWithCustomError(
      pool,
      "ComponentNotDeprecated"
    );
    await expect(pool.connect(level1).changeComponentStatus(rm, ComponentStatus.deprecated)).not.to.be.reverted;

    await expect(pool.connect(level1).removeComponent(rm))
      .to.be.revertedWithCustomError(pool, "ComponentInUseCannotRemove")
      .withArgs(ComponentKind.riskModule, await rm.activeExposure());

    await expect(rm.connect(cust).resolvePolicy([...policy], _A(10))).not.to.be.reverted;
    await expect(pool.connect(level1).removeComponent(rm)).not.to.be.reverted;
    expect(await pool.getComponentStatus(rm)).to.be.equal(ComponentStatus.inactive);

    await expect(rm.connect(cust).newPolicy(_A(36), _A(1), _W(1 / 37), start + 3600, cust, 5))
      .to.be.revertedWithCustomError(pool, "ComponentNotTheRightKind")
      .withArgs(rm, ComponentKind.riskModule);
  });

  it("Change status and remove PremiumsAccount", async function () {
    const start = await helpers.time.latest();
    await currency.connect(cust).approve(pool, _A(100));

    // When active newPolicies are OK
    let newPolicyEvt = await makePolicy(pool, rm, cust, _A(36), _A(1), _W(1 / 37), start + 3600, 1);
    let policy = newPolicyEvt.args.policy;

    expect(await pool.getComponentStatus(premiumsAccount)).to.be.equal(ComponentStatus.active);

    // Only LEVEL1 can deprecate
    await expect(pool.connect(level1).changeComponentStatus(premiumsAccount, ComponentStatus.deprecated)).not.to.be
      .reverted;
    expect(await pool.getComponentStatus(premiumsAccount)).to.be.equal(ComponentStatus.deprecated);

    // When deprecated can't create policy
    await expect(
      rm.connect(cust).newPolicy(_A(36), _A(1), _W(1 / 37), start + 3600, cust, 2)
    ).to.be.revertedWithCustomError(pool, "ComponentNotFoundOrNotActive");

    // But policies can be resolved
    await expect(rm.connect(cust).resolvePolicy([...policy], _A(10))).not.to.be.reverted;

    // Reactivate PA
    await expect(pool.connect(level1).changeComponentStatus(premiumsAccount, ComponentStatus.active)).not.to.be
      .reverted;
    expect(await pool.getComponentStatus(premiumsAccount)).to.be.equal(ComponentStatus.active);

    newPolicyEvt = await makePolicy(pool, rm, cust, _A(36), _A(1), _W(1 / 37), start + 3600, 3);
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
      rm.connect(cust).newPolicy(_A(36), _A(1), _W(1 / 37), start + 3600, cust, 4)
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
    const tx = await pool.connect(level1).removeComponent(premiumsAccount);
    const receipt = await tx.wait();
    const borrowerRemovedEvt = getTransactionEvent(etk.interface, receipt, "InternalBorrowerRemoved");

    expect(await etk.getLoan(premiumsAccount)).to.be.equal(_A(0)); // debt defaulted
    expect(borrowerRemovedEvt.args.defaultedDebt).to.be.equal(internalLoan);
    expect(await pool.getComponentStatus(premiumsAccount)).to.be.equal(ComponentStatus.inactive);

    await expect(rm.connect(cust).newPolicy(_A(36), _A(1), _W(1 / 37), start + 3600, cust, 5))
      .to.be.revertedWithCustomError(pool, "ComponentNotTheRightKind")
      .withArgs(premiumsAccount, ComponentKind.premiumsAccount);
  });
});
