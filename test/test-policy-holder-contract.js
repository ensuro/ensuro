const { expect } = require("chai");
const { getAddress, amountFunction, getTransactionEvent, _W } = require("@ensuro/utils/js/utils");
const { initCurrency } = require("@ensuro/utils/js/test-utils");
const { defaultPolicyParams, makePolicyId } = require("../js/utils");
const { deployPool, deployPremiumsAccount, addEToken } = require("../js/test-utils");
const { ComponentKind } = require("../js/enums.js");
const { ethers } = require("hardhat");
const helpers = require("@nomicfoundation/hardhat-network-helpers");

const { ZeroAddress } = ethers;

const _A = amountFunction(6);

const NotificationKind = {
  PolicyReceived: 0,
  PayoutReceived: 1,
  PolicyExpired: 2,
  PolicyReplaced: 3,
  PolicyCancelled: 4,
};

function toPolicyStruct(policy, start = 0) {
  return [
    0, // id - Ignored
    policy.payout, // payout
    _A(0), // jrScr
    _A(0), // srScr
    policy.lossProb, // lossProb
    (policy.payout * policy.lossProb) / _W(1), // purePremium
    _A(0), // ensuroCommission
    _A(0), // partnerCommission
    _A(0), // jrCoc
    _A(0), // srCoc
    start, // start
    policy.expiration, // expiration
  ];
}

describe("PoliyHolder policy creation handling", () => {
  it("Receiving with a functioning holder contract succeeds and executes the handler code", async () => {
    const { rm, ph, backend } = await helpers.loadFixture(deployPoolFixture);
    const policy = await defaultPolicyParams({});
    await expect(rm.newPolicy(toPolicyStruct(policy), backend, ph, 1))
      .to.emit(ph, "NotificationReceived")
      .withArgs(NotificationKind.PolicyReceived, makePolicyId(rm, 1), rm, ZeroAddress);
  });

  it("Receiving with a holder that fails reverts the transaction", async () => {
    const { rm, ph, backend } = await helpers.loadFixture(deployPoolFixture);
    const policy = await defaultPolicyParams({});
    await ph.setFail(true);
    await expect(rm.newPolicy(toPolicyStruct(policy), backend, ph, 1)).to.be.revertedWith(
      "onERC721Received: They told me I have to fail"
    );
  });

  it("Receiving with a holder that fails empty reverts the transaction", async () => {
    const { rm, ph, backend, pool } = await helpers.loadFixture(deployPoolFixture);
    const policy = await defaultPolicyParams({});
    await ph.setFail(true);
    await ph.setEmptyRevert(true);
    await expect(rm.newPolicy(toPolicyStruct(policy), backend, ph, 1)).to.be.revertedWithCustomError(
      pool,
      "ERC721InvalidReceiver"
    );
  });

  it("Receiving with a holder that returns a bad value reverts the transaction", async () => {
    const { rm, ph, backend, pool } = await helpers.loadFixture(deployPoolFixture);
    const policy = await defaultPolicyParams({});
    await ph.setBadlyImplemented(true);
    await expect(rm.newPolicy(toPolicyStruct(policy), backend, ph, 1)).to.be.revertedWithCustomError(
      pool,
      "ERC721InvalidReceiver"
    );
  });
});

