const { expect } = require("chai");
const {
  _W,
  accessControlMessage,
  amountFunction,
  defaultPolicyParams,
  getTransactionEvent,
  grantRole,
  makeSignedQuote,
  defaultBucketParams,
} = require("../js/utils");
const { RiskModuleParameter } = require("../js/enums");
const hre = require("hardhat");
const { initCurrency, deployPool, deployPremiumsAccount, addRiskModule, addEToken } = require("../js/test-utils");
const helpers = require("@nomicfoundation/hardhat-network-helpers");

describe("TieredSignedQuoteRiskModule contract tests", function () {
  let _A;
  let cust, level1, level2, lp, resolver, signer;

  beforeEach(async () => {
    [, lp, cust, signer, resolver, level1, level2] = await hre.ethers.getSigners();

    _A = amountFunction(6);
  });

  async function deployPoolFixture() {
    const currency = await initCurrency(
      { name: "Test USDC", symbol: "USDC", decimals: 6, initial_supply: _A(30000) },
      [lp, cust],
      [_A(20000), _A(500)]
    );

    const pool = await deployPool({
      currency: currency.target,
      grantRoles: ["LEVEL1_ROLE", "LEVEL2_ROLE"],
      treasuryAddress: "0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199", // Random address
    });
    pool._A = _A;

    const accessManager = await hre.ethers.getContractAt("AccessManager", await pool.access());

    // Setup the liquidity sources
    const srEtk = await addEToken(pool, {});
    const jrEtk = await addEToken(pool, {});
    const premiumsAccount = await deployPremiumsAccount(pool, {
      srEtkAddr: srEtk.target,
      jrEtkAddr: jrEtk.target,
    });

    // Provide some liquidity
    await currency.connect(lp).approve(pool.target, _A(15000));
    await pool.connect(lp).deposit(srEtk.target, _A(10000));
    await pool.connect(lp).deposit(jrEtk.target, _A(5000));

    // Customer approval
    await currency.connect(cust).approve(pool.target, _A(500));

    // Setup the risk module
    const TieredSignedQuoteRiskModule = await hre.ethers.getContractFactory("TieredSignedQuoteRiskModule");
    const rm = await addRiskModule(pool, premiumsAccount, TieredSignedQuoteRiskModule, {
      collRatio: "1.0",
      extraConstructorArgs: [true],
    });
    await rm.setParam(RiskModuleParameter.jrCollRatio, _W("0.3"));
    await rm.setParam(RiskModuleParameter.jrRoc, _W("0.1"));

    await accessManager.grantComponentRole(rm.target, await rm.PRICER_ROLE(), signer.address);
    await accessManager.grantComponentRole(rm.target, await rm.RESOLVER_ROLE(), resolver.address);
    return { srEtk, jrEtk, premiumsAccount, rm, pool, accessManager, currency };
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

  it("Uses the default parameters when no buckets are set up", async () => {
    const { rm, pool } = await helpers.loadFixture(deployPoolFixture);
    const policyParams = await defaultPolicyParams({ rmAddress: rm.target });
    const signature = await makeSignedQuote(signer, policyParams);
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

  it("Only allows LEVEL1 and LEVEL2 to set/reset buckets", async () => {
    const { rm, accessManager } = await helpers.loadFixture(deployPoolFixture);

    // level1
    await expect(rm.connect(level1).pushBucket(_W("0.15"), defaultBucketParams({}))).to.be.revertedWith(
      accessControlMessage(level1.address, rm.target, "LEVEL2_ROLE")
    );
    await expect(rm.connect(level1).resetBuckets()).to.be.revertedWith(
      accessControlMessage(level1.address, rm.target, "LEVEL2_ROLE")
    );
    await grantRole(hre, accessManager, "LEVEL1_ROLE", level1.address);
    await expect(rm.connect(level1).pushBucket(_W("0.15"), defaultBucketParams({}))).not.to.be.reverted;
    await expect(rm.connect(level1).resetBuckets()).not.to.be.reverted;

    // level2
    await expect(rm.connect(level2).pushBucket(_W("0.15"), defaultBucketParams({}))).to.be.revertedWith(
      accessControlMessage(level2.address, rm.target, "LEVEL2_ROLE")
    );
    await expect(rm.connect(level2).resetBuckets()).to.be.revertedWith(
      accessControlMessage(level2.address, rm.target, "LEVEL2_ROLE")
    );
    await grantRole(hre, accessManager, "LEVEL2_ROLE", level2.address);
    await expect(rm.connect(level2).pushBucket(_W("0.15"), defaultBucketParams({}))).not.to.be.reverted;
    await expect(rm.connect(level2).resetBuckets()).not.to.be.reverted;
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

    await expect(rm.pushBucket(_W("0.15"), bucket.asParams()))
      .to.emit(rm, "NewBucket")
      .withArgs(_W("0.15"), bucket.asParams());

    // Policy with lossProb < bucket uses bucket
    const policy1Params = await defaultPolicyParams({ rmAddress: rm.target, lossProb: _W("0.055") });

    const signature1 = await makeSignedQuote(signer, policy1Params);
    const policy1Tx = await newPolicy(rm, cust, policy1Params, cust, signature1);

    const policy1Data = await getPolicyData(pool, policy1Tx);
    expect(policy1Data.moc).to.equal(bucket.moc);
    expect(policy1Data.purePremium).to.equal(_A("60.5"));
    expect(policy1Data.jrScr).to.equal(_A("109.5"));
    expect(policy1Data.srScr).to.equal(_A("330"));
    expect(policy1Data.jrCoc).to.equal(_A("2.249999"));
    expect(policy1Data.srCoc).to.equal(_A("7.86575"));
    expect(policy1Data.ensuroCommission).to.equal(_W("0"));

    // Policy with lossProb = bucket uses bucket
    const policy2Params = await defaultPolicyParams({ rmAddress: rm.target, lossProb: _W("0.15") });

    const signature2 = await makeSignedQuote(signer, policy2Params);
    const policy2Tx = await newPolicy(rm, cust, policy2Params, cust, signature2);

    const policy2Data = await getPolicyData(pool, policy2Tx);
    expect(policy2Data.moc).to.equal(bucket.moc);
    expect(policy2Data.purePremium).to.equal(_A("165"));
    expect(policy2Data.jrScr).to.equal(_A("5"));
    expect(policy2Data.srScr).to.equal(_A("330"));
    expect(policy2Data.jrCoc).to.equal(_A("0.102740"));
    expect(policy2Data.srCoc).to.equal(_A("7.86575"));
    expect(policy2Data.ensuroCommission).to.equal(_W("0"));

    // Policy with lossProb > bucket uses default
    const policy3Params = await defaultPolicyParams({ rmAddress: rm.target, lossProb: _W("0.2") });

    const signature3 = await makeSignedQuote(signer, policy3Params);
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

    await expect(rm.pushBucket(_W("0.10"), bucket10.asParams()))
      .to.emit(rm, "NewBucket")
      .withArgs(_W("0.10"), bucket10.asParams());

    await expect(rm.pushBucket(_W("0.15"), bucket15.asParams()))
      .to.emit(rm, "NewBucket")
      .withArgs(_W("0.15"), bucket15.asParams());

    // Policy with lossProb < 10 uses bucket10
    const policy1Params = await defaultPolicyParams({
      rmAddress: rm.target,
      lossProb: _W("0.055"),
      payout: _A("790"),
    });

    const signature1 = await makeSignedQuote(signer, policy1Params);
    const policy1Tx = await newPolicy(rm, cust, policy1Params, cust, signature1);

    const policy1Data = await getPolicyData(pool, policy1Tx);
    expect(policy1Data.moc).to.equal(bucket10.moc);
    expect(policy1Data.purePremium).to.equal(_A("43.45"));
    expect(policy1Data.jrScr).to.equal(_A("51.35"));
    expect(policy1Data.srScr).to.equal(_A("695.2"));
    expect(policy1Data.jrCoc).to.equal(_A("0.211027"));
    expect(policy1Data.srCoc).to.equal(_A("5.142573"));
    expect(policy1Data.ensuroCommission).to.equal(_A("0.541572"));
    expect(await rm.getMinimumPremium(policy1Params.payout, policy1Params.lossProb, policy1Params.expiration)).to.equal(
      _A("49.345172")
    );

    // Policy with lossProb = 10 uses bucket10
    const policy2Params = await defaultPolicyParams({
      rmAddress: rm.target,
      lossProb: _W("0.1"),
      payout: _A("930"),
    });

    const signature2 = await makeSignedQuote(signer, policy2Params);
    const policy2Tx = await newPolicy(rm, cust, policy2Params, cust, signature2);

    const policy2Data = await getPolicyData(pool, policy2Tx);
    expect(policy2Data.moc).to.equal(bucket10.moc);
    expect(policy2Data.purePremium).to.equal(_A("93"));
    expect(policy2Data.jrScr).to.equal(_A("18.6"));
    expect(policy2Data.srScr).to.equal(_A("818.4"));
    expect(policy2Data.jrCoc).to.equal(_A("0.076438"));
    expect(policy2Data.srCoc).to.equal(_A("6.053915"));
    expect(policy2Data.ensuroCommission).to.equal(_A("1.052607"));
    expect(await rm.getMinimumPremium(policy2Params.payout, policy2Params.lossProb, policy2Params.expiration)).to.equal(
      _A("100.18296")
    );

    // Policy with lossProb > 10 uses bucket15
    const policy3Params = await defaultPolicyParams({
      rmAddress: rm.target,
      lossProb: _W("0.101"),
    });

    const signature3 = await makeSignedQuote(signer, policy3Params);
    const policy3Tx = await newPolicy(rm, cust, policy3Params, cust, signature3);

    const policy3Data = await getPolicyData(pool, policy3Tx);
    expect(policy3Data.moc).to.equal(bucket15.moc);
    expect(policy3Data.purePremium).to.equal(_A("111.1"));
    expect(policy3Data.jrScr).to.equal(_A("58.9"));
    expect(policy3Data.srScr).to.equal(_A("330"));
    expect(policy3Data.jrCoc).to.equal(_A("1.210274"));
    expect(policy3Data.srCoc).to.equal(_A("7.865750"));
    expect(policy3Data.ensuroCommission).to.equal(_A("0"));
    expect(await rm.getMinimumPremium(policy3Params.payout, policy3Params.lossProb, policy3Params.expiration)).to.equal(
      _A("120.176024")
    );

    // Policy with lossProb > 15 uses defaults
    const policy4Params = await defaultPolicyParams({ rmAddress: rm.target, lossProb: _W("0.2") });

    const signature4 = await makeSignedQuote(signer, policy4Params);
    const policy4Tx = await newPolicy(rm, cust, policy4Params, cust, signature4);

    const policy4Data = await getPolicyData(pool, policy4Tx);
    expect(policy4Data.moc).to.equal(rmParams[RiskModuleParameter.moc]);
    expect(policy4Data.purePremium).to.equal(_A("200"));
    expect(policy4Data.jrScr).to.equal(_A("100"));
    expect(policy4Data.srScr).to.equal(_A("700"));
    expect(policy4Data.jrCoc).to.equal(_A("0.821917"));
    expect(policy4Data.srCoc).to.equal(_A("5.753422"));
    expect(policy4Data.ensuroCommission).to.equal(_W("0"));
    expect(await rm.getMinimumPremium(policy4Params.payout, policy4Params.lossProb, policy4Params.expiration)).to.equal(
      _A("206.575339")
    );
  });

  it("Only allows bucket insertion in the right order", async () => {
    const { rm } = await helpers.loadFixture(deployPoolFixture);

    const bucket5 = defaultBucketParams({});
    const bucket7 = defaultBucketParams({});
    const bucket10 = defaultBucketParams({});
    const bucket15 = defaultBucketParams({});

    await rm.pushBucket(_W("10"), bucket10.asParams());
    expect(await rm.buckets()).to.deep.equal([_W("10"), _W("0"), _W("0"), _W("0")]);

    await rm.pushBucket(_W("15"), bucket15.asParams());
    expect(await rm.buckets()).to.deep.equal([_W("10"), _W("15"), _W("0"), _W("0")]);

    await expect(rm.pushBucket(_W("5"), bucket5.asParams())).to.be.revertedWith(
      "lossProb <= last lossProb - reset instead"
    );

    await expect(rm.resetBuckets()).to.emit(rm, "BucketsReset");
    await rm.pushBucket(_W("5"), bucket5.asParams());
    await rm.pushBucket(_W("10"), bucket10.asParams());
    await rm.pushBucket(_W("15"), bucket15.asParams());

    expect(await rm.buckets()).to.deep.equal([_W("5"), _W("10"), _W("15"), _W("0")]);

    await expect(rm.resetBuckets()).to.emit(rm, "BucketsReset");
    await rm.pushBucket(_W("5"), bucket5.asParams());
    await rm.pushBucket(_W("7"), bucket7.asParams());
    await rm.pushBucket(_W("10"), bucket10.asParams());
    await rm.pushBucket(_W("15"), bucket15.asParams());
    expect(await rm.buckets()).to.deep.equal([_W("5"), _W("7"), _W("10"), _W("15")]);

    await expect(rm.pushBucket(_W("20"), bucket7.asParams())).to.be.revertedWith("No more than 4 buckets accepted");
  });

  it("Allows obtaining bucket parameters", async () => {
    const { rm } = await helpers.loadFixture(deployPoolFixture);
    const bucket = defaultBucketParams({});
    await rm.pushBucket(_W("0.1"), bucket);

    expect(await rm.bucketParams(_W("0.1"))).to.deep.equal(bucket.asParams());
  });

  it("Validates bucket parameters", async () => {
    const { rm } = await helpers.loadFixture(deployPoolFixture);

    await expect(rm.pushBucket(_W("0.1"), defaultBucketParams({ moc: _W("0.2") }).asParams())).to.be.revertedWith(
      "Validation: moc must be [0.5, 4]"
    );
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
