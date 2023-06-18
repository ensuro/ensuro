const { expect } = require("chai");
const _ = require("lodash");
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
  makeQuoteMessage,
  RiskModuleParameter,
} = require("./test-utils");
const hre = require("hardhat");
const helpers = require("@nomicfoundation/hardhat-network-helpers");

const SECONDS_PER_YEAR = 3600 * 24 * 365;

describe("TieredSignedQuoteRiskModule contract tests", function () {
  let _A;
  let lp, cust, signer, resolver, anon;

  beforeEach(async () => {
    [__, lp, cust, signer, resolver, anon] = await hre.ethers.getSigners();

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
    const TieredSignedQuoteRiskModule = await hre.ethers.getContractFactory("TieredSignedQuoteRiskModule");
    const rm = await addRiskModule(pool, premiumsAccount, TieredSignedQuoteRiskModule, {
      collRatio: "1.0",
      extraConstructorArgs: [true],
    });
    await rm.setParam(RiskModuleParameter.jrCollRatio, _W("0.3"));
    await rm.setParam(RiskModuleParameter.jrRoc, _W("0.1"));

    await accessManager.grantComponentRole(rm.address, await rm.PRICER_ROLE(), signer.address);
    await accessManager.grantComponentRole(rm.address, await rm.RESOLVER_ROLE(), resolver.address);
    return { srEtk, jrEtk, premiumsAccount, rm, pool, accessManager, currency };
  }

  async function defaultPolicyParams({ rmAddress, payout, premium, lossProb, expiration, policyData, validUntil }) {
    const now = await helpers.time.latest();
    return {
      rmAddress,
      payout: payout || _A(1000),
      premium: premium || ethers.constants.MaxUint256,
      lossProb: lossProb || _W(0.1),
      expiration: expiration || now + 3600 * 24 * 30,
      policyData: policyData || hre.ethers.utils.hexlify(hre.ethers.utils.randomBytes(32)),
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
      signature.r,
      signature._vs,
      policyParams.validUntil
    );
  }

  // Following 2 test cases copied from test-signed-quote-riskmodule.js as a sanity check during WIP
  // TODO: remove these 2 test cases and make test-signed-quote-riskmodule.js run all tests in both contracts
  it("Creates a policy if the right signature is provided", async () => {
    const { rm, pool, currency } = await helpers.loadFixture(deployPoolFixture);
    const policyParams = await defaultPolicyParams({ rmAddress: rm.address });
    const signature = await makeSignedQuote(signer, policyParams);
    const tx = await newPolicy(rm, cust, policyParams, cust, signature);
    const receipt = await tx.wait();
    const newSignedPolicyEvt = getTransactionEvent(rm.interface, receipt, "NewSignedPolicy");
    const policyData = policyParams.policyData;
    // Verify the event is emited and the last 96 bits of the policyData are used as internalId
    const policyId = newSignedPolicyEvt.args[0];
    const twoPow96 = ethers.BigNumber.from(2).pow(96);
    const internalId = policyId.mod(twoPow96);
    expect(internalId).to.be.equal(ethers.BigNumber.from(policyData).mod(twoPow96));
    // The first 160 bits of policyId is the module address
    expect(policyId.div(twoPow96)).to.be.equal(ethers.BigNumber.from(rm.address));
    // The second parameter is the policyData itself
    expect(newSignedPolicyEvt.args[1]).to.be.equal(policyData);

    const newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");

    // Tests resolution, only by an authorized role
    await expect(rm.connect(anon).resolvePolicy(newPolicyEvt.args[1], policyParams.payout)).to.be.revertedWith(
      accessControlMessage(anon.address, rm.address, "RESOLVER_ROLE")
    );

    await expect(() =>
      rm.connect(resolver).resolvePolicy(newPolicyEvt.args[1], policyParams.payout)
    ).to.changeTokenBalance(currency, cust, policyParams.payout);
  });

  it("Rejects a policy if signed by unauthorized user", async () => {
    const { rm } = await helpers.loadFixture(deployPoolFixture);
    const policyParams = await defaultPolicyParams({ rmAddress: rm.address });
    const signature = await makeSignedQuote(anon, policyParams);
    await expect(newPolicy(rm, cust, policyParams, cust, signature)).to.be.revertedWith(
      accessControlMessage(anon.address, rm.address, "PRICER_ROLE")
    );
  });
  // END copied test cases

  it("Uses the default parameters when no buckets are set up", async () => {
    const { rm, pool, currency } = await helpers.loadFixture(deployPoolFixture);
    const policyParams = await defaultPolicyParams({ rmAddress: rm.address });
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

  it("Single bucket: uses correct bucket", async () => {
    const { rm, pool, currency } = await helpers.loadFixture(deployPoolFixture);
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

    await expect(rm.setBucket(_W("0.15"), bucket.asParams()))
      .to.emit(rm, "NewBucket")
      .withArgs(_W("0.15"), bucket.asParams());

    // Policy with lossProb < bucket uses bucket
    const policy1Params = await defaultPolicyParams({ rmAddress: rm.address, lossProb: _W("0.055") });

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
    const policy2Params = await defaultPolicyParams({ rmAddress: rm.address, lossProb: _W("0.15") });

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
    const policy3Params = await defaultPolicyParams({ rmAddress: rm.address, lossProb: _W("0.2") });

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
