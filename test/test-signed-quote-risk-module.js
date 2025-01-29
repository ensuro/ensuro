const { expect } = require("chai");
const _ = require("lodash");
const {
  accessControlMessage,
  amountFunction,
  defaultPolicyParams,
  getTransactionEvent,
  makeBucketQuoteMessage,
  makeSignedQuote,
  getRole,
  recoverAddress,
} = require("../js/utils");
const { initCurrency, deployPool, deployPremiumsAccount, addRiskModule, addEToken } = require("../js/test-utils");
const hre = require("hardhat");
const ethers = hre.ethers;
const helpers = require("@nomicfoundation/hardhat-network-helpers");

const _A = amountFunction(6);

async function defaultPolicyParamsWithBucket(opts) {
  const ret = await defaultPolicyParams(opts, _A);
  return { bucketId: opts.bucketId || 0, ...ret };
}

async function defaultPolicyParamsWithParams(opts) {
  const ret = await defaultPolicyParams(opts, _A);
  // struct PackedParams {
  //   uint16 moc; // Margin Of Conservativism - factor that multiplies lossProb - 4 decimals
  //   uint16 jrCollRatio; // Collateralization Ratio to compute Junior solvency as % of payout - 4 decimals
  //   uint16 collRatio; // Collateralization Ratio to compute solvency requirement as % of payout - 4 decimals
  //   uint16 ensuroPpFee; // % of pure premium that will go for Ensuro treasury - 4 decimals
  //   uint16 ensuroCocFee; // % of CoC that will go for Ensuro treasury - 4 decimals
  //   uint16 jrRoc; // Return on Capital paid to Junior LPs - Annualized Percentage - 4 decimals
  //   uint16 srRoc; // Return on Capital paid to Senior LPs - Annualized Percentage - 4 decimals
  //   uint32 maxPayoutPerPolicy; // Max Payout per Policy - 2 decimals
  //   uint32 exposureLimit; // Max exposure (sum of payouts) to be allocated to this module - 0 decimals
  //   uint16 maxDuration; // Max policy duration (in hours)
  // }
  const optsParams = opts.params || {};
  const params = {
    moc: optsParams.moc || 10000n,
    jrCollRatio: optsParams.jrCollRatio || 0n,
    collRatio: optsParams.collRatio || 10000n,
    ensuroPpFee: optsParams.ensuroPpFee || 0n,
    ensuroCocFee: optsParams.ensuroCocFee || 0n,
    jrRoc: optsParams.jrRoc || 0n,
    srRoc: optsParams.srRoc || 1000n, // 10%
    maxPayoutPerPolicy: 0n, // Not used
    exposureLimit: 0n, // Not used
    maxDuration: 0n, // Not used
  };
  return { params, ...ret };
}

async function makeBucketSignedQuote(signer, policyParams) {
  return makeSignedQuote(signer, policyParams, makeBucketQuoteMessage);
}

function paramsAsUint256(params) {
  /* eslint no-bitwise: "off" */
  return (
    (params.moc << 240n) |
    (params.jrCollRatio << 224n) |
    (params.collRatio << 208n) |
    (params.ensuroPpFee << 192n) |
    (params.ensuroCocFee << 176n) |
    (params.jrRoc << 160n) |
    (params.srRoc << 144n) |
    (params.maxPayoutPerPolicy << 112n) |
    (params.exposureLimit << 80n) |
    (params.maxDuration << 64n)
  );
}

