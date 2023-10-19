const { expect } = require("chai");
const { amountFunction, defaultPolicyParams, makePolicyId, getTransactionEvent } = require("../js/utils");
const { initCurrency, deployPool, deployPremiumsAccount, addRiskModule, addEToken } = require("../js/test-utils");
const { ethers } = require("hardhat");
const helpers = require("@nomicfoundation/hardhat-network-helpers");

const { AddressZero } = ethers.constants;

const NotificationKind = {
  PolicyReceived: 0,
  PayoutReceived: 1,
  PolicyExpired: 2,
};

describe("PoliyHolder policy creation handling", () => {
  it("Receiving with a functioning holder contract succeeds and executes the handler code", async () => {
    const { rm, ph, backend } = await helpers.loadFixture(deployPoolFixture);
    const policy = await defaultPolicyParams({});
    await expect(rm.connect(backend).newPolicy(...policyToArgs(policy, backend.address, ph.address, 1)))
      .to.emit(ph, "NotificationReceived")
      .withArgs(NotificationKind.PolicyReceived, makePolicyId(rm.address, 1), rm.address, AddressZero);
  });

  it("Receiving with a holder that fails reverts the transaction", async () => {
    const { rm, ph, backend } = await helpers.loadFixture(deployPoolFixture);
    const policy = await defaultPolicyParams({});
    await ph.setFail(true);
    await expect(
      rm.connect(backend).newPolicy(...policyToArgs(policy, backend.address, ph.address, 1))
    ).to.be.revertedWith("onERC721Received: They told me I have to fail");
  });

  it("Receiving with a holder that fails empty reverts the transaction", async () => {
    const { rm, ph, backend } = await helpers.loadFixture(deployPoolFixture);
    const policy = await defaultPolicyParams({});
    await ph.setFail(true);
    await ph.setEmptyRevert(true);
    await expect(
      rm.connect(backend).newPolicy(...policyToArgs(policy, backend.address, ph.address, 1))
    ).to.be.revertedWith("ERC721: transfer to non ERC721Receiver implementer");
  });

  it("Receiving with a holder that returns a bad value reverts the transaction", async () => {
    const { rm, ph, backend } = await helpers.loadFixture(deployPoolFixture);
    const policy = await defaultPolicyParams({});
    await ph.setBadlyImplemented(true);
    await expect(
      rm.connect(backend).newPolicy(...policyToArgs(policy, backend.address, ph.address, 1))
    ).to.be.revertedWith("ERC721: transfer to non ERC721Receiver implementer");
  });
});