describe("PolicyHolder resolution handling", () => {
  it("Resolving with a functioning holder contract succeeds and executes the handler code", async () => {
    const { rm, pool, ph, backend } = await helpers.loadFixture(deployPoolFixture);
    const policy = await defaultPolicyParams({});
    const policyEvt = await createPolicy(rm, pool, policy, backend, ph, 1);

    await expect(rm.resolvePolicy([...policyEvt.args[1]], _A("123")))
      .to.emit(ph, "NotificationReceived")
      .withArgs(NotificationKind.PayoutReceived, makePolicyId(rm, 1), rm, pool);
    expect(await ph.payout()).to.equal(_A("123"));
  });

  it("Resolving with a holder that fails reverts the transaction", async () => {
    const { rm, pool, ph, backend } = await helpers.loadFixture(deployPoolFixture);
    const policy = await defaultPolicyParams({});
    const policyEvt = await createPolicy(rm, pool, policy, backend, ph, 1);

    await ph.setFail(true);
    await expect(rm.resolvePolicy([...policyEvt.args[1]], _A("123"))).to.be.revertedWith(
      "onPayoutReceived: They told me I have to fail"
    );
  });

  it("Resolving with a holder that fails empty reverts the transaction", async () => {
    const { rm, pool, ph, backend } = await helpers.loadFixture(deployPoolFixture);
    const policy = await defaultPolicyParams({});
    const policyEvt = await createPolicy(rm, pool, policy, backend, ph, 1);

    await ph.setFail(true);
    await ph.setEmptyRevert(true);
    await expect(rm.resolvePolicy([...policyEvt.args[1]], _A("123"))).to.be.reverted;
  });

  it("Resolving with a holder that returns a bad value reverts the transaction", async () => {
    const { rm, pool, ph, backend } = await helpers.loadFixture(deployPoolFixture);
    const policy = await defaultPolicyParams({});
    const policyEvt = await createPolicy(rm, pool, policy, backend, ph, 1);

    await ph.setBadlyImplemented(true);
    await expect(rm.resolvePolicy([...policyEvt.args[1]], _A("123"))).to.be.revertedWithCustomError(
      pool,
      "InvalidNotificationResponse"
    );
  });

  it("Resolving with a holder that doesn't implement the interface suceeds without executing the handling code", async () => {
    const { rm, pool, ph, backend } = await helpers.loadFixture(deployPoolFixture);
    const policy = await defaultPolicyParams({});
    const policyEvt = await createPolicy(rm, pool, policy, backend, ph, 1);

    await ph.setNotImplemented(true);
    const tx = await rm.resolvePolicy([...policyEvt.args[1]], _A("123"));
    const receipt = await tx.wait();
    expect(await getTransactionEvent(ph.interface, receipt, "NotificationReceived")).to.be.null;
  });

  it("Resolving with a holder that doesn't implement ERC165 succeeds without executing the handling code", async () => {
    const { rm, pool, ph, backend } = await helpers.loadFixture(deployPoolFixture);
    const policy = await defaultPolicyParams({});
    const policyEvt = await createPolicy(rm, pool, policy, backend, ph, 1);

    await ph.setNoERC165(true);
    const tx = await rm.resolvePolicy([...policyEvt.args[1]], _A("123"));
    const receipt = await tx.wait();
    expect(await getTransactionEvent(ph.interface, receipt, "NotificationReceived")).to.be.null;
  });
});

