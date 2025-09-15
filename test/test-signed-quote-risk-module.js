const { expect } = require("chai");
const _ = require("lodash");
const { amountFunction, getTransactionEvent, setupAMRole, getAccessManagerRole } = require("@ensuro/utils/js/utils");
const { getAccessManager, makeSelector } = require("@ensuro/access-managed-proxy/js/deployProxy");
const { initCurrency } = require("@ensuro/utils/js/test-utils");
const {
  defaultPolicyParams,
  defaultPolicyParamsWithBucket,
  defaultPolicyParamsWithParams,
  makeBucketQuoteMessage,
  makeFullQuoteMessage,
  makeSignedQuote,
  recoverAddress,
} = require("../js/utils");
const { deployPool, deployPremiumsAccount, addRiskModule, addEToken } = require("../js/test-utils");
const hre = require("hardhat");
const helpers = require("@nomicfoundation/hardhat-network-helpers");

const _A = amountFunction(6);

const PRICER_ROLE = getAccessManagerRole("PRICER_ROLE");
const FULL_PRICER_ROLE = getAccessManagerRole("FULL_PRICER_ROLE");

async function makeBucketSignedQuote(signer, policyParams) {
  return makeSignedQuote(signer, policyParams, makeBucketQuoteMessage);
}

async function makeFullSignedQuote(signer, policyParams) {
  return makeSignedQuote(signer, policyParams, makeFullQuoteMessage);
}

function recoverBucketAddress(policyParams, signature) {
  return recoverAddress(policyParams, signature, makeBucketQuoteMessage);
}

