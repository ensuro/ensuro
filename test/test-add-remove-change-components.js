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

  const ST_INACTIVE = 0;
  const ST_ACTIVE = 1;
  const ST_DEPRECATED = 2;
  const ST_SUSPENDED = 3;

  beforeEach(async () => {
    [, lp, cust, guardian, level1, johndoe] = await hre.ethers.getSigners();

    _A = amountFunction(6);

    currency = await initCurrency(
      { name: "Test USDC", symbol: "USDC", decimals: 6, initial_supply: _A(10000) },
      [lp, cust],
      [_A(5000), _A(500)]
    );

    pool = await deployPool({
      currency: currency.target,
      grantRoles: [],
      treasuryAddress: "0x87c47c9a5a2aa74ae714857d64911d9a091c25b1", // Random address
    });
    pool._A = _A;

    etk = await addEToken(pool, {});

    premiumsAccount = await deployPremiumsAccount(pool, { srEtkAddr: etk.target });
    accessManager = await hre.ethers.getContractAt("AccessManager", await pool.access());
    TrustfulRiskModule = await hre.ethers.getContractFactory("TrustfulRiskModule");
    rm = await addRiskModule(pool, premiumsAccount, TrustfulRiskModule, {});

    await grantRole(hre, accessManager, "GUARDIAN_ROLE", guardian.address);
    await grantRole(hre, accessManager, "LEVEL1_ROLE", level1.address);

    // Roles to create and resolve policies
    await grantComponentRole(hre, accessManager, rm, "PRICER_ROLE", cust.address);
    await grantComponentRole(hre, accessManager, rm, "RESOLVER_ROLE", cust.address);

    await currency.connect(lp).approve(pool.target, _A(3000));
    await pool.connect(lp).deposit(etk.target, _A(3000));
  });

  it("Change status and remove eToken", async function () {
    // When active deposits are OK
    expect(await pool.getComponentStatus(etk.target)).to.be.equal(ST_ACTIVE);
    await currency.connect(lp).approve(pool.target, _A(500));
    await expect(pool.connect(lp).deposit(etk.target, _A(300))).not.to.be.reverted;

    // Only LEVEL1 can deprecate
    await expect(pool.connect(johndoe).changeComponentStatus(etk.target, ST_DEPRECATED)).to.be.revertedWith(
      accessControlMessage(johndoe.address, null, "LEVEL1_ROLE")
    );
    await expect(pool.connect(guardian).changeComponentStatus(etk.target, ST_DEPRECATED)).to.be.revertedWith(
      "Only GUARDIAN can suspend / Only LEVEL1 can activate/deprecate"
    );
    await expect(pool.connect(level1).changeComponentStatus(etk.target, ST_DEPRECATED)).not.to.be.reverted;
    expect(await pool.getComponentStatus(etk.target)).to.be.equal(ST_DEPRECATED);

    // When deprecated, deposits aren't allowed, but withdrawals are allowed
    await expect(pool.connect(lp).deposit(etk.target, _A(200))).to.be.revertedWith("eToken is not active");
    await expect(pool.connect(lp).withdraw(etk.target, _A(200))).not.to.be.reverted;

    // Only GUARDIAN can suspend
    await expect(pool.connect(level1).changeComponentStatus(etk.target, ST_SUSPENDED)).to.be.revertedWith(
      "Only GUARDIAN can suspend / Only LEVEL1 can activate/deprecate"
    );
    await expect(pool.connect(guardian).changeComponentStatus(etk.target, ST_SUSPENDED)).not.to.be.reverted;
    expect(await pool.getComponentStatus(etk.target)).to.be.equal(ST_SUSPENDED);

    // When suspended, withdrawals are not allowed
    await expect(pool.connect(lp).withdraw(etk.target, _A(100))).to.be.revertedWith(
      "eToken not found or withdraws not allowed"
    );

    // Only LEVEL1 can reactivate
    await expect(pool.connect(guardian).changeComponentStatus(etk.target, ST_ACTIVE)).to.be.revertedWith(
      "Only GUARDIAN can suspend / Only LEVEL1 can activate/deprecate"
    );
    await expect(pool.connect(level1).changeComponentStatus(etk.target, ST_ACTIVE)).not.to.be.reverted;
    expect(await pool.getComponentStatus(etk.target)).to.be.equal(ST_ACTIVE);

    await expect(pool.connect(lp).deposit(etk.target, _A(200))).not.to.be.reverted;

    await expect(pool.connect(level1).changeComponentStatus(etk.target, ST_DEPRECATED)).not.to.be.reverted;
    await expect(pool.connect(level1).removeComponent(etk.target)).to.be.revertedWith(
      "EToken has liquidity, can't be removed"
    );

    await expect(pool.connect(lp).withdraw(etk.target, MaxUint256)).not.to.be.reverted;

    await expect(pool.connect(guardian).removeComponent(etk.target)).to.be.revertedWith(
      accessControlMessage(guardian.address, null, "LEVEL1_ROLE") // Only LEVEL1 can remove
    );

    await expect(pool.connect(level1).removeComponent(etk.target)).not.to.be.reverted;
    expect(await pool.getComponentStatus(etk.target)).to.be.equal(ST_INACTIVE);

    await expect(pool.connect(lp).deposit(etk.target, _A(200))).to.be.revertedWith("Component is not an eToken");
  });

  it("Change status and remove RiskModule", async function () {
    const start = await helpers.time.latest();
    await currency.connect(cust).approve(pool.target, _A(100));

    // When active newPolicies are OK
    let newPolicyEvt = await makePolicy(pool, rm, cust, _A(36), _A(1), _W(1 / 37), start + 3600, 1, "newPolicyFull");
    let policy = newPolicyEvt.args.policy;

    expect(await pool.getComponentStatus(rm.target)).to.be.equal(ST_ACTIVE);

    // Only LEVEL1 can deprecate
    await expect(pool.connect(level1).changeComponentStatus(rm.target, ST_DEPRECATED)).not.to.be.reverted;
    expect(await pool.getComponentStatus(rm.target)).to.be.equal(ST_DEPRECATED);

    // When deprecated can't create policy
    await expect(
      rm.connect(cust).newPolicy(_A(36), _A(1), _W(1 / 37), start + 3600, cust.address, 2)
    ).to.be.revertedWith("RM module not found or not active");

    // But policies can be resolved
    await expect(rm.connect(cust).resolvePolicy([...policy], _A(10))).not.to.be.reverted;

    // Reactivate RM
    await expect(pool.connect(level1).changeComponentStatus(rm.target, ST_ACTIVE)).not.to.be.reverted;
    expect(await pool.getComponentStatus(rm.target)).to.be.equal(ST_ACTIVE);

    newPolicyEvt = await makePolicy(pool, rm, cust, _A(36), _A(1), _W(1 / 37), start + 3600, 3);
    policy = newPolicyEvt.args.policy;

    // Only GUARDIAN can suspend
    await expect(pool.connect(level1).changeComponentStatus(rm.target, ST_SUSPENDED)).to.be.revertedWith(
      "Only GUARDIAN can suspend / Only LEVEL1 can activate/deprecate"
    );
    await expect(pool.connect(guardian).changeComponentStatus(rm.target, ST_SUSPENDED)).not.to.be.reverted;
    expect(await pool.getComponentStatus(rm.target)).to.be.equal(ST_SUSPENDED);

    // When suspended, policy creation / resolutions are not allowed
    await expect(rm.connect(cust).resolvePolicy([...policy], _A(10))).to.be.revertedWith(
      "Module must be active or deprecated to process resolutions"
    );
    await expect(
      rm.connect(cust).newPolicy(_A(36), _A(1), _W(1 / 37), start + 3600, cust.address, 4)
    ).to.be.revertedWith("RM module not found or not active");

    // Can't be removed if not deprecated before, or if has active policies
    await expect(pool.connect(level1).removeComponent(rm.target)).to.be.revertedWith("Component not deprecated");
    await expect(pool.connect(level1).changeComponentStatus(rm.target, ST_DEPRECATED)).not.to.be.reverted;

    await expect(pool.connect(level1).removeComponent(rm.target)).to.be.revertedWith(
      "Can't remove a module with active policies"
    );

    await expect(rm.connect(cust).resolvePolicy([...policy], _A(10))).not.to.be.reverted;
    await expect(pool.connect(level1).removeComponent(rm.target)).not.to.be.reverted;
    expect(await pool.getComponentStatus(rm.target)).to.be.equal(ST_INACTIVE);

    await expect(
      rm.connect(cust).newPolicy(_A(36), _A(1), _W(1 / 37), start + 3600, cust.address, 5)
    ).to.be.revertedWith("Component is not a RiskModule");
  });

  it("Change status and remove PremiumsAccount", async function () {
    const start = await helpers.time.latest();
    await currency.connect(cust).approve(pool.target, _A(100));

    // When active newPolicies are OK
    let newPolicyEvt = await makePolicy(pool, rm, cust, _A(36), _A(1), _W(1 / 37), start + 3600, 1);
    let policy = newPolicyEvt.args.policy;

    expect(await pool.getComponentStatus(premiumsAccount.target)).to.be.equal(ST_ACTIVE);

    // Only LEVEL1 can deprecate
    await expect(pool.connect(level1).changeComponentStatus(premiumsAccount.target, ST_DEPRECATED)).not.to.be.reverted;
    expect(await pool.getComponentStatus(premiumsAccount.target)).to.be.equal(ST_DEPRECATED);

    // When deprecated can't create policy
    await expect(
      rm.connect(cust).newPolicy(_A(36), _A(1), _W(1 / 37), start + 3600, cust.address, 2)
    ).to.be.revertedWith("PremiumsAccount not found or not active");

    // But policies can be resolved
    await expect(rm.connect(cust).resolvePolicy([...policy], _A(10))).not.to.be.reverted;

    // Reactivate PA
    await expect(pool.connect(level1).changeComponentStatus(premiumsAccount.target, ST_ACTIVE)).not.to.be.reverted;
    expect(await pool.getComponentStatus(premiumsAccount.target)).to.be.equal(ST_ACTIVE);

    newPolicyEvt = await makePolicy(pool, rm, cust, _A(36), _A(1), _W(1 / 37), start + 3600, 3);
    policy = newPolicyEvt.args.policy;

    // Only GUARDIAN can suspend
    await pool.connect(guardian).changeComponentStatus(premiumsAccount.target, ST_SUSPENDED);
    expect(await pool.getComponentStatus(premiumsAccount.target)).to.be.equal(ST_SUSPENDED);

    // When suspended, policy creation / resolutions are not allowed
    await expect(rm.connect(cust).resolvePolicy([...policy], _A(10))).to.be.revertedWith(
      "PremiumsAccount must be active or deprecated to process resolutions"
    );
    await expect(
      rm.connect(cust).newPolicy(_A(36), _A(1), _W(1 / 37), start + 3600, cust.address, 4)
    ).to.be.revertedWith("PremiumsAccount not found or not active");

    // Can't be removed if not deprecated before, or if has active policies
    await expect(pool.connect(level1).removeComponent(premiumsAccount.target)).to.be.revertedWith(
      "Component not deprecated"
    );
    await pool.connect(level1).changeComponentStatus(premiumsAccount.target, ST_DEPRECATED);

    await expect(pool.connect(level1).removeComponent(premiumsAccount.target)).to.be.revertedWith(
      "Can't remove a PremiumsAccount with premiums"
    );

    await expect(rm.connect(cust).resolvePolicy([...policy], _A(10))).not.to.be.reverted;
    let internalLoan = await etk.getLoan(premiumsAccount.target);
    expect(internalLoan > _A(0)).to.be.true;
    const tx = await pool.connect(level1).removeComponent(premiumsAccount.target);
    const receipt = await tx.wait();
    const borrowerRemovedEvt = getTransactionEvent(etk.interface, receipt, "InternalBorrowerRemoved");

    expect(await etk.getLoan(premiumsAccount.target)).to.be.equal(_A(0)); // debt defaulted
    expect(borrowerRemovedEvt.args.defaultedDebt).to.be.equal(internalLoan);
    expect(await pool.getComponentStatus(premiumsAccount.target)).to.be.equal(ST_INACTIVE);

    await expect(
      rm.connect(cust).newPolicy(_A(36), _A(1), _W(1 / 37), start + 3600, cust.address, 5)
    ).to.be.revertedWith("Component is not a PremiumsAccount");
  });
});
