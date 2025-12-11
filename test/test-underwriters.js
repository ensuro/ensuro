const { expect } = require("chai");
const hre = require("hardhat");
const helpers = require("@nomicfoundation/hardhat-network-helpers");

const { amountFunction, _W, getAccessManagerRole } = require("@ensuro/utils/js/utils");
const { DAY } = require("@ensuro/utils/js/constants");
const { initCurrency } = require("@ensuro/utils/js/test-utils");
const { getAccessManager } = require("@ensuro/access-managed-proxy/js/deployProxy");
const { addEToken, deployPool, deployPremiumsAccount, addRiskModule } = require("../js/test-utils");
const {
  makeFTUWInputData,
  defaultBucketParams,
  makeFTUWReplacementInputData,
  makeFTUWCancelInputData,
  makeHashSelector,
  makeAndSignFTUWCancelInputData,
  makeFSUWInputData,
  makeAndSignFSUWInputData,
  makeAndSignFSUWReplacementInputData,
  makeFSUWReplacementInputData,
  makePolicyId,
} = require("../js/utils");
const { ethers } = hre;

const _A = amountFunction(6);
const { ZeroAddress, MaxUint256 } = hre.ethers;
const SIGNATURE_SIZE = 65;

async function fullTrustedUWFixture() {
  const FullTrustedUW = await hre.ethers.getContractFactory("FullTrustedUW");
  const uw = await FullTrustedUW.deploy();

  return { uw };
}

async function fullSignedUWFixture() {
  const [owner, other, signer] = await hre.ethers.getSigners();
  const currency = await initCurrency(
    { name: "Test USDC", symbol: "USDC", decimals: 6, initial_supply: _A(10000) },
    [owner],
    [_A(5000)]
  );

  const pool = await deployPool({
    currency: currency,
    treasuryAddress: await ethers.resolveAddress(other),
  });
  pool._A = _A;

  const srEtk = await addEToken(pool, {});
  const premiumsAccount = await deployPremiumsAccount(pool, { srEtk });
  const FullSignedUW = await hre.ethers.getContractFactory("FullSignedUW");
  const uw = await FullSignedUW.deploy();

  const rm = await addRiskModule(pool, premiumsAccount, {
    underwriter: uw,
    extraArgs: [],
  });

  const acMgr = await getAccessManager(pool);
  return { uw, owner, rm, acMgr, other, signer };
}

function randint(max) {
  return Math.floor(Math.random() * max);
}

function randAmount(max = 1000) {
  return _A(randint(max));
}

function randWad(add = 0) {
  return _W(add + randint(1000) / 1000);
}

function makeRandomPriceNewInput() {
  return {
    payout: randAmount(),
    premium: randAmount(),
    lossProb: randWad(),
    expiration: 1762978903 + randint(1000),
    internalId: randint(1000),
    params: defaultBucketParams({
      moc: randWad(1),
      jrCollRatio: randWad(),
      collRatio: randWad(),
      ensuroPpFee: randWad(),
      ensuroCocFee: randWad(),
      jrRoc: randWad(),
      srRoc: randWad(),
    }),
  };
}

function makeRandomPolicy(rm = ZeroAddress) {
  return {
    id: makePolicyId(rm, randint(100000000)),
    payout: randAmount(),
    jrScr: randAmount(),
    srScr: randAmount(),
    lossProb: randWad(),
    purePremium: randAmount(),
    ensuroCommission: randAmount(),
    partnerCommission: randAmount(),
    jrCoc: randAmount(),
    srCoc: randAmount(),
    start: 1762978903 + randint(1000),
    expiration: 1762978903 + randint(1000),
    asParams: function () {
      return [
        this.id,
        this.payout,
        this.jrScr,
        this.srScr,
        this.lossProb,
        this.purePremium,
        this.ensuroCommission,
        this.partnerCommission,
        this.jrCoc,
        this.srCoc,
        this.start,
        this.expiration,
      ];
    },
  };
}

function makeRandomPriceReplaceInput(rm = ZeroAddress) {
  return {
    oldPolicy: makeRandomPolicy(rm).asParams(),
    ...makeRandomPriceNewInput(),
  };
}

function makeRandomPriceCancellationInput() {
  return {
    policyToCancel: makeRandomPolicy().asParams(),
    purePremiumRefund: randAmount(),
    jrCocRefund: randAmount(),
    srCocRefund: randAmount(),
  };
}

