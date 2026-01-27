const { expect } = require("chai");
const hre = require("hardhat");
const helpers = require("@nomicfoundation/hardhat-network-helpers");

const { amountFunction, captureAny, newCaptureAny, _W, makeEIP2612Signature } = require("@ensuro/utils/js/utils");
const { initCurrency } = require("@ensuro/utils/js/test-utils");
const { DAY } = require("@ensuro/utils/js/constants");
const { deployPool, addEToken, deployWhitelist, deployCooler } = require("../js/test-utils");
const { makeWhitelistStatus } = require("../js/utils");
const { ETokenParameter } = require("../js/enums");

const { ethers } = hre;
const { ZeroAddress, MaxUint256 } = ethers;

const _A = amountFunction(6);

describe("Etoken", () => {
  it("Refuses transfers to null address", async () => {
    const { etk } = await helpers.loadFixture(etokenFixture);
    await expect(etk.transfer(ZeroAddress, _A(10)))
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

    await pool.connect(lp).withdraw(etk, _A(3000), lp, lp);

    expect(await etk.fundsAvailable()).to.equal(_A(0));
  });

  it("Checks utilizationRate is zero when totalSupply = 0", async () => {
    const { etk, pool, lp } = await helpers.loadFixture(etokenFixture);
    await pool.connect(lp).withdraw(etk, _A(3000), lp, lp);

    expect(await etk.totalSupply()).to.equal(_A(0));
    expect(await etk.utilizationRate()).to.equal(_A(0));
  });

  /**
   * Even when both Grok and DeepSeek say that typically zero deposits and transfers are rejected by other
   * protocols, the fact is OZ's ERC4626 and Morpho metavaults accept them, so we will accept it too
   */
  it("Checks zero amount deposits are ACCEPTED", async () => {
    const { etk, pool, lp } = await helpers.loadFixture(etokenFixture);
    await pool.connect(lp).deposit(etk, _A(0), lp);
  });

  it("Checks zero amount transfers are ACCEPTED", async () => {
    const { etk, lp, lp2 } = await helpers.loadFixture(etokenFixture);
    await etk.connect(lp).transfer(lp2, _A(0));
  });

  it("Only allows PolicyPool to add new borrowers", async () => {
    const { etk, lp } = await helpers.loadFixture(etokenFixture);

    await expect(etk.addBorrower(lp)).to.be.revertedWithCustomError(etk, "OnlyPolicyPool");
  });

  it("Can add new borrowers only once", async () => {
    const { etk, poolImpersonated, fakePA } = await helpers.loadFixture(etkFixtureWithVault);

    await expect(etk.connect(poolImpersonated).addBorrower(fakePA))
      .to.be.revertedWithCustomError(etk, "BorrowerAlreadyAdded")
      .withArgs(fakePA);
  });

  it("Only allows PolicyPool to remove borrowers", async () => {
    const { etk, lp } = await helpers.loadFixture(etokenFixture);

    await expect(etk.removeBorrower(lp)).to.be.revertedWithCustomError(etk, "OnlyPolicyPool");
  });

  it("Can remove existing borrowers", async () => {
    const { etk, poolImpersonated, fakePA } = await helpers.loadFixture(etkFixtureWithVault);

    await expect(etk.connect(poolImpersonated).removeBorrower(ZeroAddress))
      .to.be.revertedWithCustomError(etk, "InvalidBorrower")
      .withArgs(ZeroAddress);
    await expect(etk.connect(poolImpersonated).removeBorrower(fakePA))
      .to.emit(etk, "InternalBorrowerRemoved")
      .withArgs(fakePA, _W(0));
  });

  it("Only can take loan on existing borrowers", async () => {
    const { etk, currency, fakePA, lp2 } = await helpers.loadFixture(etkFixtureWithVault);

    await expect(etk.connect(lp2).internalLoan(_A(100), lp2))
      .to.be.revertedWithCustomError(etk, "OnlyBorrower")
      .withArgs(lp2);
    await expect(etk.connect(fakePA).internalLoan(_A(0), lp2)).not.to.emit(etk, "InternalLoan");
    await expect(etk.connect(fakePA).internalLoan(_A(100), lp2))
      .to.emit(etk, "InternalLoan")
      .withArgs(fakePA, _A(100), _A(100));
    expect(await currency.balanceOf(lp2)).to.equal(_A(100));

    const maxNA = await etk.maxNegativeAdjustment();
    expect(maxNA).to.closeTo(_A(3000 - 100), 10n);

    await expect(etk.connect(fakePA).internalLoan(MaxUint256, lp2))
      .to.emit(etk, "InternalLoan")
      .withArgs(fakePA, maxNA, MaxUint256);
    expect(await etk.totalSupply()).to.equal(1n);
  });

  it("Checks only borrower can lock and unlock capital", async () => {
    const { etk, fakePA, lp2 } = await helpers.loadFixture(etkFixtureWithVault);

    await expect(etk.connect(lp2).lockScr(1234n, _A(100), _W("0.1")))
      .to.be.revertedWithCustomError(etk, "OnlyBorrower")
      .withArgs(lp2);

    await expect(etk.connect(lp2).unlockScr(1234n, _A(100), _W("0.1"), _A(0)))
      .to.be.revertedWithCustomError(etk, "OnlyBorrower")
      .withArgs(lp2);

    await expect(etk.connect(lp2).unlockScrWithRefund(1234n, _A(100), _W("0.1"), _A(0), fakePA, _A(0)))
      .to.be.revertedWithCustomError(etk, "OnlyBorrower")
      .withArgs(lp2);
  });

  it("Only can repay loan on existing borrowers", async () => {
    const { etk, currency, fakePA, lp2, lp } = await helpers.loadFixture(etkFixtureWithVault);

    await expect(etk.repayLoan(_A(100), lp2))
      .to.be.revertedWithCustomError(etk, "InvalidBorrower")
      .withArgs(lp2);

    // repayLoan exceeding current debt, fails with panic
    await expect(etk.repayLoan(_A(1), fakePA)).to.be.revertedWithPanic(0x11);

    await expect(etk.connect(fakePA).internalLoan(_A(100), lp2))
      .to.emit(etk, "InternalLoan")
      .withArgs(fakePA, _A(100), _A(100));

    expect(await etk.getLoan(fakePA)).to.equal(_A(100));

    // repayLoan exceeding current debt, fails with panic - Same when there's debt
    await expect(etk.repayLoan(_A(110), fakePA)).to.be.revertedWithPanic(0x11);

    await currency.connect(lp).approve(etk, _A(101));
    await expect(etk.connect(lp).repayLoan(_A(100) + 1n, fakePA)).to.revertedWithPanic(0x11);

    await expect(etk.connect(lp).repayLoan(_A(100), fakePA))
      .to.emit(etk, "InternalLoanRepaid")
      .withArgs(fakePA, _A(100));
    expect(await currency.allowance(lp, etk)).to.equal(_A(1));
    expect(await etk.getLoan(fakePA)).to.equal(_A(0));
  });

  it("Validates the parameter changes", async () => {
    const { etk } = await helpers.loadFixture(etokenFixture);

    await expect(etk.setParam(ETokenParameter.liquidityRequirement, _W(0)))
      .to.be.revertedWithCustomError(etk, "InvalidParameter")
      .withArgs(ETokenParameter.liquidityRequirement);
    await expect(etk.setParam(ETokenParameter.liquidityRequirement, _W(2)))
      .to.be.revertedWithCustomError(etk, "InvalidParameter")
      .withArgs(ETokenParameter.liquidityRequirement);
    await expect(etk.setParam(ETokenParameter.liquidityRequirement, _W("1.05")))
      .to.emit(etk, "ParameterChanged")
      .withArgs(ETokenParameter.liquidityRequirement, _W("1.05"));

    await expect(etk.setParam(ETokenParameter.minUtilizationRate, _W(2)))
      .to.be.revertedWithCustomError(etk, "InvalidParameter")
      .withArgs(ETokenParameter.minUtilizationRate);
    await expect(etk.setParam(ETokenParameter.minUtilizationRate, _W("0.10")))
      .to.emit(etk, "ParameterChanged")
      .withArgs(ETokenParameter.minUtilizationRate, _W("0.10"));

    await expect(etk.setParam(ETokenParameter.maxUtilizationRate, _W(1) + 1n))
      .to.be.revertedWithCustomError(etk, "InvalidParameter")
      .withArgs(ETokenParameter.maxUtilizationRate);
    await expect(etk.setParam(ETokenParameter.maxUtilizationRate, _W("0.80")))
      .to.emit(etk, "ParameterChanged")
      .withArgs(ETokenParameter.maxUtilizationRate, _W("0.80"));

    await expect(etk.setParam(ETokenParameter.internalLoanInterestRate, _W("0.5") + 1n))
      .to.be.revertedWithCustomError(etk, "InvalidParameter")
      .withArgs(ETokenParameter.internalLoanInterestRate);
    await expect(etk.setParam(ETokenParameter.internalLoanInterestRate, _W("0.15")))
      .to.emit(etk, "ParameterChanged")
      .withArgs(ETokenParameter.internalLoanInterestRate, _W("0.15"));

    // Checks other parameters fails
    await expect(
      etk.setParam(ETokenParameter.internalLoanInterestRate + 1, _W("0.5") + 1n)
    ).to.be.revertedWithoutReason();
  });

  it("Can remove the whitelist", async () => {
    const { etk, wl } = await helpers.loadFixture(etkFixtureWithWL);

    await expect(etk.setWhitelist(ZeroAddress)).to.emit(etk, "WhitelistChanged").withArgs(wl, ZeroAddress);
  });

  it("Checks the whitelist belongs to the same pool", async () => {
    const { etk, wl, currency } = await helpers.loadFixture(etkFixtureWithWL);
    const otherPool = await deployPool({
      currency: currency,
      treasuryAddress: "0x87c47c9a5a2aa74ae714857d64911d9a091c25b1", // Random address
    });
    const otherWL = await deployWhitelist(otherPool, {});
    await expect(etk.setWhitelist(otherWL)).to.be.revertedWithCustomError(etk, "InvalidWhitelist").withArgs(otherWL);
    await expect(etk.setWhitelist(ZeroAddress)).not.to.be.reverted;
    await expect(etk.setWhitelist(wl)).not.to.be.reverted;
  });

  it("Can change the cooler and emits event", async () => {
    const { etk, pool } = await helpers.loadFixture(etokenFixture);

    await expect(etk.setCooler(ZeroAddress)).to.emit(etk, "CoolerChanged").withArgs(ZeroAddress, ZeroAddress);

    const cooler = await deployCooler(pool, {});

    await expect(etk.setCooler(cooler)).to.emit(etk, "CoolerChanged").withArgs(ZeroAddress, cooler);
    expect(await etk.cooler()).to.equal(cooler);

    await expect(etk.setCooler(ZeroAddress)).to.emit(etk, "CoolerChanged").withArgs(cooler, ZeroAddress);
    expect(await etk.cooler()).to.equal(ZeroAddress);
  });

  it("Checks the cooler belongs to the same pool", async () => {
    const { etk, pool, currency } = await helpers.loadFixture(etokenFixture);
    const otherPool = await deployPool({
      currency: currency,
      treasuryAddress: "0x87c47c9a5a2aa74ae714857d64911d9a091c25b1", // Random address
    });
    const otherCooler = await deployWhitelist(otherPool, {});
    await expect(etk.setCooler(otherCooler)).to.be.revertedWithCustomError(etk, "InvalidCooler").withArgs(otherCooler);
    const cooler = await deployCooler(pool, {});
    await expect(etk.setCooler(cooler)).not.to.be.reverted;
  });

  it("Only allows PolicyPool to call deposit", async () => {
    const { etk, lp } = await helpers.loadFixture(etokenFixture);

    await expect(etk.connect(lp).deposit(_A(100), lp, lp)).to.be.revertedWithCustomError(etk, "OnlyPolicyPool");
  });

  it("Only allows PolicyPool to call withdraw", async () => {
    const { etk, lp } = await helpers.loadFixture(etokenFixture);

    await expect(etk.connect(lp).withdraw(_A(100), lp, lp, lp)).to.be.revertedWithCustomError(etk, "OnlyPolicyPool");
  });

  it("Checks tokenInterestRate is zero when TS is zero", async () => {
    const { pool, lp, etk } = await helpers.loadFixture(etokenFixture);

    await expect(pool.connect(lp).withdraw(etk, MaxUint256, lp, lp))
      .to.emit(pool, "Withdraw")
      .withArgs(etk, lp, lp, lp, _A(3000));
    expect(await etk.totalSupply()).to.equal(0);
    expect(await etk.tokenInterestRate()).to.equal(0);
  });

  it("Can deposit to a different receiver", async () => {
    const { etk, lp, pool, lp2 } = await helpers.loadFixture(etokenFixture);

    expect(await etk.balanceOf(lp)).to.equal(_A(3000));
    expect(await etk.balanceOf(lp2)).to.equal(_A(0));

    await expect(pool.connect(lp).deposit(etk, _A(30), lp2))
      .to.emit(pool, "Deposit")
      .withArgs(etk, lp, lp2, _A(30));
    expect(await etk.balanceOf(lp2)).to.equal(_A(30));
  });

  it("Can withdraw to a different receiver", async () => {
    const { etk, lp, pool, lp2, currency } = await helpers.loadFixture(etokenFixture);

    expect(await etk.balanceOf(lp)).to.equal(_A(3000));
    expect(await etk.balanceOf(lp2)).to.equal(_A(0));

    await expect(pool.connect(lp).withdraw(etk, _A(30), lp2, lp))
      .to.emit(pool, "Withdraw")
      .withArgs(etk, lp, lp2, lp, _A(30));
    expect(await currency.balanceOf(lp2)).to.equal(_A(30));

    await expect(pool.connect(lp2).withdraw(etk, _A(20), lp2, lp))
      .to.be.revertedWithCustomError(etk, "ERC20InsufficientAllowance")
      .withArgs(lp2, _A(0), _A(20));

    await etk.connect(lp).approve(lp2, MaxUint256);

    await expect(pool.connect(lp2).withdraw(etk, _A(10), lp2, lp))
      .to.emit(pool, "Withdraw")
      .withArgs(etk, lp2, lp2, lp, _A(10));
    expect(await currency.balanceOf(lp2)).to.equal(_A(40));
  });

  it("Can withdraw using EIP-2612 approval", async () => {
    const { etk, lp, pool, lp2, currency } = await helpers.loadFixture(etokenFixture);

    expect(await etk.balanceOf(lp)).to.equal(_A(3000));
    expect(await etk.balanceOf(lp2)).to.equal(_A(0));

    const { sig, deadline } = await makeEIP2612Signature(hre, etk, lp, await ethers.resolveAddress(lp2), _A(300));

    // Doing manual permit in a different transaction. Typically, this will be done by a contract that implements
    // withdrawWithPermit or something like that, but I prefer to leave that outside the protocol.
    await expect(etk.permit(lp, lp2, _A(300), deadline, sig.v, sig.r, sig.s))
      .to.emit(etk, "Approval")
      .withArgs(lp, lp2, _A(300));
    expect(await etk.allowance(lp, lp2)).to.be.equal(_A(300));

    await expect(pool.connect(lp2).withdraw(etk, _A(10), lp2, lp))
      .to.emit(pool, "Withdraw")
      .withArgs(etk, lp2, lp2, lp, _A(10));
    expect(await currency.balanceOf(lp2)).to.equal(_A(10));
    expect(await etk.allowance(lp, lp2)).to.be.equal(_A(290));
  });

  it("Can deposit to a different receiver - Whitelist version", async () => {
    const { etk, lp, pool, lp2, wl } = await helpers.loadFixture(etkFixtureWithWL);

    await expect(pool.connect(lp).deposit(etk, _A(30), lp2))
      .to.be.revertedWithCustomError(etk, "DepositNotWhitelisted")
      .withArgs(lp, _A(30));

    expect(await wl.acceptsTransfer(etk, lp, lp2, _A(30))).to.equal(true);
    expect(await wl.acceptsDeposit(etk, lp, _A(30))).to.equal(false);

    await expect(wl.whitelistAddress(lp, makeWhitelistStatus("WWWW")))
      .to.emit(wl, "LPWhitelistStatusChanged")
      .withArgs(lp, makeWhitelistStatus("WWWW"));

    expect(await wl.acceptsTransfer(etk, lp, lp2, _A(30))).to.equal(true);
    expect(await wl.acceptsDeposit(etk, lp, _A(30))).to.equal(true);

    await expect(pool.connect(lp).deposit(etk, _A(30), lp2))
      .to.emit(pool, "Deposit")
      .withArgs(etk, lp, lp2, _A(30));
    expect(await etk.balanceOf(lp2)).to.equal(_A(30));

    // Now, I restrict transfers sent from lp, so it should fail
    await wl.whitelistAddress(lp, makeWhitelistStatus("WWBB"));

    await expect(pool.connect(lp).deposit(etk, _A(40), lp2))
      .to.be.revertedWithCustomError(etk, "DepositNotWhitelisted")
      .withArgs(lp, _A(40));

    // Same if lp2 is restricted to receive transfers
    await wl.whitelistAddress(lp, makeWhitelistStatus("WWWW"));
    await wl.whitelistAddress(lp2, makeWhitelistStatus("WWBB"));

    await expect(pool.connect(lp).deposit(etk, _A(50), lp2))
      .to.be.revertedWithCustomError(etk, "DepositNotWhitelisted")
      .withArgs(lp, _A(50));

    // But lp can deposit to itself
    await expect(pool.connect(lp).deposit(etk, _A(50), lp))
      .to.emit(pool, "Deposit")
      .withArgs(etk, lp, lp, _A(50));
  });

  it("Can withdraw to a different receiver - Whitelist version", async () => {
    const { etk, lp, pool, lp2, wl, currency } = await helpers.loadFixture(etkFixtureWithWL);

    // First try to withdraw, but since LP is not whitelisted, it should fail
    await expect(pool.connect(lp).withdraw(etk, _A(10), lp, lp))
      .to.be.revertedWithCustomError(etk, "WithdrawalNotWhitelisted")
      .withArgs(lp, _A(10));

    await wl.whitelistAddress(lp, makeWhitelistStatus("WWWW"));

    // Now it's OK to withdraw to itself
    await expect(pool.connect(lp).withdraw(etk, _A(10), lp, lp))
      .to.emit(pool, "Withdraw")
      .withArgs(etk, lp, lp, lp, _A(10));

    // Same withdrawing to someone else
    await expect(pool.connect(lp).withdraw(etk, _A(20), lp2, lp))
      .to.emit(pool, "Withdraw")
      .withArgs(etk, lp, lp2, lp, _A(20));

    expect(await currency.balanceOf(lp2)).to.equal(_A(20));

    // But it fails if operating lp's tokens from lp2 account
    await expect(pool.connect(lp2).withdraw(etk, _A(20), lp2, lp))
      .to.be.revertedWithCustomError(etk, "ERC20InsufficientAllowance")
      .withArgs(lp2, _A(0), _A(20));

    await expect(etk.connect(lp).approve(lp2, _A(30)))
      .to.emit(etk, "Approval")
      .withArgs(lp, lp2, _A(30));

    // Now with approval works fine
    await expect(pool.connect(lp2).withdraw(etk, _A(20), lp2, lp))
      .to.emit(pool, "Withdraw")
      .withArgs(etk, lp2, lp2, lp, _A(20));

    // Doing it again fails, because spending approval was used
    await expect(pool.connect(lp2).withdraw(etk, _A(20), lp2, lp))
      .to.be.revertedWithCustomError(etk, "ERC20InsufficientAllowance")
      .withArgs(lp2, _A(10), _A(20));
  });

  it("Allows setting whitelist to null", async () => {
    const { etk } = await helpers.loadFixture(etokenFixture);

    const oldWL = await etk.whitelist();

    expect(await etk.setWhitelist(ZeroAddress))
      .to.emit(etk, "WhitelistChanged")
      .withArgs(oldWL, ZeroAddress);

    expect(await etk.whitelist()).to.equal(ZeroAddress);
  });

  it("Checks funds can be unlocked with refund of CoC", async () => {
    const { etk, fakePA, currency } = await helpers.loadFixture(etkFixtureWithVault);
    await expect(etk.connect(fakePA).lockScr(1234n, _A(2000), _W("0.1")))
      .to.emit(etk, "SCRLocked")
      .withArgs(1234n, _W("0.1"), _A(2000));
    await currency.connect(fakePA).transfer(etk, _A(200)); // Transfer the CoC (assuming annual policy)
    expect(await etk.totalWithdrawable()).to.closeTo(_A(1000), 100n);
    expect(await currency.balanceOf(etk)).to.equal(_A(3200));

    const balanceBefore = await currency.balanceOf(fakePA);

    await helpers.time.increase(DAY * 180); // ~100 accrued
    await expect(etk.connect(fakePA).unlockScrWithRefund(1234n, _A(2000), _W("0.1"), _A(-10), fakePA, _A(110)))
      .to.emit(etk, "SCRUnlocked")
      .withArgs(1234n, _W("0.1"), _A(2000), _A(-10))
      .to.emit(etk, "CoCRefunded")
      .withArgs(1234n, fakePA, _A(110));

    expect(await etk.utilizationRate()).to.equal(_A(0));
    expect(await currency.balanceOf(fakePA)).to.equal(balanceBefore + _A(110));
  });

  it("Checks totalWithdrawable is zero when SCR > totalSupply", async () => {
    const { etk, fakePA } = await helpers.loadFixture(etkFixtureWithVault);
    await expect(etk.connect(fakePA).lockScr(1234n, _A(2000), _W("0.1")))
      .to.emit(etk, "SCRLocked")
      .withArgs(1234n, _W("0.1"), _A(2000));
    expect(await etk.totalWithdrawable()).to.equal(_A(1000));
    expect(await etk.utilizationRate()).to.closeTo(_W(".6667"), _W("0.001"));

    await expect(etk.connect(fakePA).internalLoan(_A(1500), fakePA))
      .to.emit(etk, "InternalLoan")
      .withArgs(fakePA, _A(1500), _A(1500));
    expect(await etk.totalWithdrawable()).to.equal(_A(0));
    expect(await etk.utilizationRate()).to.closeTo(_W("1.333"), _W("0.001"));
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

    expect(await etk.balanceOf(lp)).to.equal(_A(3300) - 2n);

    await expect(pool.connect(lp).withdraw(etk, _A(2000), lp, lp))
      .to.emit(etk, "Transfer")
      .withArgs(lp, ZeroAddress, _A(2000))
      .to.emit(yieldVault, "Withdraw")
      .withArgs(etk, etk, etk, _A(200), captureAny.uint);
    expect(captureAny.lastUint).to.closeTo(await yieldVault.convertToShares(_A(200)), 2n);
  });

  it("LP cannot exit the pool before yieldVault losses are recorded", async () => {
    const { etk, yieldVault, lp, pool, currency } = await helpers.loadFixture(etkFixtureWithVault);

    await etk.setYieldVault(yieldVault, false);

    await etk.depositIntoYieldVault(_A(1200));

    expect(await etk.balanceOf(lp)).to.equal(_A(3000)); // sanity check
    expect(await etk.totalSupply()).to.equal(_A(3000)); // sanity check

    await yieldVault.discreteEarning(-_A(300)); // simulate a loss of 300

    // Losses are not recorded yet
    expect(await etk.totalSupply()).to.equal(_A(3000));
    expect(await etk.balanceOf(lp)).to.equal(_A(3000));

    // When the LP withdraws, the losses are recorded
    await expect(pool.connect(lp).withdraw(etk, _A(100), lp, lp))
      .to.emit(currency, "Transfer")
      .withArgs(etk, lp, _A(100))
      .to.emit(etk, "EarningsRecorded")
      .withArgs(-_A(300));

    // The LP took the loss
    expect(await etk.totalSupply()).to.be.closeTo(_A(2600), _A(1));
    expect(await etk.balanceOf(lp)).to.be.closeTo(_A(2600), _A(1)); // 3000 - 300 in losses - 100 withdrawn

    // Additional losses are incurred
    await yieldVault.discreteEarning(-_A(500));

    // When the LP withdraws all, the losses are recorded and they less than expected
    const initialUSDC = await currency.balanceOf(lp);
    await expect(pool.connect(lp).withdraw(etk, MaxUint256, lp, lp))
      .to.emit(etk, "EarningsRecorded")
      .withArgs(-_A(500));

    // Cannot use changeTokenBalance assertion because we need a closeTo check
    expect(await currency.balanceOf(lp)).to.be.closeTo(initialUSDC + _A(2100), _A(1)); // 2600 - 500 in losses

    expect(await etk.totalSupply()).to.equal(_A(0));
    expect(await etk.balanceOf(lp)).to.equal(_A(0)); // All withdrawn
  });

  it("Can combines returns from locked SCR and from YV", async () => {
    const { etk, yieldVault, lp, fakePA, currency, pool } = await helpers.loadFixture(etkFixtureWithVault);

    await expect(etk.setYieldVault(yieldVault, false))
      .to.emit(etk, "YieldVaultChanged")
      .withArgs(ZeroAddress, yieldVault, false);

    await expect(etk.depositIntoYieldVault(_A(1200)))
      .to.emit(yieldVault, "Deposit")
      .withArgs(etk, etk, _A(1200), _A(1200));

    expect(await etk.getCurrentScale(false)).to.equal(_W(1));

    await yieldVault.discreteEarning(_A(300));

    await expect(etk.recordEarnings())
      .to.emit(etk, "EarningsRecorded")
      .withArgs(_A(300) - 1n);

    expect(await etk.getCurrentScale(false)).to.closeTo(_W("1.1"), _W("0.0000001"));

    await expect(etk.connect(fakePA).lockScr(123, _A(2000), _W("0.1")))
      .to.emit(etk, "SCRLocked")
      .withArgs(123, _W("0.1"), _A(2000));
    await currency.connect(fakePA).transfer(etk, _A(200)); // transfer the CoC

    expect(await etk.balanceOf(lp)).to.closeTo(_A(3300), 10n);
    // scale doesn't change yet
    expect(await etk.getCurrentScale(false)).to.closeTo(_W("1.1"), _W("0.0000001"));
    expect(await etk.getCurrentScale(true)).to.closeTo(_W("1.1"), _W("0.0000001"));

    // 73 days later (20% of the yeae), 20% of the interest has been accrued
    await helpers.time.increase(DAY * 73);
    expect(await etk.balanceOf(lp)).to.closeTo(_A(3340), 10n);
    // now the updated scale is affected
    expect(await etk.getCurrentScale(false)).to.closeTo(_W("1.1"), _W("0.0000001"));
    expect(await etk.getCurrentScale(true)).to.closeTo(_W("1.1133"), _W("0.0001"));

    // Go to the end of the year, unlock and withdraw all
    await helpers.time.increase(DAY * (365 - 73));

    await expect(etk.connect(fakePA).unlockScr(1234, _A(2000), _W("0.1"), _A(0)))
      .to.emit(etk, "SCRUnlocked")
      .withArgs(1234, _W("0.1"), _A(2000), _A(0));

    expect(await etk.balanceOf(lp)).to.closeTo(_A(3500), 20n);
    // now the updated scale is affected
    expect(await etk.getCurrentScale(false)).to.closeTo(_W("1.1666"), _W("0.0001"));
    expect(await etk.getCurrentScale(true)).to.closeTo(_W("1.1666"), _W("0.0001"));

    // Full withdrawl fails due to rounding error
    await expect(pool.connect(lp).withdraw(etk, MaxUint256, lp, lp)).to.be.revertedWithCustomError(
      yieldVault,
      "ERC4626ExceededMaxWithdraw"
    );

    await currency.connect(fakePA).transfer(etk, _A("0.001")); // transfer pennies to fix the rounding error

    const etkBurned = newCaptureAny();
    const yvWithdraw = newCaptureAny();
    const yvWithdrawShares = newCaptureAny();
    await expect(pool.connect(lp).withdraw(etk, MaxUint256, lp, lp))
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

    await pool.connect(lp).withdraw(etk, MaxUint256, lp, lp);
    expect(await etk.totalSupply()).to.equal(0);

    // Mint 1 share for etk and generate 100 in earnings
    await currency.connect(fakePA).approve(yieldVault, MaxUint256);
    await yieldVault.connect(fakePA).mint(1n, etk);
    await yieldVault.discreteEarning(_A(100));

    // Panics is trying to record an earnings to an ETK with totalSupply == 0
    await expect(etk.recordEarnings()).to.be.revertedWithPanic(0x12);

    const smallDeposit = _A("0.0001");
    await pool.connect(lp).deposit(etk, smallDeposit, lp);

    await expect(etk.recordEarnings())
      .to.emit(etk, "EarningsRecorded")
      .withArgs(_A(50) + 1n); // The vault has one virtual share, so the etk gets 50% of the earning

    expect(await etk.totalSupply()).to.equal(_A(50) + 1n + smallDeposit);
    expect(await etk.balanceOf(lp)).to.equal(_A(50) + 1n + smallDeposit);
    await pool.connect(lp).deposit(etk, _A(1000), lp);

    // The rounding error is big because the earning of 50 is disproportionated with respect to the investment
    // of 0.0001
    expect(await etk.balanceOf(lp)).to.closeTo(_A(1050) + 1n + smallDeposit, _A(1));

    await expect(pool.connect(lp).withdraw(etk, MaxUint256, lp, lp))
      .to.emit(currency, "Transfer")
      .withArgs(etk, lp, captureAny.uint);

    expect(await etk.totalSupply()).to.closeTo(_A(0), _A("0.55"));
    expect(await etk.scaledTotalSupply()).to.closeTo(_A(0), 1n);
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
    await pool.connect(lp).deposit(etk, _A(3000), lp);

    // Impersonate pool and add fakePA as borrower
    const poolAddr = await ethers.resolveAddress(pool);
    await helpers.impersonateAccount(poolAddr);
    await helpers.setBalance(poolAddr, ethers.parseEther("100"));
    const poolImpersonated = await ethers.getSigner(poolAddr);

    return { currency, poolImpersonated, pool, etk, lp, lp2, fakePA };
  }

  async function etkFixtureWithWL() {
    const ret = await etokenFixture();
    const { pool, etk } = ret;
    const wl = await deployWhitelist(pool, {});

    await expect(etk.setWhitelist(wl)).to.emit(etk, "WhitelistChanged").withArgs(ZeroAddress, wl);

    return { wl, ...ret };
  }

  async function etkFixtureWithVault() {
    const ret = await etokenFixture();
    const { poolImpersonated, currency, fakePA, etk } = ret;
    const TestERC4626 = await ethers.getContractFactory("TestERC4626");
    const yieldVault = await TestERC4626.deploy("Yield Vault", "YIELD", currency);

    await expect(etk.connect(poolImpersonated).addBorrower(fakePA))
      .to.emit(etk, "InternalBorrowerAdded")
      .withArgs(fakePA);

    return { TestERC4626, yieldVault, ...ret };
  }
});
