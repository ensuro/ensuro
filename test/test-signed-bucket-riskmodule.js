const { expect } = require("chai");
const {
  initCurrency,
  deployPool,
  deployPremiumsAccount,
  _W,
  addRiskModule,
  amountFunction,
  addEToken,
  getTransactionEvent,
  accessControlMessage,
  makeSignedQuote,
  makeBucketQuoteMessage,
  RiskModuleParameter,
  grantRole,
} = require("./test-utils");
const hre = require("hardhat");
const helpers = require("@nomicfoundation/hardhat-network-helpers");

describe("SignedBucketRiskModule contract tests", function () {
  let _A;
  let lp, cust, signer, resolver, level1, level2;

  beforeEach(async () => {
    [__, lp, cust, signer, resolver, level1, level2] = await hre.ethers.getSigners();

    _A = amountFunction(6);
  });

  async function deployPoolFixture() {
    const currency = await initCurrency(
      { name: "Test USDC", symbol: "USDC", decimals: 6, initial_supply: _A(30000) },
      [lp, cust],
      [_A(20000), _A(500)]
    );

    const pool = await deployPool(hre, {
      currency: currency.address,
      grantRoles: ["LEVEL1_ROLE", "LEVEL2_ROLE"],
      treasuryAddress: "0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199", // Random address
    });
    pool._A = _A;

    const accessManager = await hre.ethers.getContractAt("AccessManager", await pool.access());

    // Setup the liquidity sources
    const srEtk = await addEToken(pool, {});
    const jrEtk = await addEToken(pool, {});
    const premiumsAccount = await deployPremiumsAccount(hre, pool, {
      srEtkAddr: srEtk.address,
      jrEtkAddr: jrEtk.address,
    });

    // Provide some liquidity
    await currency.connect(lp).approve(pool.address, _A(15000));
    await pool.connect(lp).deposit(srEtk.address, _A(10000));
    await pool.connect(lp).deposit(jrEtk.address, _A(5000));

    // Customer approval
    await currency.connect(cust).approve(pool.address, _A(500));

    // Setup the risk module
    const SignedBucketRiskModule = await hre.ethers.getContractFactory("SignedBucketRiskModule");
    const rm = await addRiskModule(pool, premiumsAccount, SignedBucketRiskModule, {
      collRatio: "1.0",
      extraConstructorArgs: [true],
    });
    await rm.setParam(RiskModuleParameter.jrCollRatio, _W("0.3"));
    await rm.setParam(RiskModuleParameter.jrRoc, _W("0.1"));

    await accessManager.grantComponentRole(rm.address, await rm.PRICER_ROLE(), signer.address);
    await accessManager.grantComponentRole(rm.address, await rm.RESOLVER_ROLE(), resolver.address);
    return { srEtk, jrEtk, premiumsAccount, rm, pool, accessManager, currency };
  }

  async function defaultPolicyParams({
    rmAddress,
    payout,
    premium,
    lossProb,
    expiration,
    policyData,
    bucketId,
    validUntil,
  }) {
    const now = await helpers.time.latest();
    return {
      rmAddress,
      payout: payout || _A(1000),
      premium: premium || ethers.constants.MaxUint256,
      lossProb: lossProb || _W(0.1),
      expiration: expiration || now + 3600 * 24 * 30,
      policyData: policyData || hre.ethers.utils.hexlify(hre.ethers.utils.randomBytes(32)),
      bucketId: bucketId || 0,
      validUntil: validUntil || now + 3600 * 24 * 30,
    };
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
      signature._vs,
      policyParams.validUntil
    );
  }

  it("Uses the default parameters when no buckets are set up", async () => {
    const { rm, pool } = await helpers.loadFixture(deployPoolFixture);
    const policyParams = await defaultPolicyParams({ rmAddress: rm.address });
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
    await expect(rm.connect(level1).setBucketParams(1, bucketParameters({}))).to.be.revertedWith(
      accessControlMessage(level1.address, rm.address, "LEVEL2_ROLE")
    );
    await expect(rm.connect(level1).deleteBucket(1)).to.be.revertedWith(
      accessControlMessage(level1.address, rm.address, "LEVEL2_ROLE")
    );
    await grantRole(hre, accessManager, "LEVEL1_ROLE", level1.address);
    await expect(rm.connect(level1).setBucketParams(1, bucketParameters({}))).not.to.be.reverted;
    await expect(rm.connect(level1).deleteBucket(1)).not.to.be.reverted;

    // level2
    await expect(rm.connect(level2).setBucketParams(2, bucketParameters({}))).to.be.revertedWith(
      accessControlMessage(level2.address, rm.address, "LEVEL2_ROLE")
    );
    await expect(rm.connect(level2).deleteBucket(2)).to.be.revertedWith(
      accessControlMessage(level2.address, rm.address, "LEVEL2_ROLE")
    );
    await grantRole(hre, accessManager, "LEVEL2_ROLE", level2.address);
    await expect(rm.connect(level2).setBucketParams(2, bucketParameters({}))).not.to.be.reverted;
    await expect(rm.connect(level2).deleteBucket(2)).not.to.be.reverted;
  });

  it("Can't set of delete bucketId = 0", async () => {
    const { rm, accessManager } = await helpers.loadFixture(deployPoolFixture);

    await grantRole(hre, accessManager, "LEVEL1_ROLE", level1.address);
    await expect(rm.connect(level1).setBucketParams(0, bucketParameters({}))).to.be.revertedWith(
      "SignedBucketRiskModule: bucketId can't be zero, set default RM parameters"
    );
    await expect(rm.connect(level1).deleteBucket(0)).to.be.revertedWith(
      "SignedBucketRiskModule: bucketId can't be zero, set default RM parameters"
    );
  });

  it("Single bucket: uses correct bucket", async () => {
    const { rm, pool } = await helpers.loadFixture(deployPoolFixture);
    const rmParams = await rm.params();
    const bucket = bucketParameters({
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
    const policy1Params = await defaultPolicyParams({
      rmAddress: rm.address,
      bucketId: 1234,
      lossProb: _W("0.055"),
    });

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
    const policy2Params = await defaultPolicyParams({ rmAddress: rm.address, bucketId: 4321, lossProb: _W("0.15") });

    const signature2 = await makeSignedQuote(signer, policy2Params, makeBucketQuoteMessage);

    await expect(newPolicy(rm, cust, policy2Params, cust, signature2)).to.be.revertedWith(
      "SignedBucketRiskModule: bucket not found!"
    );

    // Policy with bucketId = 0 uses default
    const policy3Params = await defaultPolicyParams({ rmAddress: rm.address, bucketId: 0, lossProb: _W("0.2") });

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
    const bucket15 = bucketParameters({
      moc: _W("1.1"),
      jrCollRatio: _W("0.17"),
      collRatio: _W("0.5"),
      ensuroPpFee: rmParams[RiskModuleParameter.ensuroPpFee],
      ensuroCocFee: rmParams[RiskModuleParameter.ensuroCocFee],
      jrRoc: _W("0.25"),
      srRoc: _W("0.29"),
    });

    const bucket10 = bucketParameters({
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
    const policy1Params = await defaultPolicyParams({
      rmAddress: rm.address,
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
    const policy2Params = await defaultPolicyParams({
      rmAddress: rm.address,
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
    const policy3Params = await defaultPolicyParams({
      rmAddress: rm.address,
      bucketId: 15,
      lossProb: _W("0.101"),
    });

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
    const policy4Params = await defaultPolicyParams({ rmAddress: rm.address, lossProb: _W("0.2") });

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
    bucket = bucketParameters({});
    await rm.setBucketParams(1, bucket);

    expect(await rm.bucketParams(1)).to.deep.equal(bucket.asParams());
    await expect(rm.deleteBucket(1)).to.emit(rm, "BucketDeleted").withArgs(1);
    await expect(rm.bucketParams(1)).to.be.revertedWith("SignedBucketRiskModule: bucket not found!");
  });

  it("Validates bucket parameters", async () => {
    const { rm } = await helpers.loadFixture(deployPoolFixture);

    await expect(rm.setBucketParams(1, bucketParameters({ moc: _W("0.2") }).asParams())).to.be.revertedWith(
      "Validation: moc must be [0.5, 4]"
    );
  });
});

function bucketParameters({ moc, jrCollRatio, collRatio, ensuroPpFee, ensuroCocFee, jrRoc, srRoc }) {
  return {
    moc: moc || _W("1.1"),
    jrCollRatio: jrCollRatio || _W("0.1"),
    collRatio: collRatio || _W("0.2"),
    ensuroPpFee: ensuroPpFee || _W("0.05"),
    ensuroCocFee: ensuroCocFee || _W("0.2"),
    jrRoc: jrRoc || _W("0.1"),
    srRoc: srRoc || _W("0.2"),
    asParams: function () {
      return [this.moc, this.jrCollRatio, this.collRatio, this.ensuroPpFee, this.ensuroCocFee, this.jrRoc, this.srRoc];
    },
  };
}

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
  ret.moc = ret.purePremium.mul(_W("1")).div(ret.payout.mul(ret.lossProb).div(_W("1")));

  return ret;
}