describe("PolicyHolder resolution handling", () => {
  it("Resolving with a functioning holder contract succeeds and executes the handler code", async () => {
    const { rm, pool, ph, backend, _A } = await helpers.loadFixture(deployPoolFixture);
    const policy = await defaultPolicyParams({});
    const policyEvt = await createPolicy(
      rm.connect(backend),
      pool,
      policyToArgs(policy, backend.address, ph.address, 1)
    );

    await expect(rm.connect(backend).resolvePolicy(policyEvt.args[1], _A("123")))
      .to.emit(ph, "NotificationReceived")
      .withArgs(NotificationKind.PayoutReceived, makePolicyId(rm.address, 1), rm.address, pool.address);
    expect(await ph.payout()).to.equal(_A("123"));
  });

  it("Resolving with a holder that fails reverts the transaction", async () => {
    const { rm, pool, ph, backend, _A } = await helpers.loadFixture(deployPoolFixture);
    const policy = await defaultPolicyParams({});
    const policyEvt = await createPolicy(
      rm.connect(backend),
      pool,
      policyToArgs(policy, backend.address, ph.address, 1)
    );

    await ph.setFail(true);
    await expect(rm.connect(backend).resolvePolicy(policyEvt.args[1], _A("123"))).to.be.revertedWith(
      "onPayoutReceived: They told me I have to fail"
    );
  });

  it("Resolving with a holder that fails empty reverts the transaction", async () => {
    const { rm, pool, ph, backend, _A } = await helpers.loadFixture(deployPoolFixture);
    const policy = await defaultPolicyParams({});
    const policyEvt = await createPolicy(
      rm.connect(backend),
      pool,
      policyToArgs(policy, backend.address, ph.address, 1)
    );

    await ph.setFail(true);
    await ph.setEmptyRevert(true);
    await expect(rm.connect(backend).resolvePolicy(policyEvt.args[1], _A("123"))).to.be.reverted;
  });

  it("Resolving with a holder that returns a bad value reverts the transaction", async () => {
    const { rm, pool, ph, backend, _A } = await helpers.loadFixture(deployPoolFixture);
    const policy = await defaultPolicyParams({});
    const policyEvt = await createPolicy(
      rm.connect(backend),
      pool,
      policyToArgs(policy, backend.address, ph.address, 1)
    );

    await ph.setBadlyImplemented(true);
    await expect(rm.connect(backend).resolvePolicy(policyEvt.args[1], _A("123"))).to.be.revertedWith(
      "PolicyPool: Invalid return value from IPolicyHolder"
    );
  });

  it("Resolving with a holder that doesn't implement the interface suceeds without executing the handling code", async () => {
    const { rm, pool, ph, backend, _A } = await helpers.loadFixture(deployPoolFixture);
    const policy = await defaultPolicyParams({});
    const policyEvt = await createPolicy(
      rm.connect(backend),
      pool,
      policyToArgs(policy, backend.address, ph.address, 1)
    );

    await ph.setNotImplemented(true);
    const tx = await rm.connect(backend).resolvePolicy(policyEvt.args[1], _A("123"));
    const receipt = await tx.wait();
    expect(await getTransactionEvent(ph.interface, receipt, "NotificationReceived")).to.be.null;
  });

  it("Resolving with a holder that doesn't implement ERC165 succeeds without executing the handling code", async () => {
    const { rm, pool, ph, backend, _A } = await helpers.loadFixture(deployPoolFixture);
    const policy = await defaultPolicyParams({});
    const policyEvt = await createPolicy(
      rm.connect(backend),
      pool,
      policyToArgs(policy, backend.address, ph.address, 1)
    );

    await ph.setNoERC165(true);
    const tx = await rm.connect(backend).resolvePolicy(policyEvt.args[1], _A("123"));
    const receipt = await tx.wait();
    expect(await getTransactionEvent(ph.interface, receipt, "NotificationReceived")).to.be.null;
  });
});

