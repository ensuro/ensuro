const { expect } = require("chai");
const hre = require("hardhat");
const helpers = require("@nomicfoundation/hardhat-network-helpers");

const { amountFunction, captureAny, newCaptureAny, _W, _R } = require("@ensuro/utils/js/utils");
const { initCurrency } = require("@ensuro/utils/js/test-utils");
const { DAY } = require("@ensuro/utils/js/constants");
const { deployPool, addEToken } = require("../js/test-utils");

const { ethers } = hre;
const { ZeroAddress, MaxUint256 } = ethers;

const _A = amountFunction(6);

describe("Etoken", () => {
  it("Refuses transfers to null address", async () => {
    const { etk } = await helpers.loadFixture(etokenFixture);
    await expect(etk.transfer(hre.ethers.ZeroAddress, _A(10)))
      .to.be.revertedWithCustomError(etk, "ERC20InvalidReceiver")
      .withArgs(ZeroAddress);
  });

  it("Checks user balance", async () => {
    const { etk, lp, lp2 } = await helpers.loadFixture(etokenFixture);

    await expect(etk.connect(lp2).transfer(lp, _A(10)))
      .to.be.revertedWithCustomError(etk, "ERC20InsufficientBalance")
      .withArgs(lp2, _A(0), _A(10));
  });

  it("Returns the available funds", async () => {
    const { etk, pool, lp } = await helpers.loadFixture(etokenFixture);
    expect(await etk.fundsAvailable()).to.equal(_A(3000));

    await pool.connect(lp).withdraw(etk, _A(3000));

    expect(await etk.fundsAvailable()).to.equal(_A(0));
  });

  it("Only allows PolicyPool to add new borrowers", async () => {
    const { etk, lp } = await helpers.loadFixture(etokenFixture);

    await expect(etk.addBorrower(lp)).to.be.revertedWithCustomError(etk, "OnlyPolicyPool");
  });

  it("Only allows PolicyPool to remove borrowers", async () => {
    const { etk, lp } = await helpers.loadFixture(etokenFixture);

    await expect(etk.removeBorrower(lp)).to.be.revertedWithCustomError(etk, "OnlyPolicyPool");
  });

  it("Allows setting whitelist to null", async () => {
    const { etk } = await helpers.loadFixture(etokenFixture);

    expect(await etk.setWhitelist(hre.ethers.ZeroAddress)).to.emit(etk, "ComponentChanged");

    expect(await etk.whitelist()).to.equal(hre.ethers.ZeroAddress);
  });

  it("Can assign a yieldVault and rebalance funds there", async () => {
    const { etk, yieldVault, lp, pool } = await helpers.loadFixture(etkFixtureWithVault);

    await expect(etk.setYieldVault(yieldVault, false))
      .to.emit(etk, "YieldVaultChanged")
      .withArgs(ZeroAddress, yieldVault, false);

    await expect(etk.depositIntoYieldVault(_A(1200)))
      .to.emit(yieldVault, "Deposit")
      .withArgs(etk, etk, _A(1200), _A(1200));

    expect(await etk.balanceOf(lp)).to.equal(_A(3000)); // unchanged

    await yieldVault.discreteEarning(_A(300));

    await expect(etk.recordEarnings())
      .to.emit(etk, "EarningsRecorded")
      .withArgs(_A(300) - 1n);

    expect(await etk.balanceOf(lp)).to.equal(_A(3300) - 1n);

    await expect(pool.connect(lp).withdraw(etk, _A(2000)))
      .to.emit(etk, "Transfer")
      .withArgs(lp, ZeroAddress, _A(2000))
      .to.emit(yieldVault, "Withdraw")
      .withArgs(etk, etk, etk, _A(200), captureAny.uint);
    expect(captureAny.lastUint).to.closeTo(await yieldVault.convertToShares(_A(200)), 2n);
  });

  it("Can combines returns from locked SCR and from YV", async () => {
    const { etk, yieldVault, lp, fakePA, currency, pool } = await helpers.loadFixture(etkFixtureWithVault);

    await expect(etk.setYieldVault(yieldVault, false))
      .to.emit(etk, "YieldVaultChanged")
      .withArgs(ZeroAddress, yieldVault, false);

    await expect(etk.depositIntoYieldVault(_A(1200)))
      .to.emit(yieldVault, "Deposit")
      .withArgs(etk, etk, _A(1200), _A(1200));

    expect(await etk.getCurrentScale(false)).to.equal(_R(1));

    await yieldVault.discreteEarning(_A(300));

    await expect(etk.recordEarnings())
      .to.emit(etk, "EarningsRecorded")
      .withArgs(_A(300) - 1n);

    expect(await etk.getCurrentScale(false)).to.closeTo(_R("1.1"), _R("0.0000001"));

    await expect(etk.connect(fakePA).lockScr(_A(2000), _W("0.1")))
      .to.emit(etk, "SCRLocked")
      .withArgs(_W("0.1"), _A(2000));
    await currency.connect(fakePA).transfer(etk, _A(200)); // transfer the CoC

    expect(await etk.balanceOf(lp)).to.closeTo(_A(3300), 10n);
    // scale doesn't change yet
    expect(await etk.getCurrentScale(false)).to.closeTo(_R("1.1"), _R("0.0000001"));
    expect(await etk.getCurrentScale(true)).to.closeTo(_R("1.1"), _R("0.0000001"));

    // 73 days later (20% of the yeae), 20% of the interest has been accrued
    await helpers.time.increase(DAY * 73);
    expect(await etk.balanceOf(lp)).to.closeTo(_A(3340), 10n);
    // now the updated scale is affected
    expect(await etk.getCurrentScale(false)).to.closeTo(_R("1.1"), _R("0.0000001"));
    expect(await etk.getCurrentScale(true)).to.closeTo(_R("1.1133"), _R("0.0001"));

    // Go to the end of the year, unlock and withdraw all
    await helpers.time.increase(DAY * (365 - 73));

    await expect(etk.connect(fakePA).unlockScr(_A(2000), _W("0.1"), _A(0)))
      .to.emit(etk, "SCRUnlocked")
      .withArgs(_W("0.1"), _A(2000));

    expect(await etk.balanceOf(lp)).to.closeTo(_A(3500), 20n);
    // now the updated scale is affected
    expect(await etk.getCurrentScale(false)).to.closeTo(_R("1.1666"), _R("0.0001"));
    expect(await etk.getCurrentScale(true)).to.closeTo(_R("1.1666"), _R("0.0001"));

    // Full withdrawl fails due to rounding error
    await expect(pool.connect(lp).withdraw(etk, MaxUint256)).to.be.revertedWithCustomError(
      yieldVault,
      "ERC4626ExceededMaxWithdraw"
    );

    await currency.connect(fakePA).transfer(etk, _A("0.001")); // transfer pennies to fix the rounding error

    const etkBurned = newCaptureAny();
    const yvWithdraw = newCaptureAny();
    const yvWithdrawShares = newCaptureAny();
    await expect(pool.connect(lp).withdraw(etk, MaxUint256))
      .to.emit(etk, "Transfer")
      .withArgs(lp, ZeroAddress, etkBurned.uint)
      .to.emit(yieldVault, "Withdraw")
      .withArgs(etk, etk, etk, yvWithdraw.uint, yvWithdrawShares.uint);
    expect(etkBurned.lastUint).to.closeTo(_A(3500), 20n);
    expect(yvWithdraw.lastUint).to.closeTo(_A(1500), _A("0.001"));
    expect(yvWithdrawShares.lastUint).to.closeTo(_A(1200), _A("0.001"));
  });

  it("Checks loans can be paid from the yieldVault if needed", async () => {
    const { etk, yieldVault, fakePA, currency } = await helpers.loadFixture(etkFixtureWithVault);

    await expect(etk.setYieldVault(yieldVault, false))
      .to.emit(etk, "YieldVaultChanged")
      .withArgs(ZeroAddress, yieldVault, false);

    await expect(etk.depositIntoYieldVault(_A(1200)))
      .to.emit(yieldVault, "Deposit")
      .withArgs(etk, etk, _A(1200), _A(1200));

    await expect(etk.connect(fakePA).internalLoan(_A(2000), fakePA))
      .to.emit(etk, "InternalLoan")
      .withArgs(fakePA, _A(2000), _A(2000))
      .to.emit(yieldVault, "Withdraw")
      .withArgs(etk, etk, etk, _A(200), _A(200));

    await helpers.time.increase(90 * DAY);
    const loan = await etk.getLoan(fakePA);
    expect(loan).to.closeTo(_A(2000 + 2000 * 0.05 * (90 / 365)), _A("0.001"));

    await currency.connect(fakePA).approve(etk, MaxUint256);

    await expect(etk.connect(fakePA).repayLoan(loan, fakePA)).to.emit(etk, "InternalLoanRepaid").withArgs(fakePA, loan);

    const yvDeposit = newCaptureAny();
    const yvDepositShares = newCaptureAny();
    await expect(etk.depositIntoYieldVault(MaxUint256))
      .to.emit(yieldVault, "Deposit")
      .withArgs(etk, etk, yvDeposit.uint, yvDepositShares.uint);

    expect(yvDeposit.lastUint).to.closeTo(loan, _A("0.001"));
    expect(yvDepositShares.lastUint).to.closeTo(loan, _A("0.001"));
  });

  it("Checks asset earning when totalSupply() == 0", async () => {
    const { etk, yieldVault, lp, fakePA, currency, pool } = await helpers.loadFixture(etkFixtureWithVault);

    await expect(etk.setYieldVault(yieldVault, false))
      .to.emit(etk, "YieldVaultChanged")
      .withArgs(ZeroAddress, yieldVault, false);

    await pool.connect(lp).withdraw(etk, MaxUint256);
    expect(await etk.totalSupply()).to.equal(0);

    // Mint 1 share for etk and generate 100 in earnings
    await currency.connect(fakePA).approve(yieldVault, MaxUint256);
    await yieldVault.connect(fakePA).mint(1n, etk);
    await yieldVault.discreteEarning(_A(100));

    await expect(etk.recordEarnings())
      .to.emit(etk, "EarningsRecorded")
      .withArgs(_A(50) + 1n); // The vault has one virtual share, so the etk gets 50% of the earning

    expect(await etk.totalSupply()).to.equal(_A(50) + 1n);
    await pool.connect(lp).deposit(etk, _A(1000));
    await expect(pool.connect(lp).withdraw(etk, MaxUint256)).to.emit(currency, "Transfer").withArgs(etk, lp, _A(1000));

    // Check BEFORE RELEASE: is this correct? Who owns this total supply?
    expect(await etk.totalSupply()).to.equal(_A(50) + 1n);
  });

  async function etokenFixture() {
    const [, lp, lp2, fakePA] = await hre.ethers.getSigners();
    const currency = await initCurrency(
      { name: "Test USDC", symbol: "USDC", decimals: 6, initial_supply: _A(10000) },
      [lp, fakePA],
      [_A(5000), _A(2000)]
    );

    const pool = await deployPool({
      currency: currency,
      treasuryAddress: "0x87c47c9a5a2aa74ae714857d64911d9a091c25b1", // Random address
    });
    pool._A = _A;

    const etk = await addEToken(pool, {});

    await currency.connect(lp).approve(pool, _A(5000));
    await pool.connect(lp).deposit(etk, _A(3000));

    return { currency, pool, etk, lp, lp2, fakePA };
  }

  async function etkFixtureWithVault() {
    const ret = await etokenFixture();
    const { pool, currency, fakePA, etk } = ret;
    const TestERC4626 = await ethers.getContractFactory("TestERC4626");
    const yieldVault = await TestERC4626.deploy("Yield Vault", "YIELD", currency);

    // Impersonate pool and add fakePA as borrower
    const poolAddr = await ethers.resolveAddress(pool);
    await helpers.impersonateAccount(poolAddr);
    await helpers.setBalance(poolAddr, ethers.parseEther("100"));
    const poolImpersonated = await ethers.getSigner(poolAddr);
    await expect(etk.connect(poolImpersonated).addBorrower(fakePA))
      .to.emit(etk, "InternalBorrowerAdded")
      .withArgs(fakePA);

    return { poolImpersonated, TestERC4626, yieldVault, ...ret };
  }
});