describe("PolicyHolder replacement handling", () => {
  it("Replacing with a functioning holder contract succeeds and executes the handler code", async () => {
    const { rm, pool, ph, backend } = await helpers.loadFixture(deployPoolFixture);
    const policy = await defaultPolicyParams({});
    const policyEvt = await createPolicy(rm, pool, policy, backend, ph, 1);
    const chainPolicy = policyEvt.args.policy;
    const policyNew = await defaultPolicyParams({ expiration: policy.expiration, premium: chainPolicy.premium });
    const replaceReceipt = await getReceipt(
      rm.replacePolicy([...chainPolicy], toPolicyStruct(policyNew, chainPolicy.start), backend, 2)
    );

    const evts = getTransactionEvent(ph.interface, replaceReceipt, "NotificationReceived", false, getAddress(ph));
    expect(evts.length).to.equal(2);
    expect(evts[0].args.kind).to.equal(NotificationKind.PolicyReceived);
    expect(evts[0].args.policyId).to.equal(makePolicyId(rm, 2));
    expect(evts[1].args.kind).to.equal(NotificationKind.PolicyReplaced);
    expect(evts[1].args.policyId).to.equal(makePolicyId(rm, 1));
    expect(await ph.payout()).to.equal(makePolicyId(rm, 2)); // New policyId is stored in the payout
  });

  it("Replacing with a functioning holder contract succeeds even if it spends a lot of gas", async () => {
    const { rm, pool, ph, backend } = await helpers.loadFixture(deployPoolFixture);
    const policy = await defaultPolicyParams({});
    const policyEvt = await createPolicy(rm, pool, policy, backend, ph, 1);
    const chainPolicy = policyEvt.args.policy;
    const policyNew = await defaultPolicyParams({ expiration: policy.expiration, premium: chainPolicy.premium });

    await ph.setSpendGasCount(10);
    const replaceReceipt = await getReceipt(
      rm.replacePolicy([...chainPolicy], toPolicyStruct(policyNew, chainPolicy.start), backend, 2)
    );

    const evts = getTransactionEvent(ph.interface, replaceReceipt, "NotificationReceived", false, getAddress(ph));
    expect(evts.length).to.equal(2);
  });

  it("Replacing with a failing holder contract fails", async () => {
    const { rm, pool, ph, backend } = await helpers.loadFixture(deployPoolFixture);
    const policy = await defaultPolicyParams({});
    const policyEvt = await createPolicy(rm, pool, policy, backend, ph, 1);
    const chainPolicy = policyEvt.args.policy;
    const policyNew = await defaultPolicyParams({ expiration: policy.expiration, premium: chainPolicy.premium });

    await ph.setFailReplace(true);
    await expect(
      rm.replacePolicy([...chainPolicy], toPolicyStruct(policyNew, chainPolicy.start), backend, 2)
    ).to.be.revertedWith("onPolicyReplaced: They told me I have to fail");

    // Same happens with an empty revert
    await ph.setEmptyRevert(true);
    await expect(rm.replacePolicy([...chainPolicy], toPolicyStruct(policyNew, chainPolicy.start), backend, 2)).to.be
      .reverted;

    // Also fails if returns wrong value
    await ph.setFailReplace(false);
    await ph.setBadlyImplementedReplace(true);
    await expect(rm.replacePolicy([...chainPolicy], toPolicyStruct(policyNew, chainPolicy.start), backend, 2))
      .to.be.revertedWithCustomError(pool, "InvalidNotificationResponse")
      .withArgs("0x0badf00d");
  });
});

describe("PolicyHolder cancelation handling", () => {
  it("Canceling with a functioning holder contract succeeds and executes the handler code", async () => {
    const { rm, pool, ph, backend } = await helpers.loadFixture(deployPoolFixture);
    const policy = await defaultPolicyParams({});
    const policyEvt = await createPolicy(rm, pool, policy, backend, ph, 1);
    const chainPolicy = policyEvt.args.policy;
    const cancelReceipt = await getReceipt(rm.cancelPolicy([...chainPolicy], 0, 0, 0));

    const evts = getTransactionEvent(ph.interface, cancelReceipt, "NotificationReceived", false, getAddress(ph));
    expect(evts.length).to.equal(1);
    expect(evts[0].args.kind).to.equal(NotificationKind.PolicyCancelled);
    expect(evts[0].args.policyId).to.equal(makePolicyId(rm, 1));
  });

  it("Cancelling with a functioning holder contract succeeds even if it spends a lot of gas", async () => {
    const { rm, pool, ph, backend } = await helpers.loadFixture(deployPoolFixture);
    const policy = await defaultPolicyParams({});
    const policyEvt = await createPolicy(rm, pool, policy, backend, ph, 1);
    const chainPolicy = policyEvt.args.policy;

    await ph.setSpendGasCount(10);
    const cancelReceipt = await getReceipt(rm.cancelPolicy([...chainPolicy], chainPolicy.purePremium, 0, 0));

    const evts = getTransactionEvent(ph.interface, cancelReceipt, "NotificationReceived", false, getAddress(ph));
    expect(evts.length).to.equal(1);
  });

  it("Cancelling with a failing holder contract fails", async () => {
    const { rm, pool, ph, backend } = await helpers.loadFixture(deployPoolFixture);
    const policy = await defaultPolicyParams({});
    const policyEvt = await createPolicy(rm, pool, policy, backend, ph, 1);
    const chainPolicy = policyEvt.args.policy;

    await ph.setFailCancellation(true);
    await expect(rm.cancelPolicy([...chainPolicy], 0n, 0n, 0n)).to.be.revertedWith(
      "onPolicyCancelled: They told me I have to fail"
    );

    // Same happens with an empty revert
    await ph.setEmptyRevert(true);
    await expect(rm.cancelPolicy([...chainPolicy], 0n, 0n, 0n)).to.be.reverted;

    // Also fails if returns wrong value
    await ph.setFailCancellation(false);
    await ph.setBadlyImplementedReplace(true);
    await expect(rm.cancelPolicy([...chainPolicy], 0n, 0n, 0n))
      .to.be.revertedWithCustomError(pool, "InvalidNotificationResponse")
      .withArgs("0x0badfeed");
  });
});