describe("FullTrustedUW", () => {
  it("Checks it decodes the same input for priceNewPolicy", async () => {
    const { uw } = await helpers.loadFixture(fullTrustedUWFixture);

    for (let i = 0; i < 100; i++) {
      const input = makeRandomPriceNewInput();
      const output = await uw.priceNewPolicy(ZeroAddress, makeFTUWInputData(input));
      expect(output.length).to.equal(6);
      expect(output[0]).to.equal(input.payout);
      expect(output[1]).to.equal(input.premium);
      expect(output[2]).to.equal(input.lossProb);
      expect(output[3]).to.equal(input.expiration);
      expect(output[4]).to.equal(input.internalId);
      expect(output[5]).to.deep.equal(input.params.asParams());
    }
  });

  it("Checks it decodes the same input for pricePolicyReplacement", async () => {
    const { uw } = await helpers.loadFixture(fullTrustedUWFixture);

    for (let i = 0; i < 100; i++) {
      const input = makeRandomPriceReplaceInput();
      const output = await uw.pricePolicyReplacement(ZeroAddress, makeFTUWReplacementInputData(input));
      expect(output.length).to.equal(7);
      expect(output[0]).to.deep.equal(input.oldPolicy);
      expect(output[1]).to.equal(input.payout);
      expect(output[2]).to.equal(input.premium);
      expect(output[3]).to.equal(input.lossProb);
      expect(output[4]).to.equal(input.expiration);
      expect(output[5]).to.equal(input.internalId);
      expect(output[6]).to.deep.equal(input.params.asParams());
    }
  });

  it("Checks it decodes the same input for pricePolicyCancellation", async () => {
    const { uw } = await helpers.loadFixture(fullTrustedUWFixture);

    for (let i = 0; i < 100; i++) {
      const input = makeRandomPriceCancellationInput();
      const output = await uw.pricePolicyCancellation(ZeroAddress, makeFTUWCancelInputData(input));
      expect(output.length).to.equal(4);
      expect(output[0]).to.deep.equal(input.policyToCancel);
      expect(output[1]).to.equal(input.purePremiumRefund);
      expect(output[2]).to.equal(input.jrCocRefund);
      expect(output[3]).to.equal(input.srCocRefund);
    }
  });

  it("Checks pricePolicyCancellation extracts the accrued interest when receices MaxUint256", async () => {
    const { uw } = await helpers.loadFixture(fullTrustedUWFixture);
    const now = await helpers.time.latest();

    for (let i = 0; i < 10; i++) {
      const input = makeRandomPriceCancellationInput();
      input.policyToCancel[10] = now - DAY;
      input.policyToCancel[11] = now + 9 * DAY;
      input.jrCocRefund = MaxUint256;
      const output = await uw.pricePolicyCancellation(ZeroAddress, makeFTUWCancelInputData(input));
      expect(output.length).to.equal(4);
      expect(output[0]).to.deep.equal(input.policyToCancel);
      expect(output[1]).to.equal(input.purePremiumRefund);
      expect(output[2]).not.to.equal(input.jrCocRefund);
      expect(output[2]).to.closeTo((input.policyToCancel[8] * 9n) / 10n, 100n);
      expect(output[3]).to.equal(input.srCocRefund);
    }

    for (let i = 0; i < 10; i++) {
      const input = makeRandomPriceCancellationInput();
      input.policyToCancel[10] = now - DAY;
      input.policyToCancel[11] = now + 9 * DAY;
      input.srCocRefund = MaxUint256;
      const output = await uw.pricePolicyCancellation(ZeroAddress, makeFTUWCancelInputData(input));
      expect(output.length).to.equal(4);
      expect(output[0]).to.deep.equal(input.policyToCancel);
      expect(output[1]).to.equal(input.purePremiumRefund);
      expect(output[2]).to.equal(input.jrCocRefund);
      expect(output[3]).not.to.equal(input.srCocRefund);
      expect(output[3]).to.closeTo((input.policyToCancel[9] * 9n) / 10n, 100n);
    }
  });
});

