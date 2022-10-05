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
  grantRole,
} = require("./test-utils");
const hre = require("hardhat");
const helpers = require("@nomicfoundation/hardhat-network-helpers");

const COMPONENT_STATUS_DEPRECATED = 2;

describe("SignedQuoteRiskModule contract tests", function () {
  let _A;
  let owner, lp, cust, signer, resolver, anon;

  beforeEach(async () => {
    [owner, lp, cust, signer, resolver, anon] = await hre.ethers.getSigners();

    _A = amountFunction(6);
  });

  async function deployPoolFixture() {
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
    });

    await accessManager.grantComponentRole(rm.address, await rm.PRICER_ROLE(), signer.address);
    await accessManager.grantComponentRole(rm.address, await rm.RESOLVER_ROLE(), resolver.address);
    return { etk, premiumsAccount, rm, pool, accessManager, currency };
  }

  function makeQuoteMessage(rmAddress, payout, premium, lossProb, expiration, policyData, validUntil) {
    return ethers.utils.solidityPack(
      ["address", "uint256", "uint256", "uint256", "uint40", "bytes32", "uint40"],
      [rmAddress, payout, premium, lossProb, expiration, policyData, validUntil]
    );
  }

  it("Creates a policy if the right signature is provided", async () => {
    const { rm } = await deployPoolFixture();
    const now = await helpers.time.latest();
    const premium = ethers.constants.MaxUint256;
    const payout = _A(1000);
    const lossProb = _W(0.1);
    const expiration = now + 3600 * 24 * 30;
    const validUntil = now + 3600 * 24;
    const policyData = "0xb494869573b0a0ce9caac5394e1d0d255d146ec7e2d30d643a4e1d78980f3235"; // random value
    const quoteMessage = makeQuoteMessage(rm.address, payout, premium, lossProb, expiration, policyData, validUntil);
    const signature = ethers.utils.splitSignature(await signer.signMessage(ethers.utils.arrayify(quoteMessage)));
    const tx = await rm
      .connect(cust)
      .newPolicy(
        payout,
        premium,
        lossProb,
        expiration,
        cust.address,
        policyData,
        signature.r,
        signature._vs,
        validUntil
      );
    const receipt = await tx.wait();
    const newSignedPolicyEvt = getTransactionEvent(rm.interface, receipt, "NewSignedPolicy");
    // Verify the event is emited and the last 96 bits of the policyData are used as internalId
    const policyId = newSignedPolicyEvt.args[0];
    const twoPow96 = ethers.BigNumber.from(2).pow(96);
    const internalId = policyId.mod(twoPow96);
    expect(internalId).to.be.equal(ethers.BigNumber.from(policyData).mod(twoPow96));
    // The first 160 bits of policyId is the module address
    expect(policyId.div(twoPow96)).to.be.equal(ethers.BigNumber.from(rm.address));
    // The second parameter is the policyData itself
    expect(newSignedPolicyEvt.args[1]).to.be.equal(policyData);
  });
});
