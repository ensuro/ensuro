const { expect } = require("chai");
const hre = require("hardhat");
const helpers = require("@nomicfoundation/hardhat-network-helpers");

const { amountFunction } = require("@ensuro/utils/js/utils");
const { initCurrency } = require("@ensuro/utils/js/test-utils");
const { deployPool, addEToken, deployPremiumsAccount } = require("../js/test-utils");

const { ethers } = hre;
const { ZeroAddress, MaxUint256 } = ethers;

const _A = amountFunction(6);

async function setUp() {
  const [, lp, lp2] = await hre.ethers.getSigners();
  const currency = await initCurrency(
    { name: "Test USDC", symbol: "USDC", decimals: 6, initial_supply: _A(10000) },
    [lp, lp2],
    [_A(5000), _A(2000)]
  );

  const pool = await deployPool({
    currency: currency,
    treasuryAddress: "0x87c47c9a5a2aa74ae714857d64911d9a091c25b1", // Random address
  });
  pool._A = _A;

  const jrEtk = await addEToken(pool, {});
  const srEtk = await addEToken(pool, {});
  const pa = await deployPremiumsAccount(pool, { srEtk: srEtk, jrEtk: jrEtk });

  await currency.connect(lp).approve(pool, _A(5000));
  await pool.connect(lp).deposit(jrEtk, _A(3000), lp);

  return { currency, pool, jrEtk, srEtk, pa, lp, lp2 };
}

async function setUpWithVault() {
  const ret = await setUp();
  const { currency } = ret;
  const TestERC4626 = await ethers.getContractFactory("TestERC4626");
  const yieldVault = await TestERC4626.deploy("Yield Vault", "YIELD", currency);

  return { TestERC4626, yieldVault, ...ret };
}

describe("PremiumsAccount", () => {
  it("Checks the yieldVault is initialized as null and fails if invalid YV is set", async () => {
    const { pa, currency } = await helpers.loadFixture(setUp);
    expect(await pa.yieldVault()).to.equal(ZeroAddress);
    // Fails if I send an invalid vault
    await expect(pa.setYieldVault(currency, false)).to.be.revertedWithoutReason();
    await expect(pa.setYieldVault(ZeroAddress, true))
      .to.emit(pa, "EarningsRecorded")
      .withArgs(0)
      .to.emit(pa, "YieldVaultChanged")
      .withArgs(ZeroAddress, ZeroAddress, false)
      .not.to.emit(currency, "Approval");
  });

  it("Checks the funds can be sent to the yieldVault and earnings properly recorded", async () => {
    const { pa, currency, lp, yieldVault } = await helpers.loadFixture(setUpWithVault);
    await expect(pa.setYieldVault(yieldVault, false))
      .to.emit(pa, "EarningsRecorded")
      .withArgs(0)
      .to.emit(pa, "YieldVaultChanged")
      .withArgs(ZeroAddress, yieldVault, false)
      .to.emit(currency, "Approval")
      .withArgs(pa, yieldVault, MaxUint256);

    await currency.connect(lp).approve(pa, MaxUint256);

    await pa.connect(lp).receiveGrant(_A(1000));
    expect(await pa.surplus()).to.equal(_A(1000));

    await expect(pa.depositIntoYieldVault(_A(300)))
      .to.emit(yieldVault, "Deposit")
      .withArgs(pa, pa, _A(300), _A(300));

    expect(await pa.investedInYV()).to.equal(_A(300));
    expect(await pa.surplus()).to.equal(_A(1000)); // Surplus still the same

    await yieldVault.discreteEarning(_A(100));
    await expect(pa.recordEarnings())
      .to.emit(pa, "EarningsRecorded")
      .withArgs(_A(100) - 1n);
    expect(await pa.investedInYV()).to.equal(_A(400) - 1n);
    expect(await pa.surplus()).to.equal(_A(1100) - 1n);

    await yieldVault.discreteEarning(_A(-400));
    await expect(pa.recordEarnings())
      .to.emit(pa, "EarningsRecorded")
      .withArgs(-_A(400) + 1n);
    expect(await pa.surplus()).to.equal(_A(700));
    expect(await pa.investedInYV()).to.equal(0);
  });
});
