/**
 * Regression tests for the replacePolicy reentrancy fix.
 *
 * Before the fix, _safeMint was called before delete _policies[oldPolicy.id], so
 * the ERC721 receiver callback could reenter with a second lifecycle operation on
 * the same old policy, creating duplicate active policies with mismatched accounting.
 *
 * The fix moves _safeMint to after delete _policies[oldPolicy.id], so any reentrant
 * attempt to use the old policy fails with PolicyNotFound.
 *
 * See: https://gist.github.com/DicksonWu654/063de64666c83a2e5673a58de6d38dfc
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");
const helpers = require("@nomicfoundation/hardhat-network-helpers");
const { amountFunction, _W, getTransactionEvent } = require("@ensuro/utils/js/utils");
const { HOUR } = require("@ensuro/utils/js/constants");
const { initCurrency } = require("@ensuro/utils/js/test-utils");
const { deployPool, deployPremiumsAccount, addRiskModule, addEToken } = require("../js/test-utils");
const {
  makeFTUWInputData,
  makeFTUWReplacementInputData,
  makeFTUWCancelInputData,
  defaultTestParams,
} = require("../js/utils");

const _A = amountFunction(6);
const { MaxUint256 } = ethers;

async function fixture() {
  const [, lp, backend] = await ethers.getSigners();
  const currency = await initCurrency(
    { name: "Test USDC", symbol: "USDC", decimals: 6, initial_supply: _A(100000) },
    [lp, backend],
    [_A(20000), _A(5000)]
  );

  const pool = await deployPool({
    currency,
    treasuryAddress: "0x87c47c9a5a2aa74ae714857d64911d9a091c25b1",
  });
  pool._A = _A;

  const etk = await addEToken(pool, {});
  const premiumsAccount = await deployPremiumsAccount(pool, { srEtk: etk });

  const FullTrustedUW = await ethers.getContractFactory("FullTrustedUW");
  const uw = await FullTrustedUW.deploy();

  const rm = await addRiskModule(pool, premiumsAccount, { underwriter: uw, extraArgs: [] });

  await currency.connect(lp).approve(pool, MaxUint256);
  await currency.connect(backend).approve(pool, MaxUint256);
  await pool.connect(lp).deposit(etk, _A(10000), lp);

  const ReentrantHolder = await ethers.getContractFactory("ReentrantPolicyHolderMock");
  const holder = await ReentrantHolder.deploy();

  return { pool, etk, premiumsAccount, rm, holder, backend };
}

async function createPolicy({ pool, rm, holder, backend, internalId = 801 }) {
  const now = await helpers.time.latest();
  const inputData = makeFTUWInputData({
    payout: _A(1000),
    premium: MaxUint256,
    lossProb: _W("0.01"),
    expiration: now + 12 * HOUR,
    internalId,
    params: defaultTestParams({}),
  });
  const tx = await rm.connect(backend).newPolicy(inputData, holder);
  return getTransactionEvent(pool.interface, await tx.wait(), "NewPolicy").args.policy;
}

function makeReplacementData(oldPolicy, internalId) {
  return makeFTUWReplacementInputData({
    oldPolicy: [...oldPolicy],
    payout: oldPolicy.payout,
    premium: MaxUint256,
    lossProb: oldPolicy.lossProb,
    expiration: oldPolicy.expiration,
    internalId,
    params: defaultTestParams({}),
  });
}

describe("replacePolicy reentrancy fix", function () {
  it("Reentrant replacePolicy during onERC721Received is blocked: old policy deleted before mint", async function () {
    const { pool, etk, premiumsAccount, rm, holder, backend } = await helpers.loadFixture(fixture);

    const oldPolicy = await createPolicy({ pool, rm, holder, backend });

    // Arm the holder: during the outer replacement's onERC721Received, try a second
    // replacePolicy on the same old policy (different internalId = different new policy id).
    const innerInputData = makeReplacementData(oldPolicy, 803);
    await holder.arm(rm.target, rm.interface.encodeFunctionData("replacePolicy", [innerInputData]));

    const outerInputData = makeReplacementData(oldPolicy, 802);
    const receipt = await (await rm.connect(backend).replacePolicy(outerInputData)).wait();

    // The callback fired and the reentrant call was attempted...
    expect(await holder.reentryAttempted()).to.be.true;
    // ...but it failed because _policies[oldPolicy.id] was already deleted before _safeMint.
    expect(await holder.reentrySucceeded()).to.be.false;

    // Only one new policy was created, not two.
    const newPolicies = getTransactionEvent(pool.interface, receipt, "NewPolicy", false);
    expect(newPolicies.length).to.equal(1);

    // Pool accounting reflects exactly one active policy (the replacement).
    expect(await premiumsAccount.activePurePremiums()).to.equal(oldPolicy.purePremium);
    expect(await etk.scr()).to.equal(oldPolicy.srScr);
    expect((await pool.getExposure(rm))[0]).to.equal(oldPolicy.payout);
  });

  it("Reentrant cancelPolicy during replacePolicy onERC721Received is blocked: old policy deleted before mint", async function () {
    const { pool, etk, premiumsAccount, rm, holder, backend } = await helpers.loadFixture(fixture);

    const oldPolicy = await createPolicy({ pool, rm, holder, backend });

    // Arm the holder: during onERC721Received, try to cancel the same old policy.
    const cancelInputData = makeFTUWCancelInputData({
      policyToCancel: [...oldPolicy],
      purePremiumRefund: oldPolicy.purePremium,
      jrCocRefund: MaxUint256,
      srCocRefund: MaxUint256,
    });
    await holder.arm(rm.target, rm.interface.encodeFunctionData("cancelPolicy", [cancelInputData]));

    const outerInputData = makeReplacementData(oldPolicy, 802);
    const receipt = await (await rm.connect(backend).replacePolicy(outerInputData)).wait();

    // The callback fired and the reentrant cancellation was attempted...
    expect(await holder.reentryAttempted()).to.be.true;
    // ...but failed: old policy was already gone.
    expect(await holder.reentrySucceeded()).to.be.false;

    // Replacement completed successfully with one new policy.
    const newPolicies = getTransactionEvent(pool.interface, receipt, "NewPolicy", false);
    expect(newPolicies.length).to.equal(1);

    // Accounting is consistent with a clean replacement, not a desynchronized state.
    expect(await premiumsAccount.activePurePremiums()).to.equal(oldPolicy.purePremium);
    expect(await etk.scr()).to.equal(oldPolicy.srScr);
    expect((await pool.getExposure(rm))[0]).to.equal(oldPolicy.payout);
  });
});