describe("PolicyHolder expiration handling", function () {
  it("Expiring with a functioning holder contract succeeds and executes the handler code", async () => {
    const { owner, pool, rm, ph, backend } = await helpers.loadFixture(deployPoolFixture);
    const policy = await defaultPolicyParams({});
    const policy1Evt = await createPolicy(rm, pool, policy, backend, ph, 1);

    await helpers.time.increaseTo(policy.expiration);
    await expect(pool.expirePolicy([...policy1Evt.args[1]]))
      .to.emit(ph, "NotificationReceived")
      .withArgs(NotificationKind.PolicyExpired, makePolicyId(rm, 1), owner, pool);
  });

  it("Expiring with a holder that reverts succeeds but doesn't execute the handler code", async () => {
    const { pool, rm, ph, backend } = await helpers.loadFixture(deployPoolFixture);
    const policy = await defaultPolicyParams({});

    const policyEvt = await createPolicy(rm, pool, policy, backend, ph, 1);
    await ph.setFail(true);
    await helpers.time.increaseTo(policy.expiration);
    const tx = await pool.expirePolicy([...policyEvt.args[1]]);
    const receipt = await tx.wait();
    expect(await getTransactionEvent(ph.interface, receipt, "NotificationReceived")).to.be.null;
  });

  it("Expiring with a holder that spends a lot of gas succeeds but doesn't execute the handler code", async () => {
    const { pool, rm, ph, backend } = await helpers.loadFixture(deployPoolFixture);
    const policy = await defaultPolicyParams({});

    const policyEvt = await createPolicy(rm, pool, policy, backend, ph, 1);
    await ph.setSpendGasCount(7);
    await helpers.time.increaseTo(policy.expiration);
    const tx = await pool.expirePolicy([...policyEvt.args[1]]);
    const receipt = await tx.wait();
    expect(await getTransactionEvent(ph.interface, receipt, "NotificationReceived")).to.be.null;
  });

  it("Expiring with a holder that spends few gas succeeds and executes the handler code [ @skip-on-coverage ]", async () => {
    const { pool, rm, ph, backend } = await helpers.loadFixture(deployPoolFixture);
    const policy = await defaultPolicyParams({});

    const policyEvt = await createPolicy(rm, pool, policy, backend, ph, 1);
    await ph.setSpendGasCount(6);
    await helpers.time.increaseTo(policy.expiration);
    const tx = await pool.expirePolicy([...policyEvt.args[1]]);
    const receipt = await tx.wait();
    expect(await getTransactionEvent(ph.interface, receipt, "NotificationReceived")).not.to.be.null;
  });

  it("Expiring with a holder that spends few gas succeeds and executes the handler code (low gas version))", async () => {
    const { pool, rm, ph, backend } = await helpers.loadFixture(deployPoolFixture);
    const policy = await defaultPolicyParams({});

    const policyEvt = await createPolicy(rm, pool, policy, backend, ph, 1);
    await helpers.time.increaseTo(policy.expiration);
    const tx = await pool.expirePolicy([...policyEvt.args[1]]);
    const receipt = await tx.wait();
    expect(await getTransactionEvent(ph.interface, receipt, "NotificationReceived")).not.to.be.null;
  });

  it("Expiring with a holder that reverts empty succeeds but doesn't execute the handler code", async () => {
    const { pool, rm, ph, backend } = await helpers.loadFixture(deployPoolFixture);
    const policy = await defaultPolicyParams({});

    const policyEvt = await createPolicy(rm, pool, policy, backend, ph, 1);
    await ph.setFail(true);
    await ph.setEmptyRevert(true);
    await helpers.time.increaseTo(policy.expiration);
    const tx = await pool.expirePolicy([...policyEvt.args[1]]);
    const receipt = await tx.wait();
    expect(await getTransactionEvent(ph.interface, receipt, "NotificationReceived")).to.be.null;
    const expEvt = await getTransactionEvent(pool.interface, receipt, "ExpirationNotificationFailed");
    expect(expEvt).not.to.be.null;
    expect(expEvt.args.policyId).to.equal(makePolicyId(rm, 1));
    expect(expEvt.args.holder).to.equal(ph);
  });

  it("Expiring with a holder that returns a bad value succeeds", async () => {
    const { owner, pool, rm, ph, backend } = await helpers.loadFixture(deployPoolFixture);
    const policy = await defaultPolicyParams({});
    const policy1Evt = await createPolicy(rm, pool, policy, backend, ph, 1);

    await ph.setBadlyImplemented(true);
    await helpers.time.increaseTo(policy.expiration);
    await expect(pool.expirePolicy([...policy1Evt.args[1]]))
      .to.emit(ph, "NotificationReceived")
      .withArgs(NotificationKind.PolicyExpired, makePolicyId(rm, 1), owner, pool);
  });

  it("Expiring with a holder that doesn't implement the interface succeeds", async () => {
    const { pool, rm, ph, backend } = await helpers.loadFixture(deployPoolFixture);
    const policy = await defaultPolicyParams({});
    const policy1Evt = await createPolicy(rm, pool, policy, backend, ph, 1);

    await ph.setNotImplemented(true);
    await helpers.time.increaseTo(policy.expiration);
    const tx = await pool.expirePolicy([...policy1Evt.args[1]]);
    const receipt = await tx.wait();
    expect(await getTransactionEvent(ph.interface, receipt, "NotificationReceived")).to.be.null;
  });

  it("Expiring with a holder that doesn't implement ERC165 succeeds", async () => {
    const { pool, rm, ph, backend } = await helpers.loadFixture(deployPoolFixture);
    const policy = await defaultPolicyParams({});
    const policy1Evt = await createPolicy(rm, pool, policy, backend, ph, 1);

    await ph.setNoERC165(true);
    await helpers.time.increaseTo(policy.expiration);
    const tx = await pool.expirePolicy([...policy1Evt.args[1]]);
    const receipt = await tx.wait();
    expect(await getTransactionEvent(ph.interface, receipt, "NotificationReceived")).to.be.null;
  });
});

