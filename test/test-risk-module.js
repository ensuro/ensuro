const { expect } = require("chai");
const { ethers } = require("hardhat");
const { MaxUint256, ZeroAddress } = require("ethers");
const {
  defaultTestParams,
  getPremium,
  makeFTUWInputData,
  makeAndSignFTUWInputData,
  makeFTUWReplacementInputData,
  makeFTUWCancelInputData,
  makeHashSelector,
} = require("../js/utils");
const helpers = require("@nomicfoundation/hardhat-network-helpers");
const {
  amountFunction,
  _W,
  getTransactionEvent,
  captureAny,
  getAddress,
  newCaptureAny,
  getAccessManagerRole,
} = require("@ensuro/utils/js/utils");
const { HOUR } = require("@ensuro/utils/js/constants");
const { initCurrency } = require("@ensuro/utils/js/test-utils");
const { deployPool, deployPremiumsAccount, addRiskModule, addEToken } = require("../js/test-utils");
const { getAccessManager } = require("@ensuro/access-managed-proxy/js/deployProxy");

const _A = amountFunction(6);

function makeInputData({ payout, premium, lossProb, expiration, internalId, params, signer }) {
  return (signer === undefined ? makeFTUWInputData : makeAndSignFTUWInputData)({
    payout: payout || _A(1000),
    premium: premium || _A(200),
    lossProb: lossProb || _W("0.10"),
    expiration,
    internalId: internalId || 123,
    params: defaultTestParams(params || {}),
    signer,
  });
}

async function makeReplacementInputData({ oldPolicy, payout, premium, lossProb, expiration, internalId, params }) {
  return makeFTUWReplacementInputData({
    oldPolicy,
    payout: payout || oldPolicy.payout,
    premium: premium || getPremium(oldPolicy),
    lossProb: lossProb || oldPolicy.lossProb,
    expiration: expiration || oldPolicy.expiration,
    internalId: internalId || 1234,
    params: defaultTestParams(params || {}),
  });
}

async function makeCancelInputData({ policyToCancel, purePremiumRefund, jrCocRefund, srCocRefund }) {
  return makeFTUWCancelInputData({
    policyToCancel,
    purePremiumRefund: purePremiumRefund || policyToCancel.purePremium,
    jrCocRefund: jrCocRefund === undefined ? MaxUint256 : jrCocRefund,
    srCocRefund: srCocRefund === undefined ? MaxUint256 : srCocRefund,
  });
}

