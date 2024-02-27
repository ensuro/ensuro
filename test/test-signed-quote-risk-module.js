const { expect } = require("chai");
const _ = require("lodash");
const {
  accessControlMessage,
  amountFunction,
  defaultPolicyParams,
  getTransactionEvent,
  makeBucketQuoteMessage,
  makeSignedQuote,
  recoverAddress,
} = require("../js/utils");
const { initCurrency, deployPool, deployPremiumsAccount, addRiskModule, addEToken } = require("../js/test-utils");
const hre = require("hardhat");
const helpers = require("@nomicfoundation/hardhat-network-helpers");

const _A = amountFunction(6);

async function defaultPolicyParamsWithBucket(opts) {
  const ret = await defaultPolicyParams(opts, _A);
  return { bucketId: opts.bucketId || 0, ...ret };
}

async function makeBucketSignedQuote(signer, policyParams) {
  return makeSignedQuote(signer, policyParams, makeBucketQuoteMessage);
}

function recoverBucketAddress(policyParams, signature) {
  return recoverAddress(policyParams, signature, makeBucketQuoteMessage);
}

function newPolicy(rm, sender, policyParams, onBehalfOf, signature, method) {
  if (sender !== undefined) rm = rm.connect(sender);
  return rm[method || "newPolicy"](
    policyParams.payout,
    policyParams.premium,
    policyParams.lossProb,
    policyParams.expiration,
    onBehalfOf.address,
    policyParams.policyData,
    signature.r,
    signature.yParityAndS,
    policyParams.validUntil
  );
}

function newPolicyWithBucket(rm, sender, policyParams, onBehalfOf, signature, method) {
  if (sender !== undefined) rm = rm.connect(sender);
  return rm[method || "newPolicy"](
    policyParams.payout,
    policyParams.premium,
    policyParams.lossProb,
    policyParams.expiration,
    onBehalfOf.address,
    policyParams.policyData,
    policyParams.bucketId,
    signature.r,
    signature.yParityAndS,
    policyParams.validUntil
  );
}

function resolvePolicyFullPayout(rm, policy, customerWon) {
  return rm.resolvePolicyFullPayout(policy, customerWon);
}

function resolvePolicyMaxPayout(rm, policy, customerWon) {
  const payout = customerWon !== undefined ? policy[1] : _A(0);
  return rm.resolvePolicy(policy, payout);
}

const defaults = {
  makeSignedQuote: makeSignedQuote,
  defaultPolicyParams: defaultPolicyParams,
  newPolicy: newPolicy,
  resolvePolicyFullPayout: resolvePolicyFullPayout,
  recoverAddress: recoverAddress,
};

const variants = [
  { contract: "SignedQuoteRiskModule", ...defaults },
  { contract: "TieredSignedQuoteRiskModule", ...defaults },
  {
    contract: "SignedBucketRiskModule",
    makeSignedQuote: makeBucketSignedQuote,
    defaultPolicyParams: defaultPolicyParamsWithBucket,
    newPolicy: newPolicyWithBucket,
    resolvePolicyFullPayout: resolvePolicyMaxPayout,
    recoverAddress: recoverBucketAddress,
  },
];