async function deployPoolFixture() {
  const [owner, lp, cust, backend] = await ethers.getSigners();

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

  const etk = await addEToken(pool, {});

  const premiumsAccount = await deployPremiumsAccount(pool, { srEtk: etk });

  const PolicyPool = await ethers.getContractFactory("PolicyPool");
  const RiskModuleMock = await ethers.getContractFactory("RiskModuleMock");

  const rmMock = await RiskModuleMock.deploy(pool, premiumsAccount, ZeroAddress);
  const rm = PolicyPool.attach(getAddress(rmMock));
  await pool.addComponent(rm, ComponentKind.riskModule);
  await pool.setExposureLimit(rm, _A(2000));

  await currency.connect(lp).approve(pool, _A(5000));
  await currency.connect(backend).approve(pool, _A(5000));
  await pool.connect(lp).deposit(etk, _A(5000), lp);

  const PolicyHolderMock = await ethers.getContractFactory("PolicyHolderMock");
  const ph = await PolicyHolderMock.deploy();

  return {
    pool,
    currency,
    etk,
    premiumsAccount,
    RiskModuleMock,
    rm,
    PolicyHolderMock,
    ph,
    _A,
    lp,
    cust,
    backend,
    owner,
  };
}

async function createPolicy(rm, pool, policy, payer, onBehalfOf, internalId) {
  const tx = await rm.newPolicy(toPolicyStruct(policy), payer, onBehalfOf, internalId);
  const receipt = await tx.wait();

  return getTransactionEvent(pool.interface, receipt, "NewPolicy");
}

async function getReceipt(txPromise) {
  const tx = await txPromise;
  return tx.wait();
}