function makeFullQuoteMessage({ rmAddress, payout, premium, lossProb, expiration, policyData, params, validUntil }) {
  return ethers.solidityPacked(
    ["address", "uint256", "uint256", "uint256", "uint40", "bytes32", "uint256", "uint40"],
    [rmAddress, payout, premium, lossProb, expiration, policyData, paramsAsUint256(params), validUntil]
  );
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
      await currency.connect(creator).approve(pool, _A(500));

      // Setup the risk module
      const RiskModuleContract = await hre.ethers.getContractFactory(variant.contract);
      const rm = await addRiskModule(pool, premiumsAccount, RiskModuleContract, {
        ensuroFee: 0.03,
        extraConstructorArgs: variant.contract === "SignedQuoteRiskModule" ? [creationIsOpen] : [],
      });

      await accessManager.grantComponentRole(rm, getRole("PRICER_ROLE"), signer);
      if (variant.contract === "FullSignedBucketRiskModule")
        await accessManager.grantComponentRole(rm, getRole("FULL_PRICER_ROLE"), signer);
      await accessManager.grantComponentRole(rm, getRole("RESOLVER_ROLE"), resolver);
      await accessManager.grantComponentRole(rm, getRole("POLICY_CREATOR_ROLE"), creator);
      return { etk, premiumsAccount, rm, pool, accessManager, currency };
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
      await expect(variant.newPolicy(rm, creator, policyParams, cust, signature)).to.be.revertedWith(
        accessControlMessage(
          anon,
          rm,
          variant.contract === "FullSignedBucketRiskModule" ? "FULL_PRICER_ROLE" : "PRICER_ROLE"
        )
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
      await expect(variant.newPolicy(rm, creator, policyParams, cust, signature)).to.be.revertedWith(
        "ECDSA: invalid signature"
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
      await expect(variant.newPolicy(rm, creator, policyParams, cust, signature)).to.be.revertedWith(
        accessControlMessage(
          recoveredAddress,
          rm,
          variant.contract === "FullSignedBucketRiskModule" ? "FULL_PRICER_ROLE" : "PRICER_ROLE"
        )
      );
    });

    it("Rejects policy creation and resolution if it's paused", async () => {
      const { rm, accessManager, pool } = await helpers.loadFixture(deployPoolFixture);
      await accessManager.grantComponentRole(rm, getRole("GUARDIAN_ROLE"), guardian);
      await expect(rm.connect(guardian).pause()).to.emit(rm, "Paused");
      const policyParams = await variant.defaultPolicyParams({ rm: rm });
      const signature = await variant.makeSignedQuote(anon, policyParams);
      await expect(variant.newPolicy(rm, creator, policyParams, cust, signature)).to.be.revertedWith(
        "Pausable: paused"
      );

      if (variant.contract === "SignedQuoteRiskModule") {
        await expect(variant.newPolicy(rm, creator, policyParams, cust, signature, "newPolicyFull")).to.be.revertedWith(
          "Pausable: paused"
        );
        await expect(
          variant.newPolicy(rm, creator, policyParams, cust, signature, "newPolicyPaidByHolder")
        ).to.be.revertedWith("Pausable: paused");
      }

      // Unpause and create a policy
      await expect(rm.connect(guardian).unpause()).to.emit(rm, "Unpaused");
      await accessManager.grantComponentRole(
        rm,
        getRole(variant.contract === "FullSignedBucketRiskModule" ? "FULL_PRICER_ROLE" : "PRICER_ROLE"),
        anon
      );
      const tx = await variant.newPolicy(rm, creator, policyParams, anon, signature);
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

    it("Rejects policy creation for users without POLICY_CREATOR_ROLE", async () => {
      const { rm, currency } = await helpers.loadFixture(deployPoolFixture);
      const policyParams = await variant.defaultPolicyParams({ rm: rm });
      const signature = await variant.makeSignedQuote(signer, policyParams);
      await expect(variant.newPolicy(rm, anon, policyParams, cust, signature)).to.be.revertedWith(
        accessControlMessage(anon, rm, "POLICY_CREATOR_ROLE")
      );

      if (variant.contract === "SignedQuoteRiskModule") {
        await currency.connect(cust).approve(anon, _A(500));
        await expect(
          variant.newPolicy(rm, anon, policyParams, cust, signature, "newPolicyPaidByHolder")
        ).to.be.revertedWith(accessControlMessage(anon, rm, "POLICY_CREATOR_ROLE"));
        await expect(variant.newPolicy(rm, anon, policyParams, cust, signature, "newPolicyFull")).to.be.revertedWith(
          accessControlMessage(anon, rm, "POLICY_CREATOR_ROLE")
        );
      }
    });

    if (variant.contract === "SignedQuoteRiskModule") {
      it("Creates a policy where using newPolicyFull", async () => {
        const { rm, pool, currency } = await helpers.loadFixture(deployPoolFixture);
        const policyParams = await variant.defaultPolicyParams({ rm: rm, premium: _A(200) });
        const signature = await variant.makeSignedQuote(signer, policyParams);

        const tx = await variant.newPolicy(rm, creator, policyParams, anon, signature, "newPolicyFull");
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

        const tx = await variant.newPolicy(rm, creator, policyParams, creator, signature, "newPolicyPaidByHolder");
        const receipt = await tx.wait();
        const newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");

        await expect(() =>
          variant.resolvePolicyFullPayout(rm.connect(resolver), [...newPolicyEvt.args[1]], true)
        ).to.changeTokenBalance(currency, creator, policyParams.payout);
      });

      it("Creates a policy where payer != msg.sender using newPolicyPaidByHolder", async () => {
        const { rm, pool, currency } = await helpers.loadFixture(deployPoolFixture);
        const policyParams = await variant.defaultPolicyParams({ rm: rm, premium: _A(200) });
        const signature = await variant.makeSignedQuote(signer, policyParams);
        await expect(
          variant.newPolicy(rm, creator, policyParams, cust, signature, "newPolicyPaidByHolder")
        ).to.be.revertedWith("Sender is not authorized to create policies onBehalfOf");

        await currency.connect(cust).approve(creator, _A(200));
        await currency.connect(cust).approve(pool, _A(200));

        const tx = await variant.newPolicy(rm, creator, policyParams, cust, signature, "newPolicyPaidByHolder");
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
