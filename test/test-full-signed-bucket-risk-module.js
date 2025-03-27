const { expect } = require("chai");
const { _W, accessControlMessage, amountFunction, getTransactionEvent, getRole } = require("@ensuro/utils/js/utils");
const { initCurrency } = require("@ensuro/utils/js/test-utils");
const { DAY } = require("@ensuro/utils/js/constants");
const {
  defaultPolicyParamsWithParams,
  defaultPolicyParamsWithBucket,
  makeBucketQuoteMessage,
  makeFullQuoteMessage,
  makeSignedQuote,
  recoverAddress,
  computeMinimumPremium,
  packParams,
} = require("../js/utils");
const { RiskModuleParameter } = require("../js/enums");
const { deployPool, deployPremiumsAccount, addRiskModule, addEToken } = require("../js/test-utils");
const hre = require("hardhat");
const helpers = require("@nomicfoundation/hardhat-network-helpers");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

describe("FullSignedBucketRiskModule contract tests", function () {
  let _A;
  let cust, fullSigner, lp, owner, resolver, signer;

  beforeEach(async () => {
    [owner, lp, cust, signer, fullSigner, resolver] = await hre.ethers.getSigners();

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
    const FullSignedBucketRiskModule = await hre.ethers.getContractFactory("FullSignedBucketRiskModule");
    const rm = await addRiskModule(pool, premiumsAccount, FullSignedBucketRiskModule, {
      collRatio: "1.0",
    });
    await rm.setParam(RiskModuleParameter.jrCollRatio, _W("0.3"));
    await rm.setParam(RiskModuleParameter.jrRoc, _W("0.1"));

    await accessManager.grantComponentRole(rm, getRole("PRICER_ROLE"), signer);
    await accessManager.grantComponentRole(rm, getRole("FULL_PRICER_ROLE"), fullSigner);
    await accessManager.grantComponentRole(rm, getRole("RESOLVER_ROLE"), resolver);
    await accessManager.grantComponentRole(rm, getRole("POLICY_CREATOR_ROLE"), cust);
    await accessManager.grantComponentRole(rm, getRole("REPLACER_ROLE"), cust);

    const paramsSameAsDefaults = { jrRoc: _W("0.1"), jrCollRatio: _W("0.3") };
    return { srEtk, jrEtk, premiumsAccount, rm, pool, accessManager, currency, paramsSameAsDefaults };
  }

  async function riskModuleWithPolicyFixture() {
    const { srEtk, jrEtk, premiumsAccount, rm, pool, accessManager, currency, paramsSameAsDefaults } =
      await deployPoolFixture();
    const policyParams = await defaultPolicyParamsWithParams({
      rm: rm,
      payout: _A("793"),
      params: paramsSameAsDefaults,
    });

    const signature = await makeSignedQuote(fullSigner, policyParams, makeFullQuoteMessage);
    const tx = await newPolicy(rm, cust, policyParams, cust, signature);
    const receipt = await tx.wait();
    const newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");

    const policy = [...newPolicyEvt.args.policy];

    return {
      srEtk,
      jrEtk,
      premiumsAccount,
      rm,
      pool,
      accessManager,
      currency,
      policy,
      policyParams,
      paramsSameAsDefaults,
    };
  }

  function newPolicy(rm, sender, policyParams, onBehalfOf, signature, method) {
    if (sender !== undefined) rm = rm.connect(sender);
    method = method || (policyParams.params === undefined ? "newPolicy" : "newPolicyFullParams");
    return rm[method](
      policyParams.payout,
      policyParams.premium,
      policyParams.lossProb,
      policyParams.expiration,
      onBehalfOf.address,
      policyParams.policyData,
      method === "newPolicyFullParams" ? policyParams.params : policyParams.bucketId,
      signature.r,
      signature.yParityAndS,
      policyParams.validUntil
    );
  }

  it("Uses the default parameters when using newPolicy method and same effect when using same params", async () => {
    const { rm, pool, paramsSameAsDefaults } = await helpers.loadFixture(deployPoolFixture);
    const policyParamsDefault = await defaultPolicyParamsWithBucket({
      rm: rm,
    });
    let signature = await makeSignedQuote(signer, policyParamsDefault, makeBucketQuoteMessage);
    let tx = await newPolicy(rm, cust, policyParamsDefault, cust, signature);

    let policyData = await getPolicyData(pool, tx);
    const rmParams = await rm.params();

    expect(policyData.ensuroCommission).to.equal(_W("0"));

    expect(policyData.moc).to.equal(rmParams[RiskModuleParameter.moc]);
    expect(policyData.purePremium).to.equal(_A("100"));
    expect(policyData.jrScr).to.equal(_A("200"));
    expect(policyData.srScr).to.equal(_A("700"));
    expect(policyData.jrCoc).to.equal(_A("1.643835"));
    expect(policyData.srCoc).to.equal(_A("5.753422"));

    // Now test the same sending fullParams
    const policyParamsFull = await defaultPolicyParamsWithParams({
      rm: rm,
      params: paramsSameAsDefaults,
    });
    signature = await makeSignedQuote(fullSigner, policyParamsFull, makeFullQuoteMessage);
    tx = await newPolicy(rm, cust, policyParamsFull, cust, signature);
    policyData = await getPolicyData(pool, tx);

    expect(policyData.ensuroCommission).to.equal(_W("0"));
    expect(policyData.purePremium).to.equal(_A("100"));
    expect(policyData.jrScr).to.equal(_A("200"));
    expect(policyData.srScr).to.equal(_A("700"));
    expect(policyData.jrCoc).to.equal(_A("1.643835"));
    expect(policyData.srCoc).to.equal(_A("5.753422"));
  });

  it("Only FULL_PRICER_ROLE can sign fully parametrizable policies, not PRICER_ROLE", async () => {
    const { rm, pool, paramsSameAsDefaults } = await helpers.loadFixture(deployPoolFixture);

    // Now test the same sending fullParams
    const policyParamsFull = await defaultPolicyParamsWithParams({
      rm: rm,
      params: paramsSameAsDefaults,
    });
    const anonSignature = await makeSignedQuote(cust, policyParamsFull, makeFullQuoteMessage);
    const signerSignature = await makeSignedQuote(signer, policyParamsFull, makeFullQuoteMessage);
    const fullSignerSignature = await makeSignedQuote(fullSigner, policyParamsFull, makeFullQuoteMessage);

    await expect(newPolicy(rm, cust, policyParamsFull, cust, anonSignature)).to.be.revertedWith(
      accessControlMessage(cust, rm, "FULL_PRICER_ROLE")
    );
    await expect(newPolicy(rm, cust, policyParamsFull, cust, signerSignature)).to.be.revertedWith(
      accessControlMessage(signer, rm, "FULL_PRICER_ROLE")
    );
    await expect(newPolicy(rm, cust, policyParamsFull, cust, fullSignerSignature)).to.emit(pool, "NewPolicy");
  });

  it("Uses the sent full params instead of the default ones", async () => {
    const { rm, pool, paramsSameAsDefaults } = await helpers.loadFixture(deployPoolFixture);
    const rmParams = await rm.params();
    const policy1Params = await defaultPolicyParamsWithParams({
      rm: rm,
      params: {
        moc: _W("1.1"),
        jrCollRatio: _W("0.17"),
        collRatio: _W("0.5"),
        ensuroPpFee: rmParams[RiskModuleParameter.ensuroPpFee],
        ensuroCocFee: rmParams[RiskModuleParameter.ensuroCocFee],
        jrRoc: _W("0.25"),
        srRoc: _W("0.29"),
      },
      lossProb: _W("0.055"),
    });

    const signature1 = await makeSignedQuote(fullSigner, policy1Params, makeFullQuoteMessage);
    const policy1Tx = await newPolicy(rm, cust, policy1Params, cust, signature1);

    const policy1Data = await getPolicyData(pool, policy1Tx);
    expect(policy1Data.moc).to.equal(_W("1.1"));
    expect(policy1Data.purePremium).to.equal(_A("60.5"));
    expect(policy1Data.jrScr).to.equal(_A("109.5"));
    expect(policy1Data.srScr).to.equal(_A("330"));
    expect(policy1Data.jrCoc).to.equal(_A("2.249999"));
    expect(policy1Data.srCoc).to.equal(_A("7.86575"));
    expect(policy1Data.ensuroCommission).to.equal(_W("0"));

    // Policy with other params
    const policy3Params = await defaultPolicyParamsWithParams({
      rm: rm,
      lossProb: _W("0.2"),
      params: paramsSameAsDefaults,
    });

    const signature3 = await makeSignedQuote(fullSigner, policy3Params, makeFullQuoteMessage);
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

  it("Does not allow policy replacement when paused", async () => {
    //
    const { rm, policy, accessManager } = await helpers.loadFixture(riskModuleWithPolicyFixture);

    await accessManager.grantComponentRole(rm, getRole("GUARDIAN_ROLE"), owner);
    await rm.pause();

    const replacementPolicyParams = await defaultPolicyParamsWithParams({ rm });
    const replacementPolicySignature = await makeSignedQuote(fullSigner, replacementPolicyParams, makeFullQuoteMessage);

    await expect(
      rm.replacePolicyFullParams(policy, ...replacePolicyParams(replacementPolicyParams, replacementPolicySignature))
    ).to.be.revertedWith("Pausable: paused");
  });

  it("Only allows REPLACER_ROLE to replace policies", async () => {
    const { rm, pool, policy, policyParams, paramsSameAsDefaults } =
      await helpers.loadFixture(riskModuleWithPolicyFixture);

    // Replace it with a higher payout
    const replacementPolicyParams = await defaultPolicyParamsWithParams({
      rm: rm,
      payout: _A("900"),
      premium: policyParams.premium,
      lossProb: policyParams.lossProb,
      expiration: policyParams.expiration,
      validUntil: policyParams.validUntil,
      params: paramsSameAsDefaults,
    });
    const replacementPolicySignature = await makeSignedQuote(fullSigner, replacementPolicyParams, makeFullQuoteMessage);

    // Anon cannot replace
    await expect(
      rm.replacePolicyFullParams(policy, ...replacePolicyParams(replacementPolicyParams, replacementPolicySignature))
    ).to.be.revertedWith(accessControlMessage(owner, rm, "REPLACER_ROLE"));

    // Authorized user can replace
    await expect(
      rm
        .connect(cust)
        .replacePolicyFullParams(policy, ...replacePolicyParams(replacementPolicyParams, replacementPolicySignature))
    )
      .to.emit(pool, "PolicyReplaced")
      .withArgs(rm.target, policy[0], anyValue);
  });

  it("Performs policy replacement when a valid signature is presented - Bucket version", async () => {
    const { rm, pool, policy, policyParams } = await helpers.loadFixture(riskModuleWithPolicyFixture);

    // Replaces a full-params policy with a bucket one
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

  it("Performs policy replacement when a valid signature is presented - Full x Full", async () => {
    const { rm, pool, policy, policyParams, paramsSameAsDefaults } =
      await helpers.loadFixture(riskModuleWithPolicyFixture);

    const replacementPolicyParams = await defaultPolicyParamsWithParams({
      rm: rm,
      payout: _A("900"),
      premium: policyParams.premium,
      lossProb: policyParams.lossProb,
      expiration: policyParams.expiration,
      validUntil: policyParams.validUntil,
      params: paramsSameAsDefaults,
    });
    const replacementPolicySignature = await makeSignedQuote(fullSigner, replacementPolicyParams, makeFullQuoteMessage);
    const replacementPolicySignaturePricerSigner = await makeSignedQuote(
      signer,
      replacementPolicyParams,
      makeFullQuoteMessage
    );

    // Bad signature is rejected
    const badParams = { ...replacementPolicyParams, payout: _A("1000") };
    const badAddress = recoverAddress(badParams, replacementPolicySignature, makeFullQuoteMessage);
    await expect(
      rm.connect(cust).replacePolicyFullParams(policy, ...replacePolicyParams(badParams, replacementPolicySignature))
    ).to.be.revertedWith(accessControlMessage(badAddress, rm, "FULL_PRICER_ROLE"));

    // Replacement signed by someone with PRICER_ROLE is rejected too
    await expect(
      rm
        .connect(cust)
        .replacePolicyFullParams(
          policy,
          ...replacePolicyParams(replacementPolicyParams, replacementPolicySignaturePricerSigner)
        )
    ).to.be.revertedWith(accessControlMessage(signer, rm, "FULL_PRICER_ROLE"));

    // Good signature is accepted
    await expect(
      rm
        .connect(cust)
        .replacePolicyFullParams(policy, ...replacePolicyParams(replacementPolicyParams, replacementPolicySignature))
    ).to.emit(pool, "PolicyReplaced");
  });

  it("Computes the minimum premium with the send params", async () => {
    const { rm } = await helpers.loadFixture(deployPoolFixture);
    const defaultParams = {
      moc: _W("1.1"),
      jrCollRatio: _W("0.2"),
      collRatio: _W("0.8"),
      ensuroPpFee: _W("0.07"),
      ensuroCocFee: _W("0.10"),
      jrRoc: _W("0.40"),
      srRoc: _W("0.20"),
    };

    const defaultPayout = _A(1000);
    const defaultExpiration = 30 * DAY;
    const defaultLossProb = _W("0.05");
    const testCases = [
      {},
      {
        params: { jrCollRatio: _W("0.04") },
      },
      {
        expiration: DAY,
      },
      {
        expiration: 500 * DAY,
      },
      {
        payout: 0n,
      },
    ];

    for (const testCase of testCases) {
      const now = await helpers.time.latest();
      const expiration = now + (testCase.expiration || defaultExpiration);
      const params = { ...defaultParams, ...(testCase.params || {}) };
      const minPremiumOnChain = await rm.getMinimumPremiumFullParams(
        testCase.payout || defaultPayout,
        testCase.lossProb || defaultLossProb,
        expiration,
        packParams(params)
      );
      const minPremiumOffChain = computeMinimumPremium(
        testCase.payout || defaultPayout,
        testCase.lossProb || defaultLossProb,
        BigInt(expiration),
        params,
        BigInt(now)
      );
      expect(minPremiumOnChain).to.closeTo(minPremiumOffChain, _A("0.0001"));
    }
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
    policy.params === undefined ? policy.bucketId : policy.params,
    signature.r,
    signature.yParityAndS,
    policy.validUntil,
  ];
}
