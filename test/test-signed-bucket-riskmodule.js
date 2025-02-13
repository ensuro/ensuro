const { expect } = require("chai");
const {
  _W,
  accessControlMessage,
  amountFunction,
  getTransactionEvent,
  grantRole,
  getRole,
} = require("@ensuro/utils/js/utils");
const { initCurrency } = require("@ensuro/utils/js/test-utils");
const {
  defaultPolicyParamsWithBucket,
  makeBucketQuoteMessage,
  makeSignedQuote,
  defaultBucketParams,
  recoverAddress,
} = require("../js/utils");
const { RiskModuleParameter } = require("../js/enums");
const { deployPool, deployPremiumsAccount, addRiskModule, addEToken } = require("../js/test-utils");
const hre = require("hardhat");
const helpers = require("@nomicfoundation/hardhat-network-helpers");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

// Test the two variant to check the FullSignedBucketRiskModule also behaves exactly the same way as
// SignedBucketRiskModule, unless for the new methods that are tested in a new test file
const variants = [
  {
    contract: "SignedBucketRiskModule",
  },
  {
    contract: "FullSignedBucketRiskModule",
  },
];

variants.forEach((variant) => {
  describe(`SignedBucketRiskModule contract tests - ${variant.contract}`, function () {
    let _A;
    let cust, level1, level2, lp, owner, resolver, signer;

    beforeEach(async () => {
      [owner, lp, cust, signer, resolver, level1, level2] = await hre.ethers.getSigners();

      _A = amountFunction(6);
    });

    async function deployPoolFixture() {
      const currency = await initCurrency(
        { name: "Test USDC", symbol: "USDC", decimals: 6, initial_supply: _A(30000) },
        [lp, cust],
        [_A(20000), _A(500)]
      );

      const pool = await deployPool({
        currency: currency,
        grantRoles: ["LEVEL1_ROLE", "LEVEL2_ROLE"],
        treasuryAddress: "0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199", // Random address
      });
      pool._A = _A;

      const accessManager = await hre.ethers.getContractAt("AccessManager", await pool.access());

      // Setup the liquidity sources
      const srEtk = await addEToken(pool, {});
      const jrEtk = await addEToken(pool, {});
      const premiumsAccount = await deployPremiumsAccount(pool, { srEtk: srEtk, jrEtk: jrEtk });

      // Provide some liquidity
      await currency.connect(lp).approve(pool, _A(15000));
      await pool.connect(lp).deposit(srEtk, _A(10000));
      await pool.connect(lp).deposit(jrEtk, _A(5000));

      // Customer approval
      await currency.connect(cust).approve(pool, _A(500));

      // Setup the risk module
      const SignedBucketRiskModule = await hre.ethers.getContractFactory(variant.contract);
      const rm = await addRiskModule(pool, premiumsAccount, SignedBucketRiskModule, {
        collRatio: "1.0",
      });
      await rm.setParam(RiskModuleParameter.jrCollRatio, _W("0.3"));
      await rm.setParam(RiskModuleParameter.jrRoc, _W("0.1"));

      await accessManager.grantComponentRole(rm, getRole("PRICER_ROLE"), signer);
      await accessManager.grantComponentRole(rm, getRole("RESOLVER_ROLE"), resolver);
      await accessManager.grantComponentRole(rm, getRole("POLICY_CREATOR_ROLE"), cust);
      await accessManager.grantComponentRole(rm, getRole("REPLACER_ROLE"), cust);
      return { srEtk, jrEtk, premiumsAccount, rm, pool, accessManager, currency };
    }

    async function riskModuleWithPolicyFixture() {
      const { srEtk, jrEtk, premiumsAccount, rm, pool, accessManager, currency } = await deployPoolFixture();
      const policyParams = await defaultPolicyParamsWithBucket({ rm: rm, payout: _A("793") });

      const signature = await makeSignedQuote(signer, policyParams, makeBucketQuoteMessage);
      const tx = await newPolicy(rm, cust, policyParams, cust, signature);
      const receipt = await tx.wait();
      const newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");

      const policy = [...newPolicyEvt.args.policy];

      return { srEtk, jrEtk, premiumsAccount, rm, pool, accessManager, currency, policy, policyParams };
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
        policyParams.bucketId,
        signature.r,
        signature.yParityAndS,
        policyParams.validUntil
      );
    }

    it("Uses the default parameters when no buckets are set up", async () => {
      const { rm, pool } = await helpers.loadFixture(deployPoolFixture);
      const policyParams = await defaultPolicyParamsWithBucket({ rm: rm });
      const signature = await makeSignedQuote(signer, policyParams, makeBucketQuoteMessage);
      const tx = await newPolicy(rm, cust, policyParams, cust, signature);

      const policyData = await getPolicyData(pool, tx);
      const rmParams = await rm.params();

      expect(policyData.ensuroCommission).to.equal(_W("0"));

      expect(policyData.moc).to.equal(rmParams[RiskModuleParameter.moc]);
      expect(policyData.purePremium).to.equal(_A("100"));
      expect(policyData.jrScr).to.equal(_A("200"));
      expect(policyData.srScr).to.equal(_A("700"));
      expect(policyData.jrCoc).to.equal(_A("1.643835"));
      expect(policyData.srCoc).to.equal(_A("5.753422"));
    });

    it("Only allows LEVEL1 and LEVEL2 to add/delete buckets", async () => {
      const { rm, accessManager } = await helpers.loadFixture(deployPoolFixture);

      // level1
      await expect(rm.connect(level1).setBucketParams(1, defaultBucketParams({}))).to.be.revertedWith(
        accessControlMessage(level1, rm, "LEVEL2_ROLE")
      );
      await expect(rm.connect(level1).deleteBucket(1)).to.be.revertedWith(
        accessControlMessage(level1, rm, "LEVEL2_ROLE")
      );
      await grantRole(hre, accessManager, "LEVEL1_ROLE", level1);
      await expect(rm.connect(level1).setBucketParams(1, defaultBucketParams({}))).not.to.be.reverted;
      await expect(rm.connect(level1).deleteBucket(1)).not.to.be.reverted;

      // level2
      await expect(rm.connect(level2).setBucketParams(2, defaultBucketParams({}))).to.be.revertedWith(
        accessControlMessage(level2, rm, "LEVEL2_ROLE")
      );
      await expect(rm.connect(level2).deleteBucket(2)).to.be.revertedWith(
        accessControlMessage(level2, rm, "LEVEL2_ROLE")
      );
      await grantRole(hre, accessManager, "LEVEL2_ROLE", level2);
      await expect(rm.connect(level2).setBucketParams(2, defaultBucketParams({}))).not.to.be.reverted;
      await expect(rm.connect(level2).deleteBucket(2)).not.to.be.reverted;
    });

    it("Can't set or delete bucketId = 0", async () => {
      const { rm, accessManager } = await helpers.loadFixture(deployPoolFixture);

      await grantRole(hre, accessManager, "LEVEL1_ROLE", level1);
      await expect(rm.connect(level1).setBucketParams(0, defaultBucketParams({}))).to.be.revertedWithCustomError(
        rm,
        "BucketCannotBeZero"
      );
      await expect(rm.connect(level1).deleteBucket(0)).to.be.revertedWithCustomError(rm, "BucketCannotBeZero");
    });

    it("Can't delete non-existing bucket", async () => {
      const { rm, accessManager } = await helpers.loadFixture(deployPoolFixture);
      await grantRole(hre, accessManager, "LEVEL1_ROLE", level1);

      await expect(rm.connect(level1).deleteBucket(101)).to.be.revertedWithCustomError(rm, "BucketNotFound");
    });

    it("Single bucket: uses correct bucket", async () => {
      const { rm, pool } = await helpers.loadFixture(deployPoolFixture);
      const rmParams = await rm.params();
      const bucket = defaultBucketParams({
        moc: _W("1.1"),
        jrCollRatio: _W("0.17"),
        collRatio: _W("0.5"),
        ensuroPpFee: rmParams[RiskModuleParameter.ensuroPpFee],
        ensuroCocFee: rmParams[RiskModuleParameter.ensuroCocFee],
        jrRoc: _W("0.25"),
        srRoc: _W("0.29"),
      });

      await expect(rm.setBucketParams(1234, bucket.asParams()))
        .to.emit(rm, "NewBucket")
        .withArgs(1234, bucket.asParams());

      // Policy with bucketId = 1234 uses bucket parameters
      const policy1Params = await defaultPolicyParamsWithBucket({ rm: rm, bucketId: 1234, lossProb: _W("0.055") });

      const signature1 = await makeSignedQuote(signer, policy1Params, makeBucketQuoteMessage);
      const policy1Tx = await newPolicy(rm, cust, policy1Params, cust, signature1);

      const policy1Data = await getPolicyData(pool, policy1Tx);
      expect(policy1Data.moc).to.equal(bucket.moc);
      expect(policy1Data.purePremium).to.equal(_A("60.5"));
      expect(policy1Data.jrScr).to.equal(_A("109.5"));
      expect(policy1Data.srScr).to.equal(_A("330"));
      expect(policy1Data.jrCoc).to.equal(_A("2.249999"));
      expect(policy1Data.srCoc).to.equal(_A("7.86575"));
      expect(policy1Data.ensuroCommission).to.equal(_W("0"));

      // Policy with non existent bucket reverts
      const policy2Params = await defaultPolicyParamsWithBucket({ rm: rm, bucketId: 4321, lossProb: _W("0.15") });

      const signature2 = await makeSignedQuote(signer, policy2Params, makeBucketQuoteMessage);

      await expect(newPolicy(rm, cust, policy2Params, cust, signature2)).to.be.revertedWithCustomError(
        rm,
        "BucketNotFound"
      );

      // Policy with bucketId = 0 uses default
      const policy3Params = await defaultPolicyParamsWithBucket({ rm: rm, bucketId: 0, lossProb: _W("0.2") });

      const signature3 = await makeSignedQuote(signer, policy3Params, makeBucketQuoteMessage);
      const policy3Tx = await newPolicy(rm, cust, policy3Params, cust, signature3);

      const policy3Data = await getPolicyData(pool, policy3Tx);
      expect(policy3Data.moc).to.equal(rmParams[RiskModuleParameter.moc]);
      expect(policy3Data.purePremium).to.equal(_A("200"));
      expect(policy3Data.jrScr).to.equal(_A("100"));
      expect(policy3Data.srScr).to.equal(_A("700"));
      expect(policy3Data.jrCoc).to.equal(_A("0.821917"));
      expect(policy3Data.srCoc).to.equal(_A("5.753422"));
      expect(policy3Data.ensuroCommission).to.equal(_W("0"));
    });

    it("Two buckets: uses correct bucket", async () => {
      const { rm, pool } = await helpers.loadFixture(deployPoolFixture);
      const rmParams = await rm.params();
      const bucket15 = defaultBucketParams({
        moc: _W("1.1"),
        jrCollRatio: _W("0.17"),
        collRatio: _W("0.5"),
        ensuroPpFee: rmParams[RiskModuleParameter.ensuroPpFee],
        ensuroCocFee: rmParams[RiskModuleParameter.ensuroCocFee],
        jrRoc: _W("0.25"),
        srRoc: _W("0.29"),
      });

      const bucket10 = defaultBucketParams({
        moc: _W("1"),
        jrCollRatio: _W("0.12"),
        collRatio: _W("1.0"),
        ensuroPpFee: _W("0.01"),
        ensuroCocFee: _W("0.02"),
        jrRoc: _W("0.05"),
        srRoc: _W("0.09"),
      });

      await expect(rm.setBucketParams(10, bucket10.asParams()))
        .to.emit(rm, "NewBucket")
        .withArgs(10, bucket10.asParams());

      await expect(rm.setBucketParams(15, bucket15.asParams()))
        .to.emit(rm, "NewBucket")
        .withArgs(15, bucket15.asParams());

      // Policy with bucketId = 10
      const policy1Params = await defaultPolicyParamsWithBucket({
        rm: rm,
        bucketId: 10,
        lossProb: _W("0.055"),
        payout: _A("790"),
      });

      const signature1 = await makeSignedQuote(signer, policy1Params, makeBucketQuoteMessage);
      const policy1Tx = await newPolicy(rm, cust, policy1Params, cust, signature1);

      const policy1Data = await getPolicyData(pool, policy1Tx);
      expect(policy1Data.moc).to.equal(bucket10.moc);
      expect(policy1Data.purePremium).to.equal(_A("43.45"));
      expect(policy1Data.jrScr).to.equal(_A("51.35"));
      expect(policy1Data.srScr).to.equal(_A("695.2"));
      expect(policy1Data.jrCoc).to.equal(_A("0.211027"));
      expect(policy1Data.srCoc).to.equal(_A("5.142573"));
      expect(policy1Data.ensuroCommission).to.equal(_A("0.541572"));
      expect(
        await rm.getMinimumPremiumForBucket(policy1Params.payout, policy1Params.lossProb, policy1Params.expiration, 10)
      ).to.equal(_A("49.345172"));

      // Policy with bucketId = 10
      const policy2Params = await defaultPolicyParamsWithBucket({
        rm: rm,
        lossProb: _W("0.1"),
        bucketId: 10,
        payout: _A("930"),
      });

      const signature2 = await makeSignedQuote(signer, policy2Params, makeBucketQuoteMessage);
      const policy2Tx = await newPolicy(rm, cust, policy2Params, cust, signature2);

      const policy2Data = await getPolicyData(pool, policy2Tx);
      expect(policy2Data.moc).to.equal(bucket10.moc);
      expect(policy2Data.purePremium).to.equal(_A("93"));
      expect(policy2Data.jrScr).to.equal(_A("18.6"));
      expect(policy2Data.srScr).to.equal(_A("818.4"));
      expect(policy2Data.jrCoc).to.equal(_A("0.076438"));
      expect(policy2Data.srCoc).to.equal(_A("6.053915"));
      expect(policy2Data.ensuroCommission).to.equal(_A("1.052607"));
      expect(
        await rm.getMinimumPremiumForBucket(policy2Params.payout, policy2Params.lossProb, policy2Params.expiration, 10)
      ).to.equal(_A("100.18296"));

      // Policy with bucketId = 15
      const policy3Params = await defaultPolicyParamsWithBucket({ rm: rm, bucketId: 15, lossProb: _W("0.101") });

      const signature3 = await makeSignedQuote(signer, policy3Params, makeBucketQuoteMessage);
      const policy3Tx = await newPolicy(rm, cust, policy3Params, cust, signature3);

      const policy3Data = await getPolicyData(pool, policy3Tx);
      expect(policy3Data.moc).to.equal(bucket15.moc);
      expect(policy3Data.purePremium).to.equal(_A("111.1"));
      expect(policy3Data.jrScr).to.equal(_A("58.9"));
      expect(policy3Data.srScr).to.equal(_A("330"));
      expect(policy3Data.jrCoc).to.equal(_A("1.210274"));
      expect(policy3Data.srCoc).to.equal(_A("7.865750"));
      expect(policy3Data.ensuroCommission).to.equal(_A("0"));
      expect(
        await rm.getMinimumPremiumForBucket(policy3Params.payout, policy3Params.lossProb, policy3Params.expiration, 15)
      ).to.equal(_A("120.176024"));

      // Policy with bucketId = 0 uses defaults
      const policy4Params = await defaultPolicyParamsWithBucket({ rm: rm, lossProb: _W("0.2") });

      const signature4 = await makeSignedQuote(signer, policy4Params, makeBucketQuoteMessage);
      const policy4Tx = await newPolicy(rm, cust, policy4Params, cust, signature4);

      const policy4Data = await getPolicyData(pool, policy4Tx);
      expect(policy4Data.moc).to.equal(rmParams[RiskModuleParameter.moc]);
      expect(policy4Data.purePremium).to.equal(_A("200"));
      expect(policy4Data.jrScr).to.equal(_A("100"));
      expect(policy4Data.srScr).to.equal(_A("700"));
      expect(policy4Data.jrCoc).to.equal(_A("0.821917"));
      expect(policy4Data.srCoc).to.equal(_A("5.753422"));
      expect(policy4Data.ensuroCommission).to.equal(_W("0"));
      expect(
        await rm.getMinimumPremiumForBucket(policy4Params.payout, policy4Params.lossProb, policy4Params.expiration, 0)
      ).to.equal(_A("206.575339"));
    });

    it("Allows obtaining bucket parameters", async () => {
      const { rm } = await helpers.loadFixture(deployPoolFixture);
      const bucket = defaultBucketParams({});
      await rm.setBucketParams(1, bucket);

      expect(await rm.bucketParams(1)).to.deep.equal(bucket.asParams());
      await expect(rm.deleteBucket(1)).to.emit(rm, "BucketDeleted").withArgs(1);
      await expect(rm.bucketParams(1)).to.be.revertedWithCustomError(rm, "BucketNotFound");
    });

    it("Validates bucket parameters", async () => {
      const { rm } = await helpers.loadFixture(deployPoolFixture);

      await expect(rm.setBucketParams(1, defaultBucketParams({ moc: _W("0.2") }).asParams())).to.be.revertedWith(
        "Validation: moc must be [0.5, 4]"
      );
    });

    it("Does not allow policy replacement when paused", async () => {
      //
      const { rm, policy, accessManager } = await helpers.loadFixture(riskModuleWithPolicyFixture);

      await accessManager.grantComponentRole(rm, getRole("GUARDIAN_ROLE"), owner);
      await rm.pause();

      const replacementPolicyParams = await defaultPolicyParamsWithBucket({ rm });
      const replacementPolicySignature = await makeSignedQuote(signer, replacementPolicyParams, makeBucketQuoteMessage);

      await expect(
        rm.replacePolicy(policy, ...replacePolicyParams(replacementPolicyParams, replacementPolicySignature))
      ).to.be.revertedWith("Pausable: paused");
    });

    it("Only allows REPLACER_ROLE to replace policies", async () => {
      const { rm, pool, policy, policyParams } = await helpers.loadFixture(riskModuleWithPolicyFixture);

      // Replace it with a higher payout
      const replacementPolicyParams = await defaultPolicyParamsWithBucket({
        rm: rm,
        payout: _A("900"),
        premium: policyParams.premium,
        lossProb: policyParams.lossProb,
        expiration: policyParams.expiration,
        validUntil: policyParams.validUntil,
      });
      const replacementPolicySignature = await makeSignedQuote(signer, replacementPolicyParams, makeBucketQuoteMessage);

      // Anon cannot replace
      await expect(
        rm.replacePolicy(policy, ...replacePolicyParams(replacementPolicyParams, replacementPolicySignature))
      ).to.be.revertedWith(accessControlMessage(owner, rm, "REPLACER_ROLE"));

      // Authorized user can replace
      await expect(
        rm
          .connect(cust)
          .replacePolicy(policy, ...replacePolicyParams(replacementPolicyParams, replacementPolicySignature))
      )
        .to.emit(pool, "PolicyReplaced")
        .withArgs(rm.target, policy[0], anyValue);
    });

    it("Performs policy replacement when a valid signature is presented", async () => {
      const { rm, pool, policy, policyParams } = await helpers.loadFixture(riskModuleWithPolicyFixture);

      const replacementPolicyParams = await defaultPolicyParamsWithBucket({
        rm: rm,
        payout: _A("900"),
        premium: policyParams.premium,
        lossProb: policyParams.lossProb,
        expiration: policyParams.expiration,
        validUntil: policyParams.validUntil,
      });
      const replacementPolicySignature = await makeSignedQuote(signer, replacementPolicyParams, makeBucketQuoteMessage);

      // Bad signature is rejected
      const badParams = { ...replacementPolicyParams, payout: _A("1000") };
      const badAddress = recoverAddress(badParams, replacementPolicySignature, makeBucketQuoteMessage);
      await expect(
        rm.connect(cust).replacePolicy(policy, ...replacePolicyParams(badParams, replacementPolicySignature))
      ).to.be.revertedWith(accessControlMessage(badAddress, rm, "PRICER_ROLE"));

      // Good signature is accepted
      await expect(
        rm
          .connect(cust)
          .replacePolicy(policy, ...replacePolicyParams(replacementPolicyParams, replacementPolicySignature))
      ).to.emit(pool, "PolicyReplaced");
    });
  });

  /**
   * Extract the policy data from the NewPolicy event of the transaction tx.
   *
   * In addition to the policy data, it also computes backwards the parameter values (when possible).
   */
  async function getPolicyData(pool, tx) {
    const receipt = await tx.wait();
    const newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");

    const policyData = newPolicyEvt.args[1];
    const ret = {
      id: policyData[0],
      payout: policyData[1],
      premium: policyData[2],
      jrScr: policyData[3],
      srScr: policyData[4],
      lossProb: policyData[5],
      purePremium: policyData[6],
      ensuroCommission: policyData[7],
      partnerCommission: policyData[8],
      jrCoc: policyData[9],
      srCoc: policyData[10],
      riskModule: policyData[11],
      start: policyData[12],
      expiration: policyData[13],
    };
    ret.moc = (ret.purePremium * _W("1")) / ((ret.payout * ret.lossProb) / _W("1"));

    return ret;
  }

  function replacePolicyParams(policy, signature) {
    return [
      policy.payout,
      policy.premium,
      policy.lossProb,
      policy.expiration,
      policy.policyData,
      policy.bucketId,
      signature.r,
      signature.yParityAndS,
      policy.validUntil,
    ];
  }
});
