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
} = require("./test-utils");
const hre = require("hardhat");
const helpers = require("@nomicfoundation/hardhat-network-helpers");

describe("SignedQuoteRiskModule contract tests", function () {
  let _A;
  let lp, cust, signer, resolver, anon;

  beforeEach(async () => {
    [_, lp, cust, signer, resolver, anon] = await hre.ethers.getSigners();

    _A = amountFunction(6);
  });

  async function deployPoolFixture(creationIsOpen) {
    creationIsOpen = creationIsOpen === undefined ? true : creationIsOpen;
    const currency = await initCurrency(
      { name: "Test USDC", symbol: "USDC", decimals: 6, initial_supply: _A(10000) },
      [lp, cust],
      [_A(5000), _A(500)]
    );

    const pool = await deployPool(hre, {
      currency: currency.address,
      grantRoles: ["LEVEL1_ROLE", "LEVEL2_ROLE"],
      treasuryAddress: "0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199", // Random address
    });
    pool._A = _A;

    const accessManager = await hre.ethers.getContractAt("AccessManager", await pool.access());

    // Setup the liquidity sources
    const etk = await addEToken(pool, {});
    const premiumsAccount = await deployPremiumsAccount(hre, pool, { srEtkAddr: etk.address });

    // Provide some liquidity
    await currency.connect(lp).approve(pool.address, _A(5000));
    await pool.connect(lp).deposit(etk.address, _A(5000));

    // Customer approval
    await currency.connect(cust).approve(pool.address, _A(500));

    // Setup the risk module
    const SignedQuoteRiskModule = await hre.ethers.getContractFactory("SignedQuoteRiskModule");
    const rm = await addRiskModule(pool, premiumsAccount, SignedQuoteRiskModule, {
      ensuroFee: 0.03,
      extraConstructorArgs: [creationIsOpen],
    });

    await accessManager.grantComponentRole(rm.address, await rm.PRICER_ROLE(), signer.address);
    await accessManager.grantComponentRole(rm.address, await rm.RESOLVER_ROLE(), resolver.address);
    return { etk, premiumsAccount, rm, pool, accessManager, currency };
  }

  function makeQuoteMessage({ rmAddress, payout, premium, lossProb, expiration, policyData, validUntil }) {
    return ethers.utils.solidityPack(
      ["address", "uint256", "uint256", "uint256", "uint40", "bytes32", "uint40"],
      [rmAddress, payout, premium, lossProb, expiration, policyData, validUntil]
    );
  }

  async function defaultPolicyParams({ rmAddress, payout, premium, lossProb, expiration, policyData, validUntil }) {
    const now = await helpers.time.latest();
    return {
      rmAddress,
      payout: payout || _A(1000),
      premium: premium || ethers.constants.MaxUint256,
      lossProb: lossProb || _W(0.1),
      expiration: expiration || now + 3600 * 24 * 30,
      policyData: policyData || "0xb494869573b0a0ce9caac5394e1d0d255d146ec7e2d30d643a4e1d78980f3235",
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

  it("Creates a policy if the right signature is provided", async () => {
    const { rm, pool, currency } = await deployPoolFixture();
    const policyParams = await defaultPolicyParams({ rmAddress: rm.address });
    const quoteMessage = makeQuoteMessage(policyParams);
    const signature = ethers.utils.splitSignature(await signer.signMessage(ethers.utils.arrayify(quoteMessage)));
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
    const { rm } = await deployPoolFixture();
    const policyParams = await defaultPolicyParams({ rmAddress: rm.address });
    const quoteMessage = makeQuoteMessage(policyParams);
    const signature = ethers.utils.splitSignature(await anon.signMessage(ethers.utils.arrayify(quoteMessage)));
    await expect(newPolicy(rm, cust, policyParams, cust, signature)).to.be.revertedWith(
      accessControlMessage(anon.address, rm.address, "PRICER_ROLE")
    );
  });

  it("Rejects a policy if receives an invalid signature", async () => {
    const { rm } = await deployPoolFixture();
    const policyParams = await defaultPolicyParams({ rmAddress: rm.address });
    const signature = {
      // random values
      r: "0xbf372ca3ebecfe59ac256f17697941bbe63302aced610e8b0e3646f743c7beb2",
      _vs: "0xa82e22387fca439f316d78ca566f383218ab8ae1b3e830178c9c82cbd16749c0",
    };
    await expect(newPolicy(rm, cust, policyParams, cust, signature)).to.be.revertedWith("ECDSA: invalid signature");
  });

  it("Rejects a policy if quote expired or validUntil changed", async () => {
    const { rm } = await deployPoolFixture();
    const now = await helpers.time.latest();
    const policyParams = await defaultPolicyParams({ rmAddress: rm.address, validUntil: now - 1000 });
    const quoteMessage = makeQuoteMessage(policyParams);
    const signature = ethers.utils.splitSignature(await signer.signMessage(ethers.utils.arrayify(quoteMessage)));
    await expect(newPolicy(rm, cust, policyParams, cust, signature)).to.be.revertedWith("Quote expired");

    // If we change the policyParams, a different address is derived from the signature and it won't have
    // the required permission with a probability of (1 - 1/2**160)
    policyParams.validUntil = now + 2000;
    await expect(newPolicy(rm, cust, policyParams, cust, signature)).to.be.revertedWith("AccessControl: account ");
  });

  it("Creates a policy where payer != msg.sender using newPolicyPaidByHolder", async () => {
    const { rm, pool, currency } = await deployPoolFixture();
    const policyParams = await defaultPolicyParams({ rmAddress: rm.address, premium: _A(200) });
    const quoteMessage = makeQuoteMessage(policyParams);
    const signature = ethers.utils.splitSignature(await signer.signMessage(ethers.utils.arrayify(quoteMessage)));
    await expect(newPolicy(rm, anon, policyParams, cust, signature, "newPolicyPaidByHolder")).to.be.revertedWith(
      "Sender is not authorized to create policies onBehalfOf"
    );

    await currency.connect(cust).approve(anon.address, _A(200));

    const tx = await newPolicy(rm, anon, policyParams, cust, signature, "newPolicyPaidByHolder");
    const receipt = await tx.wait();
    const newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");

    // Tests resolution, only by an authorized role
    await expect(() => rm.connect(resolver).resolvePolicyFullPayout(newPolicyEvt.args[1], true)).to.changeTokenBalance(
      currency,
      cust,
      policyParams.payout
    );
  });

  it("If creation is not open, only authorized users can create policies", async () => {
    const { rm, accessManager } = await deployPoolFixture(false);
    const policyParams = await defaultPolicyParams({ rmAddress: rm.address });
    const quoteMessage = makeQuoteMessage(policyParams);
    const signature = ethers.utils.splitSignature(await signer.signMessage(ethers.utils.arrayify(quoteMessage)));
    await expect(newPolicy(rm, cust, policyParams, cust, signature)).to.be.revertedWith(
      accessControlMessage(cust.address, rm.address, "POLICY_CREATOR_ROLE")
    );
    await accessManager.grantComponentRole(rm.address, await rm.POLICY_CREATOR_ROLE(), cust.address);

    await expect(newPolicy(rm, cust, policyParams, cust, signature)).not.to.be.reverted;
  });
});