describe("PolicyHolder expiration handling", function () {
  it("Expiring with a functioning holder contract succeeds and executes the handler code", async () => {
    const { owner, pool, rm, ph, backend } = await helpers.loadFixture(deployPoolFixture);
    const policy = await defaultPolicyParams({});
    const policy1Evt = await createPolicy(
      rm.connect(backend),
      pool,
      policyToArgs(policy, backend.address, ph.address, 1)
    );

    await helpers.time.increaseTo(policy.expiration);
    await expect(pool.expirePolicy(policy1Evt.args[1]))
      .to.emit(ph, "NotificationReceived")
      .withArgs(NotificationKind.PolicyExpired, makePolicyId(rm.address, 1), owner.address, pool.address);
  });

  it("Expiring with a holder that reverts succeeds but doesn't execute the handler code", async () => {
    const { pool, rm, ph, backend } = await helpers.loadFixture(deployPoolFixture);
    const policy = await defaultPolicyParams({});

    const policyEvt = await createPolicy(
      rm.connect(backend),
      pool,
      policyToArgs(policy, backend.address, ph.address, 1)
    );
    await ph.setFail(true);
    await helpers.time.increaseTo(policy.expiration);
    const tx = await pool.expirePolicy(policyEvt.args[1]);
    const receipt = await tx.wait();
    expect(await getTransactionEvent(ph.interface, receipt, "NotificationReceived")).to.be.null;
  });

  it("Expiring with a holder that reverts empty succeeds but doesn't execute the handler code", async () => {
    const { pool, rm, ph, backend } = await helpers.loadFixture(deployPoolFixture);
    const policy = await defaultPolicyParams({});

    const policyEvt = await createPolicy(
      rm.connect(backend),
      pool,
      policyToArgs(policy, backend.address, ph.address, 1)
    );
    await ph.setFail(true);
    await ph.setEmptyRevert(true);
    await helpers.time.increaseTo(policy.expiration);
    const tx = await pool.expirePolicy(policyEvt.args[1]);
    const receipt = await tx.wait();
    expect(await getTransactionEvent(ph.interface, receipt, "NotificationReceived")).to.be.null;
  });

  it("Expiring with a holder that returns a bad value succeeds", async () => {
    const { owner, pool, rm, ph, backend } = await helpers.loadFixture(deployPoolFixture);
    const policy = await defaultPolicyParams({});
    const policy1Evt = await createPolicy(
      rm.connect(backend),
      pool,
      policyToArgs(policy, backend.address, ph.address, 1)
    );

    await ph.setBadlyImplemented(true);
    await helpers.time.increaseTo(policy.expiration);
    await expect(pool.expirePolicy(policy1Evt.args[1]))
      .to.emit(ph, "NotificationReceived")
      .withArgs(NotificationKind.PolicyExpired, makePolicyId(rm.address, 1), owner.address, pool.address);
  });

  it("Expiring with a holder that doesn't implement the interface succeeds", async () => {
    const { pool, rm, ph, backend } = await helpers.loadFixture(deployPoolFixture);
    const policy = await defaultPolicyParams({});
    const policy1Evt = await createPolicy(
      rm.connect(backend),
      pool,
      policyToArgs(policy, backend.address, ph.address, 1)
    );

    await ph.setNotImplemented(true);
    await helpers.time.increaseTo(policy.expiration);
    const tx = await pool.expirePolicy(policy1Evt.args[1]);
    const receipt = await tx.wait();
    expect(await getTransactionEvent(ph.interface, receipt, "NotificationReceived")).to.be.null;
  });

  it("Expiring with a holder that doesn't implement ERC165 succeeds", async () => {
    const { pool, rm, ph, backend } = await helpers.loadFixture(deployPoolFixture);
    const policy = await defaultPolicyParams({});
    const policy1Evt = await createPolicy(
      rm.connect(backend),
      pool,
      policyToArgs(policy, backend.address, ph.address, 1)
    );

    await ph.setNoERC165(true);
    await helpers.time.increaseTo(policy.expiration);
    const tx = await pool.expirePolicy(policy1Evt.args[1]);
    const receipt = await tx.wait();
    expect(await getTransactionEvent(ph.interface, receipt, "NotificationReceived")).to.be.null;
  });
});

async function deployPoolFixture() {
  const [owner, lp, cust, backend] = await ethers.getSigners();

  const _A = amountFunction(6);

  const currency = await initCurrency(
    { name: "Test USDC", symbol: "USDC", decimals: 6, initial_supply: _A(10000) },
    [lp, cust, backend],
    [_A(5000), _A(500), _A(1000)]
  );

  const pool = await deployPool({
    currency: currency.address,
    grantRoles: ["LEVEL1_ROLE", "LEVEL2_ROLE"],
    treasuryAddress: "0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199", // Random address
  });
  pool._A = _A;

  const etk = await addEToken(pool, {});

  const premiumsAccount = await deployPremiumsAccount(pool, { srEtkAddr: etk.address });

  const accessManager = await ethers.getContractAt("AccessManager", await pool.access());

  const RiskModule = await ethers.getContractFactory("RiskModuleMock");

  await currency.connect(lp).approve(pool.address, _A(5000));
  await currency.connect(backend).approve(pool.address, _A(5000));
  await pool.connect(lp).deposit(etk.address, _A(5000));

  const rm = await addRiskModule(pool, premiumsAccount, RiskModule, {
    extraArgs: [],
  });
  await accessManager.grantComponentRole(rm.address, await rm.PRICER_ROLE(), backend.address);
  await accessManager.grantComponentRole(rm.address, await rm.RESOLVER_ROLE(), backend.address);

  const PolicyHolderMock = await ethers.getContractFactory("PolicyHolderMock");
  const ph = await PolicyHolderMock.deploy();

  return { pool, currency, etk, premiumsAccount, RiskModule, rm, PolicyHolderMock, ph, _A, lp, cust, backend, owner };
}

function policyToArgs(policy, payer, onBehalfOf, internalId) {
  return [policy.payout, policy.premium, policy.lossProb, policy.expiration, payer, onBehalfOf, internalId];
}

async function createPolicy(rm, pool, policyArgs) {
  const tx = await rm.newPolicy(...policyArgs);
  const receipt = await tx.wait();

  return getTransactionEvent(pool.interface, receipt, "NewPolicy");
}
