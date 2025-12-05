const { expect } = require("chai");
const hre = require("hardhat");
const helpers = require("@nomicfoundation/hardhat-network-helpers");

const { amountFunction, captureAny } = require("@ensuro/utils/js/utils");
const { initCurrency } = require("@ensuro/utils/js/test-utils");
const { deployPool } = require("../js/test-utils");
const { deployAMPProxy, getAccessManager } = require("@ensuro/access-managed-proxy/js/deployProxy");

const { ethers } = hre;
const { ZeroAddress, MaxUint256 } = ethers;

const _A = amountFunction(6);
const OverrideOption = {
  deposit: 0,
  mint: 1,
  withdraw: 2,
  redeem: 3,
};

async function setUp() {
  const [admin, lp, lp2] = await hre.ethers.getSigners();
  const currency = await initCurrency(
    { name: "Test USDC", symbol: "USDC", decimals: 6, initial_supply: _A(10000) },
    [lp, lp2],
    [_A(5000), _A(1000)]
  );

  const pool = await deployPool({
    currency: currency,
    treasuryAddress: "0x87c47c9a5a2aa74ae714857d64911d9a091c25b1", // Random address
  });
  pool._A = _A;

  const ReserveMock = await ethers.getContractFactory("ReserveMock");

  const reserve = await deployAMPProxy(ReserveMock, [], {
    constructorArgs: [await ethers.resolveAddress(pool)],
    acMgr: await getAccessManager(pool),
    skipViewsAndPure: true,
    skipMethods: [
      "addMoney",
      "transferTo",
      "setYieldVault",
      "withdrawFromYieldVault",
      "depositIntoYieldVault",
      "recordEarnings",
    ],
  });
  await reserve.waitForDeployment();

  const TestERC4626 = await ethers.getContractFactory("TestERC4626");
  const yieldVault = await TestERC4626.deploy("Yield Vault", "YIELD", currency);

  return { currency, pool, reserve, admin, lp, lp2, TestERC4626, yieldVault };
}

async function setUpWithYV() {
  const ret = await setUp();
  await expect(ret.reserve.setYieldVault(ret.yieldVault, false)).not.to.be.reverted;
  return ret;
}