function recoverFullParamsAddress(policyParams, signature) {
  return recoverAddress(policyParams, signature, makeFullQuoteMessage);
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

function newPolicyFullParams(rm, sender, policyParams, onBehalfOf, signature, method) {
  if (sender !== undefined) rm = rm.connect(sender);
  return rm[method || "newPolicyFullParams"](
    policyParams.payout,
    policyParams.premium,
    policyParams.lossProb,
    policyParams.expiration,
    onBehalfOf.address,
    policyParams.policyData,
    policyParams.params,
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
  {
    contract: "SignedBucketRiskModule",
    makeSignedQuote: makeBucketSignedQuote,
    defaultPolicyParams: defaultPolicyParamsWithBucket,
    newPolicy: newPolicyWithBucket,
    resolvePolicyFullPayout: resolvePolicyMaxPayout,
    recoverAddress: recoverBucketAddress,
  },
  {
    contract: "FullSignedBucketRiskModule",
    makeSignedQuote: makeFullSignedQuote,
    defaultPolicyParams: defaultPolicyParamsWithParams,
    newPolicy: newPolicyFullParams,
    resolvePolicyFullPayout: resolvePolicyMaxPayout,
    recoverAddress: recoverFullParamsAddress,
  },
];

variants.forEach((variant) => {
  describe(`${variant.contract} contract tests`, function () {
    let anon, creator, cust, guardian, lp, resolver, signer;

    beforeEach(async () => {
      [, lp, cust, signer, creator, resolver, anon, guardian] = await hre.ethers.getSigners();
    });

    async function deployPoolFixture(creationIsOpen) {
      creationIsOpen = creationIsOpen === undefined ? false : creationIsOpen;
      const currency = await initCurrency(
        { name: "Test USDC", symbol: "USDC", decimals: 6, initial_supply: _A(10000) },
        [lp, cust, creator],
        [_A(5000), _A(500), _A(500)]
      );

      const pool = await deployPool({
        currency: currency,
        treasuryAddress: "0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199", // Random address
      });
      pool._A = _A;

      const acMgr = await getAccessManager(pool);

      // Setup the liquidity sources
      const etk = await addEToken(pool, {});
      const premiumsAccount = await deployPremiumsAccount(pool, { srEtk: etk });

      // Provide some liquidity
      await currency.connect(lp).approve(pool, _A(5000));
      await pool.connect(lp).deposit(etk, _A(5000));

      // Customer approval
      await currency.connect(creator).approve(pool, _A(500));

      // Setup the risk module
      const RiskModuleContract = await hre.ethers.getContractFactory(variant.contract);
      const rm = await addRiskModule(pool, premiumsAccount, RiskModuleContract, {
        ensuroFee: 0.03,
        extraConstructorArgs: variant.contract === "SignedQuoteRiskModule" ? [creationIsOpen] : [],
      });

      await setupAMRole(acMgr, rm, undefined, "PRICER_ROLE", [makeSelector("PRICER_ROLE")]);
      await acMgr.grantRole(PRICER_ROLE, signer, 0);
      if (variant.contract === "FullSignedBucketRiskModule") {
        await setupAMRole(acMgr, rm, undefined, "FULL_PRICER_ROLE", [makeSelector("FULL_PRICER_ROLE")]);
        await acMgr.grantRole(FULL_PRICER_ROLE, signer, 0);
      }

      return { etk, premiumsAccount, rm, pool, currency, acMgr };
    }

    it("Creates a policy if the right signature is provided", async () => {
      const { rm, pool, currency } = await helpers.loadFixture(deployPoolFixture);
      const policyParams = await variant.defaultPolicyParams({ rm: rm });
      const signature = await variant.makeSignedQuote(signer, policyParams);
      const tx = await variant.newPolicy(rm, creator, policyParams, cust, signature);
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

      await expect(() =>
        rm.connect(resolver).resolvePolicy([...newPolicyEvt.args[1]], policyParams.payout)
      ).to.changeTokenBalance(currency, cust, policyParams.payout);
    });

    it("Rejects a policy if signed by unauthorized user", async () => {
      const { rm } = await helpers.loadFixture(deployPoolFixture);
      const policyParams = await variant.defaultPolicyParams({ rm: rm });
      const signature = await variant.makeSignedQuote(anon, policyParams);
      await expect(variant.newPolicy(rm, creator, policyParams, cust, signature)).to.be.revertedWithAMError(rm, anon);
    });

    it("Rejects a policy if receives an invalid signature", async () => {
      const { rm } = await helpers.loadFixture(deployPoolFixture);
      const policyParams = await variant.defaultPolicyParams({ rm: rm });
      const signature = {
        // random values
        r: "0xbf372ca3ebecfe59ac256f17697941bbe63302aced610e8b0e3646f743c7beb2",
        yParityAndS: "0xa82e22387fca439f316d78ca566f383218ab8ae1b3e830178c9c82cbd16749c0",
      };
      await expect(variant.newPolicy(rm, creator, policyParams, cust, signature)).to.be.revertedWithCustomError(
        rm,
        "ECDSAInvalidSignature"
      );
    });

    it("Rejects a policy if quote expired or validUntil changed", async () => {
      const { rm } = await helpers.loadFixture(deployPoolFixture);
      const now = await helpers.time.latest();
      const policyParams = await variant.defaultPolicyParams({ rm: rm, validUntil: now - 1000 });
      const signature = await variant.makeSignedQuote(signer, policyParams);
      await expect(variant.newPolicy(rm, creator, policyParams, cust, signature)).to.be.revertedWithCustomError(
        rm,
        "QuoteExpired"
      );

      // If we change the policyParams, a different address is derived from the signature and it won't have
      // the required permission with a probability of (1 - 1/2**160)
      policyParams.validUntil = now + 2000;
      const recoveredAddress = variant.recoverAddress(policyParams, signature);
      await expect(variant.newPolicy(rm, creator, policyParams, cust, signature)).to.be.revertedWithAMError(
        rm,
        recoveredAddress
      );
    });

    it("Rejects policy creation and resolution if it's paused", async () => {
      const { rm, pool, acMgr } = await helpers.loadFixture(deployPoolFixture);
      await expect(pool.connect(guardian).pause()).to.emit(pool, "Paused");
      const policyParams = await variant.defaultPolicyParams({ rm: rm });
      const signature = await variant.makeSignedQuote(anon, policyParams);
      await acMgr.grantRole(
        variant.contract === "FullSignedBucketRiskModule" ? FULL_PRICER_ROLE : PRICER_ROLE,
        anon,
        0
      );

      await expect(variant.newPolicy(rm, creator, policyParams, anon, signature)).to.be.revertedWithCustomError(
        pool,
        "EnforcedPause"
      );

      if (variant.contract === "SignedQuoteRiskModule") {
        await expect(
          variant.newPolicy(rm, creator, policyParams, cust, signature, "newPolicyFull")
        ).to.be.revertedWithCustomError(pool, "EnforcedPause");
      }

      // Unpause and create a policy
      await expect(pool.connect(guardian).unpause()).to.emit(pool, "Unpaused");
      const tx = await variant.newPolicy(rm, creator, policyParams, anon, signature);
      const receipt = await tx.wait();
      const newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");

      // Pause again and check it can resolve
      await expect(pool.connect(guardian).pause()).to.emit(pool, "Paused");

      await expect(
        variant.resolvePolicyFullPayout(rm.connect(resolver), [...newPolicyEvt.args[1]], true)
      ).to.be.revertedWithCustomError(pool, "EnforcedPause");

      await expect(rm.connect(resolver).resolvePolicy([...newPolicyEvt.args[1]], _A(10))).to.be.revertedWithCustomError(
        pool,
        "EnforcedPause"
      );

      await expect(pool.connect(guardian).unpause()).to.emit(pool, "Unpaused");
      await expect(rm.connect(resolver).resolvePolicy([...newPolicyEvt.args[1]], _A(10))).to.emit(
        pool,
        "PolicyResolved"
      );
    });

    if (variant.contract === "SignedQuoteRiskModule") {
      it("Creates a policy where using newPolicyFull", async () => {
        const { rm, pool, currency } = await helpers.loadFixture(deployPoolFixture);
        const policyParams = await variant.defaultPolicyParams({ rm: rm, premium: _A(200) });
        const signature = await variant.makeSignedQuote(signer, policyParams);

        const tx = await variant.newPolicy(rm, creator, policyParams, anon, signature, "newPolicyFull");
        const receipt = await tx.wait();
        const newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");

        await expect(() =>
          variant.resolvePolicyFullPayout(rm.connect(resolver), [...newPolicyEvt.args[1]], true)
        ).to.changeTokenBalance(currency, anon, policyParams.payout);
      });

      it("Creates a policy where using newPolicy where holder == msg.sender", async () => {
        const { rm, pool, currency } = await helpers.loadFixture(deployPoolFixture);
        const policyParams = await variant.defaultPolicyParams({ rm: rm, premium: _A(200) });
        const signature = await variant.makeSignedQuote(signer, policyParams);

        const tx = await variant.newPolicy(rm, creator, policyParams, creator, signature, "newPolicy");
        const receipt = await tx.wait();
        const newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");

        await expect(() =>
          variant.resolvePolicyFullPayout(rm.connect(resolver), [...newPolicyEvt.args[1]], true)
        ).to.changeTokenBalance(currency, creator, policyParams.payout);
      });

      it("Creates a policy where holder != msg.sender using newPolicy", async () => {
        const { rm, pool, currency } = await helpers.loadFixture(deployPoolFixture);
        const policyParams = await variant.defaultPolicyParams({ rm: rm, premium: _A(200) });
        const signature = await variant.makeSignedQuote(signer, policyParams);

        await currency.connect(creator).approve(pool, _A(200));

        const tx = await variant.newPolicy(rm, creator, policyParams, cust, signature, "newPolicy");
        const receipt = await tx.wait();
        const newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");

        await expect(() =>
          variant.resolvePolicyFullPayout(rm.connect(resolver), [...newPolicyEvt.args[1]], true)
        ).to.changeTokenBalance(currency, cust, policyParams.payout);
      });

      it("If creation is open, anyone with a valid signature can create policies", async () => {
        const { rm, currency, pool } = await helpers.loadFixture(_.partial(deployPoolFixture, true));
        await currency.connect(cust).transfer(anon, _A(200));
        await currency.connect(anon).approve(pool, _A(200));

        const policyParams = await variant.defaultPolicyParams({ rm: rm });
        const signature = await variant.makeSignedQuote(signer, policyParams);
        await expect(variant.newPolicy(rm, anon, policyParams, cust, signature)).not.to.be.reverted;
      });
    }
  });
});