variants.forEach((variant) => {
  describe(`${variant.contract} contract tests`, function () {
    let anon, cust, guardian, lp, resolver, signer;

    beforeEach(async () => {
      [, lp, cust, signer, resolver, anon, guardian] = await hre.ethers.getSigners();
    });

    async function deployPoolFixture(creationIsOpen) {
      creationIsOpen = creationIsOpen === undefined ? true : creationIsOpen;
      const currency = await initCurrency(
        { name: "Test USDC", symbol: "USDC", decimals: 6, initial_supply: _A(10000) },
        [lp, cust],
        [_A(5000), _A(500)]
      );

      const pool = await deployPool({
        currency: currency,
        grantRoles: ["LEVEL1_ROLE", "LEVEL2_ROLE"],
        treasuryAddress: "0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199", // Random address
      });
      pool._A = _A;

      const accessManager = await hre.ethers.getContractAt("AccessManager", await pool.access());

      // Setup the liquidity sources
      const etk = await addEToken(pool, {});
      const premiumsAccount = await deployPremiumsAccount(pool, { srEtk: etk });

      // Provide some liquidity
      await currency.connect(lp).approve(pool, _A(5000));
      await pool.connect(lp).deposit(etk, _A(5000));

      // Customer approval
      await currency.connect(cust).approve(pool, _A(500));

      // Setup the risk module
      const RiskModuleContract = await hre.ethers.getContractFactory(variant.contract);
      const rm = await addRiskModule(pool, premiumsAccount, RiskModuleContract, {
        ensuroFee: 0.03,
        extraConstructorArgs: [creationIsOpen],
      });

      await accessManager.grantComponentRole(rm, await rm.PRICER_ROLE(), signer);
      await accessManager.grantComponentRole(rm, await rm.RESOLVER_ROLE(), resolver);
      return { etk, premiumsAccount, rm, pool, accessManager, currency };
    }

    it("Creates a policy if the right signature is provided", async () => {
      const { rm, pool, currency } = await helpers.loadFixture(deployPoolFixture);
      const policyParams = await variant.defaultPolicyParams({ rm: rm });
      const signature = await variant.makeSignedQuote(signer, policyParams);
      const tx = await variant.newPolicy(rm, cust, policyParams, cust, signature);
      const receipt = await tx.wait();
      const newSignedPolicyEvt = getTransactionEvent(rm.interface, receipt, "NewSignedPolicy");
      const policyData = policyParams.policyData;
      // Verify the event is emited and the last 96 bits of the policyData are used as internalId
      const policyId = newSignedPolicyEvt.args[0];
      const twoPow96 = 2n ** 96n;
      const internalId = policyId % twoPow96;
      expect(internalId).to.be.equal(BigInt(policyData) % twoPow96);

      // The first 160 bits of policyId is the module address
      const rmAddress = await hre.ethers.resolveAddress(rm);
      expect(policyId / twoPow96).to.be.equal(BigInt(rmAddress));
      // The second parameter is the policyData itself
      expect(newSignedPolicyEvt.args[1]).to.be.equal(policyData);

      const newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");

      // Tests resolution, only by an authorized role
      await expect(rm.connect(anon).resolvePolicy([...newPolicyEvt.args[1]], policyParams.payout)).to.be.revertedWith(
        accessControlMessage(anon, rm, "RESOLVER_ROLE")
      );

      await expect(() =>
        rm.connect(resolver).resolvePolicy([...newPolicyEvt.args[1]], policyParams.payout)
      ).to.changeTokenBalance(currency, cust, policyParams.payout);
    });

    it("Rejects a policy if signed by unauthorized user", async () => {
      const { rm } = await helpers.loadFixture(deployPoolFixture);
      const policyParams = await variant.defaultPolicyParams({ rm: rm });
      const signature = await variant.makeSignedQuote(anon, policyParams);
      await expect(variant.newPolicy(rm, cust, policyParams, cust, signature)).to.be.revertedWith(
        accessControlMessage(anon, rm, "PRICER_ROLE")
      );
    });

    it("Rejects a policy if receives an invalid signature", async () => {
      const { rm } = await helpers.loadFixture(deployPoolFixture);
      const policyParams = await variant.defaultPolicyParams({ rm: rm });
      const signature = {
        // random values
        r: "0xbf372ca3ebecfe59ac256f17697941bbe63302aced610e8b0e3646f743c7beb2",
        yParityAndS: "0xa82e22387fca439f316d78ca566f383218ab8ae1b3e830178c9c82cbd16749c0",
      };
      await expect(variant.newPolicy(rm, cust, policyParams, cust, signature)).to.be.revertedWith(
        "ECDSA: invalid signature"
      );
    });

    it("Rejects a policy if quote expired or validUntil changed", async () => {
      const { rm } = await helpers.loadFixture(deployPoolFixture);
      const now = await helpers.time.latest();
      const policyParams = await variant.defaultPolicyParams({ rm: rm, validUntil: now - 1000 });
      const signature = await variant.makeSignedQuote(signer, policyParams);
      await expect(variant.newPolicy(rm, cust, policyParams, cust, signature)).to.be.revertedWith("Quote expired");

      // If we change the policyParams, a different address is derived from the signature and it won't have
      // the required permission with a probability of (1 - 1/2**160)
      policyParams.validUntil = now + 2000;
      const recoveredAddress = variant.recoverAddress(policyParams, signature);
      await expect(variant.newPolicy(rm, cust, policyParams, cust, signature)).to.be.revertedWith(
        accessControlMessage(recoveredAddress, rm, "PRICER_ROLE")
      );
    });

    it("Rejects policy creation and resolution if it's paused", async () => {
      const { rm, accessManager, pool } = await helpers.loadFixture(deployPoolFixture);
      await accessManager.grantComponentRole(rm, await rm.GUARDIAN_ROLE(), guardian);
      await expect(rm.connect(guardian).pause()).to.emit(rm, "Paused");
      const policyParams = await variant.defaultPolicyParams({ rm: rm });
      const signature = await variant.makeSignedQuote(anon, policyParams);
      await expect(variant.newPolicy(rm, cust, policyParams, cust, signature)).to.be.revertedWith("Pausable: paused");
      await expect(variant.newPolicy(rm, cust, policyParams, cust, signature, "newPolicyFull")).to.be.revertedWith(
        "Pausable: paused"
      );
      await expect(
        variant.newPolicy(rm, cust, policyParams, cust, signature, "newPolicyPaidByHolder")
      ).to.be.revertedWith("Pausable: paused");

      // Unpause and create a policy
      await expect(rm.connect(guardian).unpause()).to.emit(rm, "Unpaused");
      await accessManager.grantComponentRole(rm, await rm.PRICER_ROLE(), anon);
      const tx = await variant.newPolicy(rm, cust, policyParams, anon, signature, "newPolicyFull");
      const receipt = await tx.wait();
      const newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");

      // Pause again and check it can resolve
      await expect(rm.connect(guardian).pause()).to.emit(rm, "Paused");

      await expect(
        variant.resolvePolicyFullPayout(rm.connect(resolver), [...newPolicyEvt.args[1]], true)
      ).to.be.revertedWith("Pausable: paused");

      await expect(rm.connect(resolver).resolvePolicy([...newPolicyEvt.args[1]], _A(10))).to.be.revertedWith(
        "Pausable: paused"
      );

      await expect(rm.connect(guardian).unpause()).to.emit(rm, "Unpaused");
      await expect(rm.connect(resolver).resolvePolicy([...newPolicyEvt.args[1]], _A(10))).to.emit(
        pool,
        "PolicyResolved"
      );
    });

    it("Creates a policy where using newPolicyFull", async () => {
      const { rm, pool, currency } = await helpers.loadFixture(deployPoolFixture);
      const policyParams = await variant.defaultPolicyParams({ rm: rm, premium: _A(200) });
      const signature = await variant.makeSignedQuote(signer, policyParams);

      const tx = await variant.newPolicy(rm, cust, policyParams, anon, signature, "newPolicyFull");
      const receipt = await tx.wait();
      const newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");

      // Tests resolution, only by an authorized role
      await expect(
        variant.resolvePolicyFullPayout(rm.connect(anon), [...newPolicyEvt.args[1]], true)
      ).to.be.revertedWith(accessControlMessage(anon, rm, "RESOLVER_ROLE"));

      await expect(() =>
        variant.resolvePolicyFullPayout(rm.connect(resolver), [...newPolicyEvt.args[1]], true)
      ).to.changeTokenBalance(currency, anon, policyParams.payout);
    });

    it("Creates a policy where using newPolicyPaidByHolder where payer == msg.sender", async () => {
      const { rm, pool, currency } = await helpers.loadFixture(deployPoolFixture);
      const policyParams = await variant.defaultPolicyParams({ rm: rm, premium: _A(200) });
      const signature = await variant.makeSignedQuote(signer, policyParams);

      const tx = await variant.newPolicy(rm, cust, policyParams, cust, signature, "newPolicyPaidByHolder");
      const receipt = await tx.wait();
      const newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");

      await expect(() =>
        variant.resolvePolicyFullPayout(rm.connect(resolver), [...newPolicyEvt.args[1]], true)
      ).to.changeTokenBalance(currency, cust, policyParams.payout);
    });

    it("Creates a policy where payer != msg.sender using newPolicyPaidByHolder", async () => {
      const { rm, pool, currency } = await helpers.loadFixture(deployPoolFixture);
      const policyParams = await variant.defaultPolicyParams({ rm: rm, premium: _A(200) });
      const signature = await variant.makeSignedQuote(signer, policyParams);
      await expect(
        variant.newPolicy(rm, anon, policyParams, cust, signature, "newPolicyPaidByHolder")
      ).to.be.revertedWith("Sender is not authorized to create policies onBehalfOf");

      await currency.connect(cust).approve(anon, _A(200));

      const tx = await variant.newPolicy(rm, anon, policyParams, cust, signature, "newPolicyPaidByHolder");
      const receipt = await tx.wait();
      const newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");

      // Tests resolution, only by an authorized role
      await expect(
        variant.resolvePolicyFullPayout(rm.connect(anon), [...newPolicyEvt.args[1]], true)
      ).to.be.revertedWith(accessControlMessage(anon, rm, "RESOLVER_ROLE"));

      await expect(() =>
        variant.resolvePolicyFullPayout(rm.connect(resolver), [...newPolicyEvt.args[1]], true)
      ).to.changeTokenBalance(currency, cust, policyParams.payout);
    });

    it("If creation is not open, only authorized users can create policies", async () => {
      const { rm, accessManager } = await helpers.loadFixture(_.partial(deployPoolFixture, false));
      const policyParams = await variant.defaultPolicyParams({ rm: rm });
      const signature = await variant.makeSignedQuote(signer, policyParams);
      await expect(variant.newPolicy(rm, cust, policyParams, cust, signature)).to.be.revertedWith(
        accessControlMessage(cust, rm, "POLICY_CREATOR_ROLE")
      );
      await expect(
        variant.newPolicy(rm, cust, policyParams, cust, signature, "newPolicyPaidByHolder")
      ).to.be.revertedWith(accessControlMessage(cust, rm, "POLICY_CREATOR_ROLE"));
      await expect(variant.newPolicy(rm, cust, policyParams, cust, signature, "newPolicyFull")).to.be.revertedWith(
        accessControlMessage(cust, rm, "POLICY_CREATOR_ROLE")
      );
      await accessManager.grantComponentRole(rm, await rm.POLICY_CREATOR_ROLE(), cust);

      await expect(variant.newPolicy(rm, cust, policyParams, cust, signature)).not.to.be.reverted;
    });
  });
});