describe("Reserve base contract", () => {
  it("Checks the yieldVault is initialized as null and fails if invalid YV is set", async () => {
    const { reserve, currency } = await helpers.loadFixture(setUp);
    expect(await reserve.yieldVault()).to.equal(ZeroAddress);
    // Fails if I send an invalid vault
    await expect(reserve.setYieldVault(currency, false)).to.be.revertedWithoutReason();
    await expect(reserve.setYieldVault(ZeroAddress, true))
      .to.emit(reserve, "EarningsRecorded")
      .withArgs(0)
      .to.emit(reserve, "YieldVaultChanged")
      .withArgs(ZeroAddress, ZeroAddress, false)
      .not.to.emit(currency, "Approval");
  });

  it("Checks setYieldVault fails if receives a yieldVault with a different currency", async () => {
    const { reserve, TestERC4626, yieldVault, currency } = await helpers.loadFixture(setUp);
    const euro = await initCurrency({ name: "Test EURC", symbol: "EURC", decimals: 6, initial_supply: _A(10000) }, []);
    const eurYC = await TestERC4626.deploy("Yield Vault EURC", "YIELDE", euro);

    await expect(reserve.setYieldVault(eurYC, false)).to.be.revertedWithCustomError(reserve, "InvalidYieldVault");
    await expect(reserve.setYieldVault(yieldVault, false))
      .to.emit(reserve, "EarningsRecorded")
      .withArgs(0)
      .to.emit(reserve, "YieldVaultChanged")
      .withArgs(ZeroAddress, yieldVault, false)
      .not.to.emit(currency, "Approval");
    expect(await reserve.yieldVault()).to.equal(yieldVault);
  });

  it("Checks rebalance methods and recordEarnings fail if yieldVault not set", async () => {
    const { reserve } = await helpers.loadFixture(setUp);
    await expect(reserve.recordEarnings()).to.be.revertedWithCustomError(reserve, "InvalidYieldVault");
    await expect(reserve.depositIntoYieldVault(_A(1))).to.be.revertedWithCustomError(reserve, "InvalidYieldVault");
    await expect(reserve.withdrawFromYieldVault(_A(1))).to.be.revertedWithCustomError(reserve, "InvalidYieldVault");
  });

  it("Checks deposits into the YV and earnings recorded", async () => {
    const { reserve, yieldVault, currency, lp } = await helpers.loadFixture(setUpWithYV);
    await currency.connect(lp).approve(reserve, MaxUint256);
    await reserve.connect(lp).addMoney(_A(100));
    expect(await currency.balanceOf(reserve)).to.equal(_A(100));

    await expect(reserve.depositIntoYieldVault(_A(101)))
      .to.be.revertedWithCustomError(reserve, "NotEnoughCash")
      .withArgs(_A(101), _A(100));

    await expect(reserve.depositIntoYieldVault(_A(30)))
      .to.emit(yieldVault, "Deposit")
      .withArgs(reserve, reserve, _A(30), _A(30))
      .to.emit(currency, "Approval")
      .withArgs(reserve, yieldVault, _A(30));

    expect(await reserve.investedInYV()).to.equal(_A(30));

    // Generate some profits in the YV
    await yieldVault.discreteEarning(_A(10));

    // investedInYV still 30
    expect(await reserve.investedInYV()).to.equal(_A(30));
    await expect(reserve.recordEarnings())
      .to.emit(reserve, "EarningsRecorded")
      .withArgs(_A(10) - 1n);
    // until I recordEarnings
    expect(await reserve.investedInYV()).to.closeTo(_A(40), 10n);

    // With MaxUint256 invest all the cash
    await expect(reserve.depositIntoYieldVault(MaxUint256))
      .to.emit(yieldVault, "Deposit")
      .withArgs(reserve, reserve, _A(70), captureAny.uint)
      .to.emit(currency, "Approval")
      .withArgs(reserve, yieldVault, _A(70));
    expect(await currency.allowance(reserve, yieldVault)).to.equal(0);
    expect(captureAny.lastUint).to.closeTo(await yieldVault.convertToShares(_A(70)), 10n);
    expect(await currency.balanceOf(reserve)).to.equal(_A(0));
    expect(await reserve.investedInYV()).to.closeTo(_A(110), 10n);

    // Generate some losses in the YV
    await yieldVault.discreteEarning(_A(-5));
    await expect(reserve.recordEarnings()).to.emit(reserve, "EarningsRecorded").withArgs(captureAny.value);
    expect(captureAny.lastValue).to.closeTo(_A(-5), 1n);
  });

  it("Checks manual withdrawals from the YV", async () => {
    const { reserve, yieldVault, currency, lp } = await helpers.loadFixture(setUpWithYV);
    await currency.connect(lp).approve(reserve, MaxUint256);
    await reserve.connect(lp).addMoney(_A(100));
    expect(await currency.balanceOf(reserve)).to.equal(_A(100));

    await expect(reserve.depositIntoYieldVault(MaxUint256))
      .to.emit(yieldVault, "Deposit")
      .withArgs(reserve, reserve, _A(100), _A(100));

    expect(await reserve.investedInYV()).to.equal(_A(100));

    await expect(reserve.withdrawFromYieldVault(_A(20)))
      .to.emit(yieldVault, "Withdraw")
      .withArgs(reserve, reserve, reserve, _A(20), _A(20));
    expect(await currency.balanceOf(reserve)).to.equal(_A(20));
    expect(await reserve.investedInYV()).to.equal(_A(80));

    // Generate some profits in the YV
    await yieldVault.discreteEarning(_A(10));

    // When doing a full withdrawal, the unrecorded earnings are recorded
    await expect(reserve.withdrawFromYieldVault(MaxUint256))
      .to.emit(yieldVault, "Withdraw")
      .withArgs(reserve, reserve, reserve, _A(90) - 1n, _A(80))
      .to.emit(reserve, "EarningsRecorded")
      .withArgs(_A(10) - 1n);
    expect(await reserve.investedInYV()).to.equal(_A(0));
  });

  it("Checks funds are deinvested with YV is replaced", async () => {
    const { reserve, yieldVault, currency, lp } = await helpers.loadFixture(setUpWithYV);
    await currency.connect(lp).approve(reserve, MaxUint256);
    await reserve.connect(lp).addMoney(_A(100));
    expect(await currency.balanceOf(reserve)).to.equal(_A(100));

    await expect(reserve.depositIntoYieldVault(MaxUint256))
      .to.emit(yieldVault, "Deposit")
      .withArgs(reserve, reserve, _A(100), _A(100));

    expect(await reserve.investedInYV()).to.equal(_A(100));
    expect(await currency.balanceOf(reserve)).to.equal(_A(0));

    await expect(reserve.setYieldVault(ZeroAddress, false))
      .to.emit(reserve, "YieldVaultChanged")
      .withArgs(yieldVault, ZeroAddress, false)
      .to.emit(yieldVault, "Withdraw")
      .withArgs(reserve, reserve, reserve, _A(100), _A(100))
      .to.emit(reserve, "EarningsRecorded")
      .withArgs(0)
      .not.to.emit(currency, "Approval");

    expect(await reserve.investedInYV()).to.equal(_A(0));
    expect(await currency.balanceOf(reserve)).to.equal(_A(100));
  });

  it("Checks funds are deinvested with YV is replaced - With unrecorded earnings", async () => {
    const { reserve, yieldVault, currency, lp } = await helpers.loadFixture(setUpWithYV);
    await currency.connect(lp).approve(reserve, MaxUint256);
    await reserve.connect(lp).addMoney(_A(100));
    expect(await currency.balanceOf(reserve)).to.equal(_A(100));

    await expect(reserve.depositIntoYieldVault(MaxUint256))
      .to.emit(yieldVault, "Deposit")
      .withArgs(reserve, reserve, _A(100), _A(100));

    expect(await reserve.investedInYV()).to.equal(_A(100));
    expect(await currency.balanceOf(reserve)).to.equal(_A(0));

    // Generate some profits in the YV
    await yieldVault.discreteEarning(_A(10));

    await expect(reserve.setYieldVault(ZeroAddress, false))
      .to.emit(reserve, "YieldVaultChanged")
      .withArgs(yieldVault, ZeroAddress, false)
      .to.emit(yieldVault, "Withdraw")
      .withArgs(reserve, reserve, reserve, _A(110) - 1n, _A(100))
      .to.emit(reserve, "EarningsRecorded")
      .withArgs(_A(10) - 1n)
      .not.to.emit(currency, "Approval");

    expect(await reserve.investedInYV()).to.equal(_A(0));
    expect(await currency.balanceOf(reserve)).to.equal(_A(110) - 1n);
  });

  it("Checks funds are deinvested with YV is replaced - With failing vault", async () => {
    const { reserve, yieldVault, currency, lp } = await helpers.loadFixture(setUpWithYV);
    await currency.connect(lp).approve(reserve, MaxUint256);
    await reserve.connect(lp).addMoney(_A(100));
    expect(await currency.balanceOf(reserve)).to.equal(_A(100));

    await expect(reserve.depositIntoYieldVault(MaxUint256))
      .to.emit(yieldVault, "Deposit")
      .withArgs(reserve, reserve, _A(100), _A(100));

    expect(await reserve.investedInYV()).to.equal(_A(100));
    expect(await currency.balanceOf(reserve)).to.equal(_A(0));

    // Generate some profits in the YV
    await yieldVault.setOverride(OverrideOption.redeem, _A(40));

    // Non-forced withdrawal fails because if can't withdraw all the funds
    await expect(reserve.setYieldVault(ZeroAddress, false))
      .to.be.revertedWithCustomError(yieldVault, "ERC4626ExceededMaxRedeem")
      .withArgs(reserve, _A(100), _A(40));

    // Forced withdrawal works fine, but withdraws just 40, recording the losses
    await expect(reserve.setYieldVault(ZeroAddress, true))
      .to.emit(reserve, "YieldVaultChanged")
      .withArgs(yieldVault, ZeroAddress, true)
      .to.emit(yieldVault, "Withdraw")
      .withArgs(reserve, reserve, reserve, _A(40), _A(40))
      .to.emit(reserve, "EarningsRecorded")
      .withArgs(-_A(60))
      .not.to.emit(currency, "Approval");

    // Connecting the YV again...
    await expect(reserve.setYieldVault(yieldVault, false))
      .to.emit(reserve, "YieldVaultChanged")
      .withArgs(ZeroAddress, yieldVault, false)
      .to.emit(reserve, "EarningsRecorded")
      .withArgs(0)
      .not.to.emit(currency, "Approval");

    // When I recordEarnings, the lost funds are recovered
    await expect(reserve.recordEarnings()).to.emit(reserve, "EarningsRecorded").withArgs(_A(60));
    expect(await reserve.investedInYV()).to.equal(_A(60));

    await yieldVault.setOverride(OverrideOption.redeem, await yieldVault.OVERRIDE_UNSET());
    await yieldVault.setBroken(true);

    // Non-forced withdrawal fails with the vault error
    await expect(reserve.setYieldVault(ZeroAddress, false)).to.be.revertedWithCustomError(yieldVault, "VaultIsBroken");

    // Forced withdrawal works fine, but it doesn't withdraw anything and records the losses
    await expect(reserve.setYieldVault(ZeroAddress, true))
      .to.emit(reserve, "YieldVaultChanged")
      .withArgs(yieldVault, ZeroAddress, true)
      .to.emit(reserve, "ErrorIgnoredDeinvestingVault")
      .withArgs(yieldVault, _A(60))
      .to.emit(reserve, "EarningsRecorded")
      .withArgs(-_A(60))
      .not.to.emit(currency, "Approval");
    expect(await reserve.investedInYV()).to.equal(_A(0));
  });

  it("Checks cash outs from the YV (_transferTo)", async () => {
    const { reserve, yieldVault, currency, lp, lp2 } = await helpers.loadFixture(setUpWithYV);
    await currency.connect(lp).approve(reserve, MaxUint256);
    await reserve.connect(lp).addMoney(_A(100));
    expect(await currency.balanceOf(reserve)).to.equal(_A(100));

    await expect(reserve.depositIntoYieldVault(MaxUint256))
      .to.emit(yieldVault, "Deposit")
      .withArgs(reserve, reserve, _A(100), _A(100));

    await expect(reserve.transferTo(lp2, _A(20)))
      .to.emit(yieldVault, "Withdraw")
      .withArgs(reserve, reserve, reserve, _A(20), _A(20))
      .to.emit(currency, "Transfer")
      .withArgs(reserve, lp2, _A(20));
    expect(await currency.balanceOf(lp2)).to.equal(_A(1020));

    // Withdraw some funds, the payment to the user will be done part with cash, and part deinvesting
    await expect(reserve.withdrawFromYieldVault(_A(12)))
      .to.emit(yieldVault, "Withdraw")
      .withArgs(reserve, reserve, reserve, _A(12), _A(12));

    // If it can cover with cash, doesn't withdraw from YV
    await expect(reserve.transferTo(lp2, _A(5))).not.to.emit(yieldVault, "Withdraw");
    expect(await currency.balanceOf(lp2)).to.equal(_A(1025));

    await expect(reserve.transferTo(lp2, _A(15)))
      .to.emit(yieldVault, "Withdraw")
      .withArgs(reserve, reserve, reserve, _A(8), _A(8));
    expect(await currency.balanceOf(lp2)).to.equal(_A(1040));

    expect(await reserve.investedInYV()).to.equal(_A(100 - 20 - 12 - 8));

    // _transferTo when destination = address(this) doesn't transfer, just makes sure the money is available
    await expect(reserve.transferTo(reserve, _A(10)))
      .to.emit(yieldVault, "Withdraw")
      .withArgs(reserve, reserve, reserve, _A(10), _A(10));
    expect(await currency.balanceOf(lp2)).to.equal(_A(1040));
    expect(await currency.balanceOf(reserve)).to.equal(_A(10));
    expect(await reserve.investedInYV()).to.equal(_A(100 - 20 - 12 - 8 - 10));

    // Add an earning of 20, now the YV has 70, but only 50 recorded.
    await yieldVault.discreteEarning(_A(20));

    // Now, if I transfer 80 (10 paid with cash and 70 from the vault), it should record 20 as earned
    await expect(reserve.transferTo(lp2, _A(80) - 1n))
      .to.emit(yieldVault, "Withdraw")
      .withArgs(reserve, reserve, reserve, _A(70) - 1n, _A(50))
      .to.emit(reserve, "EarningsRecorded")
      .withArgs(_A(20) - 1n);
    expect(await currency.balanceOf(lp2)).to.equal(_A(1040 + 80) - 1n);
  });

  it("Checks _transferTo works well with borderline input", async () => {
    const { reserve, yieldVault, currency, lp, lp2 } = await helpers.loadFixture(setUpWithYV);
    await currency.connect(lp).approve(reserve, MaxUint256);
    await reserve.connect(lp).addMoney(_A(100));
    expect(await currency.balanceOf(reserve)).to.equal(_A(100));

    await expect(reserve.depositIntoYieldVault(MaxUint256))
      .to.emit(yieldVault, "Deposit")
      .withArgs(reserve, reserve, _A(100), _A(100));

    await expect(reserve.transferTo(ZeroAddress, _A(20)))
      .to.be.revertedWithCustomError(reserve, "ReserveInvalidReceiver")
      .withArgs(ZeroAddress);

    await expect(reserve.transferTo(lp2, _A(0)))
      .not.to.emit(yieldVault, "Withdraw")
      .not.to.emit(currency, "Transfer");

    // If the vault is connected, it fails with ERC4626ExceededMaxWithdraw
    await expect(reserve.transferTo(lp2, _A(120)))
      .to.be.revertedWithCustomError(yieldVault, "ERC4626ExceededMaxWithdraw")
      .withArgs(reserve, _A(120), _A(100));

    // Disconnect the vault
    await expect(reserve.setYieldVault(ZeroAddress, false)).not.to.be.reverted;

    // Then it fails with ERC20 error
    await expect(reserve.transferTo(lp2, _A(120)))
      .to.be.revertedWithCustomError(currency, "ERC20InsufficientBalance")
      .withArgs(reserve, _A(100), _A(120));
  });

  it("Checks no redeem is called if YC without assets is disconnected", async () => {
    const { reserve, yieldVault } = await helpers.loadFixture(setUpWithYV);
    // Disconnect the vault
    await expect(reserve.setYieldVault(ZeroAddress, false)).not.to.emit(yieldVault, "Withdraw");
  });
});
