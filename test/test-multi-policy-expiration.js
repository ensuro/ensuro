const { expect } = require("chai");
const {
  initCurrency,
  deployPool,
  deployPremiumsAccount,
  addRiskModule,
  amountFunction,
  addEToken,
  grantComponentRole,
  getTransactionEvent,
  _W,
  makePolicyId,
} = require("./test-utils");
const hre = require("hardhat");
const helpers = require("@nomicfoundation/hardhat-network-helpers");
const { BigNumber } = require("ethers");

const _A = amountFunction(6);

describe("Multiple policy expirations", function () {
  // this.timeout(300000); // Mocha timeout, some of this tests can take quite long to run

  beforeEach(async () => {});

  it("Measure the gas cost of single policy expiration", async () => {
    const { pool, backend, policies } = await helpers.loadFixture(poolWithPolicies);

    await helpers.time.increaseTo(policies[policies.length - 1].expiration);

    let gasUsedForSingleExpiration = BigNumber.from(0);
    for (const policy of policies) {
      const tx = await pool.connect(backend).expirePolicy(policy);
      const receipt = await tx.wait();
      gasUsedForSingleExpiration = gasUsedForSingleExpiration.add(receipt.gasUsed);
    }

    console.log(
      "Total gas used by individual expiration of %s policies: %s",
      policies.length,
      gasUsedForSingleExpiration
    );
    console.log("Avg gas per policy expiration: %s", gasUsedForSingleExpiration.div(policies.length));
  });

  it("Measure the gas cost of multiple policy expiration", async () => {
    const { pool, backend, policies } = await helpers.loadFixture(poolWithPolicies);

    await helpers.time.increaseTo(policies[policies.length - 1].expiration);

    const tx = await pool.connect(backend).expirePolicies(policies);
    const receipt = await tx.wait();
    console.log("Total gas used by multiple expiration of %s policies: %s", policies.length, receipt.gasUsed);
    console.log("Avg gas per policy expiration: %s", receipt.gasUsed.div(policies.length));
  });

  it.skip("Measure what's the max number of policies that can be expired without exceeding the max gas", async () => {
    const { pool, rm, backend, pricer, policies } = await helpers.loadFixture(poolWithPolicies);

    const additionalPolicies = 3500; // number arrived at by trial-and-error

    for (let i = 0; i < additionalPolicies; i++) {
      const policy = await makePolicy({ payer: pricer.address, internalId: 100000 + i });
      const tx = await rm.connect(pricer).newPolicy(...policy.toArgs());
      const receipt = await tx.wait();
      const newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");
      policies.push(newPolicyEvt.args.policy);
    }

    await helpers.time.increaseTo(policies[policies.length - 1].expiration);
    const tx = await pool.connect(backend).expirePolicies(policies, {
      gasLimit: 15_000_000, // Half the polygon PoS block limit as of may 2023
    });
    const receipt = await tx.wait();
    console.log("Total gas used by multi-expiring %s policies: %s", policies.length, receipt.gasUsed);
  });

  it("Actually expires the policies", async () => {
    const { pool, rm, backend, policies } = await helpers.loadFixture(poolWithPolicies);

    await helpers.time.increaseTo(policies[policies.length - 1].expiration);

    const tx = await pool.connect(backend).expirePolicies(policies);
    const receipt = await tx.wait();

    const expiredPolicyIds = receipt.logs
      .map((log) => pool.interface.parseLog(log))
      .filter((event) => event.name == "PolicyResolved")
      .map((event) => event.args.policyId);

    console.log(rm.address);
    expect(expiredPolicyIds).to.deep.equal(policies.map((p) => p.id));
  });

  it("Refuses to expire unexpired policies", async () => {
    const { pool, rm, backend, pricer, policies } = await helpers.loadFixture(poolWithPolicies);

    // Forward time past the last policy
    await helpers.time.increaseTo(policies[policies.length - 1].expiration);

    // Create a new policy
    const policy = await makePolicy({ payer: pricer.address, internalId: policies.length + 1 });
    const tx = await rm.connect(pricer).newPolicy(...policy.toArgs());
    const receipt = await tx.wait();
    const newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");

    // Try to expire this unexpired policy along with an expired one
    const toExpire = [policies[0], newPolicyEvt.args.policy];
    expect(newPolicyEvt.args.policy.expiration).to.be.greaterThan(await helpers.time.latest());
    await expect(pool.connect(backend).expirePolicies(toExpire)).to.be.revertedWith("Policy not expired yet");
  });
});

async function poolWithPolicies() {
  const [owner, lp, backend, pricer, ...otherSigners] = await hre.ethers.getSigners();

  const currency = await initCurrency(
    { name: "Test USDC", symbol: "USDC", decimals: 6, initial_supply: _A(200500) },
    [lp, backend, pricer],
    [_A(100000), _A(500), _A(100000)]
  );

  const pool = await deployPool(hre, {
    currency: currency.address,
    grantRoles: ["LEVEL1_ROLE", "LEVEL2_ROLE"],
    treasuryAddress: "0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199", // Random address
  });
  pool._A = _A;

  const etk = await addEToken(pool, {});
  const premiumsAccount = await deployPremiumsAccount(hre, pool, { srEtkAddr: etk.address });
  const accessManager = await hre.ethers.getContractAt("AccessManager", await pool.access());

  const RiskModule = await hre.ethers.getContractFactory("RiskModuleMock");
  const rm = await addRiskModule(pool, premiumsAccount, RiskModule, {
    collRatio: "0.01",
    extraArgs: [],
  });

  // Fund the protocol
  await currency.connect(lp).approve(pool.address, _A(100000));
  await pool.connect(lp).deposit(etk.address, _A(100000));

  // Allow pricer spending to pay for policies
  await currency.connect(pricer).approve(pool.address, _A(100000));

  // Allow pricer to create policies
  await grantComponentRole(hre, accessManager, rm, "PRICER_ROLE", pricer);

  // Create a bunch of policies
  const policies = [];
  for (let i = 0; i < 100; i++) {
    const policy = await makePolicy({ payer: pricer.address, internalId: i });
    const tx = await rm.connect(pricer).newPolicy(...policy.toArgs());
    const receipt = await tx.wait();
    const newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");
    policies.push(newPolicyEvt.args.policy);
  }

  return {
    pool,
    etk,
    premiumsAccount,
    RiskModule,
    rm,
    accessManager,
    currency,
    owner,
    lp,
    backend,
    pricer,
    otherSigners,
    policies,
  };
}

async function makePolicy({ payout, premium, lossProbability, expiration, payer, onBehalfOf, internalId }) {
  const now = await helpers.time.latest();
  const policy = {
    payout: payout || _A(100),
    premium: premium || _A(11),
    lossProbability: lossProbability || _W("0.1"),
    expiration: expiration || now + 3600 * 5,
    payer: payer,
    onBehalfOf: onBehalfOf || payer,
    internalId: internalId || 123,
  };
  policy.toArgs = () => [
    policy.payout,
    policy.premium,
    policy.lossProbability,
    policy.expiration,
    policy.payer,
    policy.onBehalfOf,
    policy.internalId,
  ];
  return policy;
}