describe("RiskModule contract", function () {
  let backend, cust, lp, owner;

  beforeEach(async () => {
    [, lp, cust, backend, owner] = await ethers.getSigners();
  });

  async function deployPoolFixture() {
    const currency = await initCurrency(
      { name: "Test USDC", symbol: "USDC", decimals: 6, initial_supply: _A(10000) },
      [lp, cust, backend],
      [_A(5000), _A(500), _A(1000)]
    );

    const pool = await deployPool({
      currency: currency,
      treasuryAddress: "0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199", // Random address
    });
    pool._A = _A;

    return { pool, currency };
  }

  async function deployRiskModuleFixture() {
    const { pool, currency } = await helpers.loadFixture(deployPoolFixture);
    // Setup the liquidity sources
    const etk = await addEToken(pool, {});
    const premiumsAccount = await deployPremiumsAccount(pool, { srEtk: etk });

    await currency.connect(lp).approve(pool, _A(5000));
    await pool.connect(lp).deposit(etk, _A(5000), lp);

    const FullTrustedUW = await hre.ethers.getContractFactory("FullTrustedUW");
    const uw = await FullTrustedUW.deploy();
    // Setup the risk module
    const rm = await addRiskModule(pool, premiumsAccount, {
      underwriter: uw,
      extraArgs: [],
    });
    const now = await helpers.time.latest();

    return { etk, premiumsAccount, rm, pool, currency, FullTrustedUW, uw, now };
  }

  async function deployRmWithPolicyFixture() {
    const { rm, pool, currency, premiumsAccount, now } = await helpers.loadFixture(deployRiskModuleFixture);

    // Deploy a new policy
    await currency.connect(backend).approve(pool, _A(110));

    const tx = await rm.connect(backend).newPolicy(
      makeInputData({
        payout: _A(1000),
        premium: _A(20),
        lossProb: _W("0.01"),
        expiration: now + HOUR * 5,
        internalId: 123,
      }),
      cust
    );

    const receipt = await tx.wait();

    // Try to resolve it without going through the riskModule
    const newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");

    return { policy: newPolicyEvt.args.policy, receipt, rm, currency, pool, premiumsAccount, now };
  }

  it("It can change the partner wallet", async () => {
    const { rm } = await helpers.loadFixture(deployRiskModuleFixture);

    await expect(rm.setWallet(ZeroAddress)).to.be.revertedWithCustomError(rm, "InvalidWallet").withArgs(ZeroAddress);
    const oldWallet = await rm.wallet();
    const newWallet = "0x69F5C4D08F6bC8cD29fE5f004d46FB566270868d";
    await expect(rm.setWallet(newWallet)).to.emit(rm, "PartnerWalletChanged").withArgs(oldWallet, newWallet);
  });

  it("It can change the underwriter", async () => {
    const { rm, uw, FullTrustedUW } = await helpers.loadFixture(deployRiskModuleFixture);

    await expect(rm.setUnderwriter(ZeroAddress))
      .to.be.revertedWithCustomError(rm, "InvalidUnderwriter")
      .withArgs(ZeroAddress);
    expect(await rm.underwriter()).to.equal(getAddress(uw));
    const newUW = await FullTrustedUW.deploy();
    await expect(rm.setUnderwriter(newUW)).to.emit(rm, "UnderwriterChanged").withArgs(uw, newUW);
  });

  it("The payer is always the caller and fails with ERC20 error if spending not approved", async () => {
    const { pool, rm, currency, now } = await helpers.loadFixture(deployRiskModuleFixture);

    // The customer approved the spending for the pool
    await currency.connect(cust).approve(pool, _A(110));

    await expect(rm.connect(backend).newPolicy(makeInputData({ expiration: now + HOUR * 5 }), cust))
      .to.be.revertedWithCustomError(currency, "ERC20InsufficientAllowance")
      .withArgs(pool, 0, _A(100)); // 100 = Pure Premium

    expect(await currency.balanceOf(cust)).to.equal(_A(500));
    expect(await currency.balanceOf(backend)).to.equal(_A(1000));
  });

  it("Does not allow wallet with zero address", async () => {
    const { pool, premiumsAccount } = await helpers.loadFixture(deployRiskModuleFixture);
    const RiskModule = await ethers.getContractFactory("RiskModule");
    await expect(
      addRiskModule(pool, premiumsAccount, {
        wallet: ZeroAddress,
        extraArgs: [],
      })
    )
      .to.be.revertedWithCustomError(RiskModule, "InvalidWallet")
      .withArgs(ZeroAddress);
  });

  it("If MaxUint256 is sent as premium, it's created with minimum premium", async () => {
    const { pool, rm, currency, now } = await helpers.loadFixture(deployRiskModuleFixture);

    // The customer approved the spending for the pool
    await currency.connect(backend).approve(pool, _A(110));

    await expect(
      rm.connect(backend).newPolicy(makeInputData({ expiration: now + HOUR * 5, premium: MaxUint256 }), cust)
    )
      .to.emit(pool, "NewPolicy")
      .withArgs(rm, captureAny.value);

    const createdPolicy = captureAny.lastValue;
    expect(createdPolicy.partnerCommission).to.equal(0);
    expect(getPremium(createdPolicy)).not.to.equal(createdPolicy.purePremium);
    expect(getPremium(createdPolicy)).to.equal(
      createdPolicy.purePremium + createdPolicy.srCoc + createdPolicy.jrCoc + createdPolicy.ensuroCommission
    );
  });

  it("Can create several policies with a single call", async () => {
    const { pool, rm, currency, now } = await helpers.loadFixture(deployRiskModuleFixture);

    await pool.setExposureLimit(rm, _A(11000));
    // The customer approved the spending for the pool
    await currency.connect(backend).approve(pool, _A(110 * 5));

    const inputData = [...Array(5)].map((_, i) =>
      makeInputData({ expiration: now + HOUR * 5, premium: MaxUint256, internalId: 200 + i })
    );

    const capturePolicies = [...Array(5)].map(() => newCaptureAny());

    await expect(rm.connect(backend).newPolicies(inputData, cust))
      .to.emit(pool, "NewPolicy")
      .withArgs(rm, capturePolicies[0].value)
      .to.emit(pool, "NewPolicy")
      .withArgs(rm, capturePolicies[1].value)
      .to.emit(pool, "NewPolicy")
      .withArgs(rm, capturePolicies[2].value)
      .to.emit(pool, "NewPolicy")
      .withArgs(rm, capturePolicies[3].value)
      .to.emit(pool, "NewPolicy")
      .withArgs(rm, capturePolicies[4].value);

    for (const capturedPolicy of capturePolicies) {
      const createdPolicy = capturedPolicy.lastValue;
      expect(createdPolicy.partnerCommission).to.equal(0);
      expect(getPremium(createdPolicy)).not.to.equal(createdPolicy.purePremium);
      expect(getPremium(createdPolicy)).to.equal(
        createdPolicy.purePremium + createdPolicy.srCoc + createdPolicy.jrCoc + createdPolicy.ensuroCommission
      );
    }
  });

  it("Can create a lot of policies with a single call", async () => {
    const { pool, rm, currency, now } = await helpers.loadFixture(deployRiskModuleFixture);

    await pool.setExposureLimit(rm, _A(11000));
    // The customer approved the spending for the pool
    await currency.connect(backend).approve(pool, _A(110 * 50));

    const inputData = [...Array(50)].map((_, i) =>
      makeInputData({ expiration: now + HOUR * 5, premium: MaxUint256, internalId: 200 + i, payout: _A(100) })
    );

    await expect(rm.connect(backend).newPolicies(inputData, cust)).to.emit(pool, "NewPolicy");
  });

  it("Can create policies using FullSignedUW", async () => {
    const { pool, rm, currency, now, uw } = await helpers.loadFixture(deployRiskModuleFixture);

    const FullSignedUW = await ethers.getContractFactory("FullSignedUW");
    const newUW = await FullSignedUW.deploy();
    await expect(rm.setUnderwriter(newUW)).to.emit(rm, "UnderwriterChanged").withArgs(uw, newUW);

    const acMgr = await getAccessManager(pool);
    const FULL_NEW_POLICY_SIGNER = getAccessManagerRole("FULL_NEW_POLICY_SIGNER");
    const operationSelector = makeHashSelector("FULL_PRICE_NEW_POLICY");

    // The customer approved the spending for the pool
    await currency.connect(backend).approve(pool, _A(110));

    await expect(
      rm
        .connect(backend)
        .newPolicy(makeInputData({ expiration: now + HOUR * 5, premium: MaxUint256, signer: backend }), cust)
    )
      .to.revertedWithCustomError(newUW, "UnauthorizedSigner")
      .withArgs(backend, operationSelector);

    await acMgr.setTargetFunctionRole(rm, [operationSelector], FULL_NEW_POLICY_SIGNER);
    await acMgr.grantRole(FULL_NEW_POLICY_SIGNER, backend, 0);

    await expect(
      rm
        .connect(backend)
        .newPolicy(makeInputData({ expiration: now + HOUR * 5, premium: MaxUint256, signer: backend }), cust)
    )
      .to.emit(pool, "NewPolicy")
      .withArgs(rm, captureAny.value);

    const createdPolicy = captureAny.lastValue;
    expect(createdPolicy.partnerCommission).to.equal(0);
    expect(getPremium(createdPolicy)).not.to.equal(createdPolicy.purePremium);
    expect(getPremium(createdPolicy)).to.equal(
      createdPolicy.purePremium + createdPolicy.srCoc + createdPolicy.jrCoc + createdPolicy.ensuroCommission
    );
  });

  it("Fails if expiration is in the past", async () => {
    const { rm, now } = await helpers.loadFixture(deployRiskModuleFixture);

    await expect(rm.connect(backend).newPolicy(makeInputData({ expiration: now - HOUR }), cust))
      .to.be.revertedWithCustomError(rm, "ExpirationMustBeInTheFuture")
      .withArgs(now - HOUR, captureAny.uint);
    expect(captureAny.lastUint).to.closeTo(now, 600n);
  });

  it("Fails if customer is ZeroAddress", async () => {
    const { rm, now } = await helpers.loadFixture(deployRiskModuleFixture);

    await expect(rm.connect(backend).newPolicy(makeInputData({ expiration: now + HOUR }), ZeroAddress))
      .to.be.revertedWithCustomError(rm, "InvalidCustomer")
      .withArgs(ZeroAddress);
  });

  it("Does not allow another payer - Even with old allowances", async () => {
    const { pool, rm, currency, now } = await helpers.loadFixture(deployRiskModuleFixture);

    // Leaving this test to underline the 2.x behaviour where the customer could be the payer
    // by doing an allowance to the caller is no longer supported

    // The customer approved the spending for the pool
    await currency.connect(cust).approve(pool, _A(110));

    // And also allowed the backend
    await currency.connect(cust).approve(backend, _A(110));

    await expect(rm.connect(backend).newPolicy(makeInputData({ expiration: now + HOUR * 5 }), cust))
      .to.be.revertedWithCustomError(currency, "ERC20InsufficientAllowance")
      .withArgs(pool, _A(0), _A(100));
  });

  it("Reverts if new policy is lower than previous", async () => {
    const { policy, rm, pool } = await helpers.loadFixture(deployRmWithPolicyFixture);

    // Old Policy: { payout= 1000, premium = 10, expiration= now + 3600 + 5}
    await expect(
      rm.replacePolicy(
        makeReplacementInputData({
          oldPolicy: policy,
          payout: _A(999),
          internalId: 1234,
        })
      )
    )
      .to.be.revertedWithCustomError(pool, "InvalidPolicyReplacement")
      .withArgs(policy, captureAny.value);
    expect(captureAny.lastValue[1]).to.equal(_A(999));

    await expect(
      rm.connect(backend).replacePolicy(
        makeReplacementInputData({
          oldPolicy: policy,
          premium: _A(19),
          internalId: 1234,
        })
      )
    )
      .to.be.revertedWithCustomError(pool, "InvalidPolicyReplacement")
      .withArgs(policy, captureAny.value);

    await expect(
      rm.connect(backend).replacePolicy(
        makeReplacementInputData({
          oldPolicy: policy,
          expiration: policy.expiration - 3600n,
          internalId: 1234,
        })
      )
    ).to.be.revertedWithCustomError(pool, "InvalidPolicyReplacement");
  });

  it("It reverts if the replacement premium >= payout", async () => {
    const { policy, rm } = await helpers.loadFixture(deployRmWithPolicyFixture);

    await expect(
      rm.connect(backend).replacePolicy(
        makeReplacementInputData({
          oldPolicy: policy,
          payout: _A(100),
          premium: _A(101),
          internalId: 1234,
        })
      )
    )
      .to.be.revertedWithCustomError(rm, "PremiumExceedsPayout")
      .withArgs(_A(101), _A(100));
  });

  it("Reverts if new policy is lower than previous with premium == MaxUint256", async () => {
    const { policy, rm, pool } = await helpers.loadFixture(deployRmWithPolicyFixture);

    const minPremium = await rm.getMinimumPremium(
      policy.payout,
      policy.lossProb,
      policy.start,
      policy.expiration,
      defaultTestParams({}).asParams()
    );
    expect(minPremium < getPremium(policy)).to.be.true;
    await expect(
      rm.connect(backend).replacePolicy(
        makeReplacementInputData({
          oldPolicy: policy,
          premium: MaxUint256,
          internalId: 1234,
        })
      )
    )
      .to.be.revertedWithCustomError(pool, "InvalidPolicyReplacement")
      .withArgs(policy, captureAny.value);
  });

  it("Reverts if new policy has expiration in the past", async () => {
    const { policy, rm, now } = await helpers.loadFixture(deployRmWithPolicyFixture);

    await expect(
      rm.connect(backend).replacePolicy(
        makeReplacementInputData({
          oldPolicy: policy,
          expiration: now - HOUR,
          internalId: 1234,
        })
      )
    )
      .to.be.revertedWithCustomError(rm, "ExpirationMustBeInTheFuture")
      .withArgs(now - HOUR, captureAny.uint);
    expect(captureAny.lastUint).to.closeTo(now, 600);
  });

  it("It reverts if _activeExposure > exposureLimit", async () => {
    const { policy, rm, pool, currency } = await helpers.loadFixture(deployRmWithPolicyFixture);

    expect(await pool.getExposure(rm)).to.be.deep.equal([_A(1000), _A(1000000)]);
    await pool.setExposureLimit(rm, _A(1100));
    expect(await pool.getExposure(rm)).to.be.deep.equal([_A(1000), _A(1100)]);

    await currency.connect(backend).approve(pool, _A(200));

    await expect(
      rm.connect(backend).replacePolicy(
        makeReplacementInputData({
          oldPolicy: policy,
          payout: _A(2000),
          premium: _A(200),
          internalId: 1234,
        })
      )
    )
      .to.be.revertedWithCustomError(pool, "ExposureLimitExceeded")
      .withArgs(_A(2000), _A(1100));
  });

  it("Rejects replace policy if the pool is paused", async () => {
    const { policy, rm, pool } = await helpers.loadFixture(deployRmWithPolicyFixture);

    await expect(pool.connect(owner).pause()).to.emit(pool, "Paused");

    await expect(
      rm.connect(backend).replacePolicy(
        makeReplacementInputData({
          oldPolicy: policy,
          internalId: 1234,
        })
      )
    ).to.be.revertedWithCustomError(pool, "EnforcedPause");
  });

  it("Should emit PolicyReplaced when policy is replaced", async () => {
    const { policy, rm, pool } = await helpers.loadFixture(deployRmWithPolicyFixture);

    await expect(
      rm.connect(backend).replacePolicy(
        makeReplacementInputData({
          oldPolicy: policy,
        })
      )
    )
      .to.emit(pool, "NewPolicy")
      .to.emit(pool, "PolicyReplaced")
      .withArgs(rm, policy.id, policy.id - 123n + 1234n);
  });

  it("It can cancel a policy with pure premium and non accrued CoC", async () => {
    const { policy, rm, pool, currency } = await helpers.loadFixture(deployRmWithPolicyFixture);

    const srCocRefund = newCaptureAny();

    await helpers.time.increase(3 * HOUR);

    const balanceBefore = await currency.balanceOf(cust);

    await expect(
      rm.connect(backend).cancelPolicy(
        makeCancelInputData({
          policyToCancel: policy,
        })
      )
    )
      .to.emit(pool, "PolicyCancelled")
      .withArgs(rm, policy.id, policy.purePremium, _A(0), srCocRefund.uint);

    expect(srCocRefund.lastUint).to.closeTo((policy.srCoc * 2n) / 5n, 20n); // 2/5 of srCoc refunded
    expect(await currency.balanceOf(cust)).to.equal(balanceBefore + policy.purePremium + srCocRefund.lastUint);
  });

  it("It can cancel a policy with pure premium and custom CoC", async () => {
    const { policy, rm, pool, currency } = await helpers.loadFixture(deployRmWithPolicyFixture);

    await helpers.time.increase(3 * HOUR);

    const balanceBefore = await currency.balanceOf(cust);

    const srCocRefund = (policy.srCoc * 4n) / 5n;

    await expect(
      rm.connect(backend).cancelPolicy(
        makeCancelInputData({
          policyToCancel: policy,
          srCocRefund,
          jrCocRefund: 0n,
        })
      )
    )
      .to.emit(pool, "PolicyCancelled")
      .withArgs(rm, policy.id, policy.purePremium, _A(0), srCocRefund);

    expect(await currency.balanceOf(cust)).to.equal(balanceBefore + policy.purePremium + srCocRefund);
  });
});