describe("FullSignedUW", () => {
  it("Checks it decodes the same input for priceNewPolicy", async () => {
    const { uw, acMgr, rm, signer, other } = await helpers.loadFixture(fullSignedUWFixture);

    const FULL_NEW_POLICY_SIGNER = getAccessManagerRole("FULL_NEW_POLICY_SIGNER");
    const operationSelector = makeHashSelector("FULL_PRICE_NEW_POLICY");

    await acMgr.setTargetFunctionRole(rm, [operationSelector], FULL_NEW_POLICY_SIGNER);
    await acMgr.grantRole(FULL_NEW_POLICY_SIGNER, signer, 0);

    for (let i = 0; i < 5; i++) {
      const input = makeRandomPriceNewInput();

      // Send wrong input
      await expect(uw.priceNewPolicy(ZeroAddress, makeFSUWInputData(rm, input)))
        .to.be.revertedWithCustomError(uw, "InvalidInputSize")
        .withArgs(
          ethers.getBytes(makeFSUWInputData(rm, input)).length,
          ethers.getBytes(makeFSUWInputData(rm, input)).length + SIGNATURE_SIZE
        );
      // Send correct input, but ZeroAddress as RM
      await expect(
        uw.priceNewPolicy(ZeroAddress, await makeAndSignFSUWInputData(ZeroAddress, { signer, ...input }))
      ).to.be.revertedWithoutReason();

      // Send correct input, but rm mismatch
      await expect(
        uw.priceNewPolicy(rm, await makeAndSignFSUWInputData(ZeroAddress, { signer, ...input }))
      ).to.be.revertedWithCustomError(uw, "SignatureRmMismatch");

      // Send correct input, rm but invalid signer
      await expect(uw.priceNewPolicy(rm, await makeAndSignFSUWInputData(rm, { signer: other, ...input })))
        .to.be.revertedWithCustomError(uw, "UnauthorizedSigner")
        .withArgs(other, operationSelector);
      const output = await uw.priceNewPolicy(rm, await makeAndSignFSUWInputData(rm, { signer, ...input }));
      expect(output.length).to.equal(6);
      expect(output[0]).to.equal(input.payout);
      expect(output[1]).to.equal(input.premium);
      expect(output[2]).to.equal(input.lossProb);
      expect(output[3]).to.equal(input.expiration);
      expect(output[4]).to.equal(input.internalId);
      expect(output[5]).to.deep.equal(input.params.asParams());
    }
  });

  it("Checks it decodes the same input for pricePolicyReplacement", async () => {
    const { uw, acMgr, rm, signer, other } = await helpers.loadFixture(fullSignedUWFixture);

    const FULL_REPLACE_POLICY_SIGNER = getAccessManagerRole("FULL_REPLACE_POLICY_SIGNER");
    const operationSelector = makeHashSelector("FULL_PRICE_REPLACE_POLICY");
    const RANDOM_RM = "0xcA4793C93A94E7A70a4631b1CecE6546e76eb19e";

    await acMgr.setTargetFunctionRole(rm, [operationSelector], FULL_REPLACE_POLICY_SIGNER);
    await acMgr.grantRole(FULL_REPLACE_POLICY_SIGNER, signer, 0);

    for (let i = 0; i < 5; i++) {
      const input = makeRandomPriceReplaceInput(rm);
      // Send wrong input
      await expect(uw.pricePolicyReplacement(ZeroAddress, makeFSUWReplacementInputData(rm, input)))
        .to.be.revertedWithCustomError(uw, "InvalidInputSize")
        .withArgs(
          ethers.getBytes(makeFSUWReplacementInputData(rm, input)).length,
          ethers.getBytes(makeFSUWReplacementInputData(rm, input)).length + SIGNATURE_SIZE
        );
      // Send correct input, but ZeroAddress as RM
      await expect(
        uw.pricePolicyReplacement(
          ZeroAddress,
          await makeAndSignFSUWReplacementInputData(ZeroAddress, { signer, ...input })
        )
      ).to.be.revertedWithoutReason();

      // Send correct input, but RM mismatch
      await expect(
        uw.pricePolicyReplacement(rm, await makeAndSignFSUWReplacementInputData(ZeroAddress, { signer, ...input }))
      ).to.be.revertedWithCustomError(uw, "SignatureRmMismatch");

      const inputWrongReplace = makeRandomPriceReplaceInput(RANDOM_RM);

      // Send correct rm in the newPolicy, but wrong RM in the oldPolicy
      await expect(
        uw.pricePolicyReplacement(rm, await makeAndSignFSUWReplacementInputData(rm, { signer, ...inputWrongReplace }))
      ).to.be.revertedWithCustomError(uw, "SignatureRmMismatch");

      // Send correct input, rm but invalid signer
      await expect(
        uw.pricePolicyReplacement(rm, await makeAndSignFSUWReplacementInputData(rm, { signer: other, ...input }))
      )
        .to.be.revertedWithCustomError(uw, "UnauthorizedSigner")
        .withArgs(other, operationSelector);
      const output = await uw.pricePolicyReplacement(
        rm,
        await makeAndSignFSUWReplacementInputData(rm, { signer, ...input })
      );
      expect(output.length).to.equal(7);
      expect(output[0]).to.deep.equal(input.oldPolicy);
      expect(output[1]).to.equal(input.payout);
      expect(output[2]).to.equal(input.premium);
      expect(output[3]).to.equal(input.lossProb);
      expect(output[4]).to.equal(input.expiration);
      expect(output[5]).to.equal(input.internalId);
      expect(output[6]).to.deep.equal(input.params.asParams());
    }
  });

  it("Checks it decodes the same input for pricePolicyCancellation", async () => {
    const { uw, acMgr, rm, signer, other } = await helpers.loadFixture(fullSignedUWFixture);

    const FULL_CANCEL_POLICY_SIGNER = getAccessManagerRole("FULL_CANCEL_POLICY_SIGNER");
    const operationSelector = makeHashSelector("FULL_PRICE_CANCEL_POLICY");

    await acMgr.setTargetFunctionRole(rm, [operationSelector], FULL_CANCEL_POLICY_SIGNER);
    await acMgr.grantRole(FULL_CANCEL_POLICY_SIGNER, signer, 0);

    for (let i = 0; i < 5; i++) {
      const input = makeRandomPriceCancellationInput();

      // Send correct input, but rm mismatch
      await expect(
        uw.pricePolicyCancellation(rm, await makeAndSignFTUWCancelInputData({ signer, ...input }))
      ).to.be.revertedWithCustomError(uw, "SignatureRmMismatch");

      input.policyToCancel[0] = makePolicyId(rm, input.policyToCancel[0]);

      // Send wrong input
      await expect(uw.pricePolicyCancellation(ZeroAddress, makeFTUWCancelInputData(input)))
        .to.be.revertedWithCustomError(uw, "InvalidInputSize")
        .withArgs(
          ethers.getBytes(makeFTUWCancelInputData(input)).length,
          ethers.getBytes(makeFTUWCancelInputData(input)).length + SIGNATURE_SIZE
        );
      // Send correct input, but ZeroAddress as RM
      await expect(
        uw.pricePolicyCancellation(ZeroAddress, await makeAndSignFTUWCancelInputData({ signer, ...input }))
      ).to.be.revertedWithoutReason();

      // Send correct input, rm but invalid signer
      await expect(uw.pricePolicyCancellation(rm, await makeAndSignFTUWCancelInputData({ signer: other, ...input })))
        .to.be.revertedWithCustomError(uw, "UnauthorizedSigner")
        .withArgs(other, operationSelector);
      const output = await uw.pricePolicyCancellation(rm, await makeAndSignFTUWCancelInputData({ signer, ...input }));
      expect(output.length).to.equal(4);
      expect(output[0]).to.deep.equal(input.policyToCancel);
      expect(output[1]).to.equal(input.purePremiumRefund);
      expect(output[2]).to.equal(input.jrCocRefund);
      expect(output[3]).to.equal(input.srCocRefund);
    }
  });

  it("Checks pricePolicyCancellation extracts the accrued interest when receices MaxUint256", async () => {
    const { uw, acMgr, rm, signer } = await helpers.loadFixture(fullSignedUWFixture);

    const FULL_CANCEL_POLICY_SIGNER = getAccessManagerRole("FULL_CANCEL_POLICY_SIGNER");
    const operationSelector = makeHashSelector("FULL_PRICE_CANCEL_POLICY");

    await acMgr.setTargetFunctionRole(rm, [operationSelector], FULL_CANCEL_POLICY_SIGNER);
    await acMgr.grantRole(FULL_CANCEL_POLICY_SIGNER, signer, 0);

    const now = await helpers.time.latest();

    for (let i = 0; i < 5; i++) {
      const input = makeRandomPriceCancellationInput();
      input.policyToCancel[0] = makePolicyId(rm, input.policyToCancel[0]);
      input.policyToCancel[10] = now - DAY;
      input.policyToCancel[11] = now + 9 * DAY;
      input.jrCocRefund = MaxUint256;
      const output = await uw.pricePolicyCancellation(rm, await makeAndSignFTUWCancelInputData({ signer, ...input }));
      expect(output.length).to.equal(4);
      expect(output[0]).to.deep.equal(input.policyToCancel);
      expect(output[1]).to.equal(input.purePremiumRefund);
      expect(output[2]).not.to.equal(input.jrCocRefund);
      expect(output[2]).to.closeTo((input.policyToCancel[8] * 9n) / 10n, 100n);
      expect(output[3]).to.equal(input.srCocRefund);
    }

    for (let i = 0; i < 10; i++) {
      const input = makeRandomPriceCancellationInput();
      input.policyToCancel[0] = makePolicyId(rm, input.policyToCancel[0]);
      input.policyToCancel[10] = now - DAY;
      input.policyToCancel[11] = now + 9 * DAY;
      input.srCocRefund = MaxUint256;
      const output = await uw.pricePolicyCancellation(rm, await makeAndSignFTUWCancelInputData({ signer, ...input }));
      expect(output.length).to.equal(4);
      expect(output[0]).to.deep.equal(input.policyToCancel);
      expect(output[1]).to.equal(input.purePremiumRefund);
      expect(output[2]).to.equal(input.jrCocRefund);
      expect(output[3]).not.to.equal(input.srCocRefund);
      expect(output[3]).to.closeTo((input.policyToCancel[9] * 9n) / 10n, 100n);
    }
  });
});
