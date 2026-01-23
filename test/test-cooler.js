const { expect } = require("chai");
const hre = require("hardhat");
const helpers = require("@nomicfoundation/hardhat-network-helpers");

const { captureAny, _W, _A, newCaptureAny, makeEIP2612Signature } = require("@ensuro/utils/js/utils");
const { anyUint } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");
const { initCurrency } = require("@ensuro/utils/js/test-utils");
const { DAY } = require("@ensuro/utils/js/constants");
const { SCALE_INITIAL, wadMul } = require("../js/utils");
const { deployPool, addEToken, deployCooler } = require("../js/test-utils");

const { ethers } = hre;
const { ZeroAddress, MaxUint256 } = ethers;

async function etokenFixture() {
  // Fixture that starts a pool with one eToken and that eToken has a fake PremiumsAccount (fakePA) added
  // as borrower. Also I have a yieldVault ready to plug it. It's the easiest way of simulating returns
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

  const cooler = await deployCooler(pool, { name: "Test Cooler", symbol: "COOLo" });

  const TestERC4626 = await ethers.getContractFactory("TestERC4626");
  const yieldVault = await TestERC4626.deploy("Yield Vault", "YIELD", currency);

  await expect(etk.connect(poolImpersonated).addBorrower(fakePA))
    .to.emit(etk, "InternalBorrowerAdded")
    .withArgs(fakePA);

  return { TestERC4626, yieldVault, currency, poolImpersonated, pool, etk, lp, lp2, fakePA, cooler };
}

describe("Cooler", () => {
  it("Checks cooler cannot be initialized twice", async () => {
    const { cooler } = await helpers.loadFixture(etokenFixture);
    await expect(cooler.initialize("Other name", "OTHER")).to.be.revertedWithCustomError(
      cooler,
      "InvalidInitialization"
    );
  });

  it("Has the right name and symbol", async () => {
    const { cooler } = await helpers.loadFixture(etokenFixture);
    expect(await cooler.name()).to.equal("Test Cooler");
    expect(await cooler.symbol()).to.equal("COOLo");
  });

  it("It can change the cooldown period for a given eToken and each ETK has its own cooldown period", async () => {
    const { cooler, etk, pool } = await helpers.loadFixture(etokenFixture);
    expect(await cooler.cooldownPeriod(etk, ZeroAddress, _A(123))).to.equal(0);
    expect(await cooler.setCooldownPeriod(etk, 7 * DAY))
      .to.emit(cooler, "CooldownPeriodChanged")
      .withArgs(etk, 0, 7 * DAY);
    expect(await cooler.setCooldownPeriod(etk, 14 * DAY))
      .to.emit(cooler, "CooldownPeriodChanged")
      .withArgs(etk, 7 * DAY, 14 * DAY);
    expect(await cooler.cooldownPeriod(etk, ZeroAddress, _A(123))).to.equal(14 * DAY);

    const otherETK = await addEToken(pool, {});
    expect(await cooler.cooldownPeriod(otherETK, ZeroAddress, _A(123))).to.equal(0);

    expect(await cooler.setCooldownPeriod(otherETK, 21 * DAY))
      .to.emit(cooler, "CooldownPeriodChanged")
      .withArgs(otherETK, 0 * DAY, 21 * DAY);
    expect(await cooler.cooldownPeriod(otherETK, ZeroAddress, _A(123))).to.equal(21 * DAY);
    expect(await cooler.cooldownPeriod(etk, ZeroAddress, _A(123))).to.equal(14 * DAY); // Remains unchanged
  });

  it("It doesn't allow immediate withdrawals if the cooler is active and cooldown > 0", async () => {
    const { cooler, etk, pool, lp } = await helpers.loadFixture(etokenFixture);
    expect(await etk.cooler()).to.equal(ZeroAddress);
    // withdrawals are OK without cooler
    await expect(pool.connect(lp).withdraw(etk, _A(100), lp, lp)).to.emit(pool, "Withdraw");

    await expect(etk.setCooler(cooler)).to.emit(etk, "CoolerChanged").withArgs(ZeroAddress, cooler);

    // Same with cooler but cooldownPeriod still 0
    await expect(pool.connect(lp).withdraw(etk, _A(100), lp, lp)).to.emit(pool, "Withdraw");

    expect(await cooler.setCooldownPeriod(etk, DAY))
      .to.emit(cooler, "CooldownPeriodChanged")
      .withArgs(etk, 0, DAY);

    await expect(pool.connect(lp).withdraw(etk, _A(100), lp, lp))
      .to.be.revertedWithCustomError(etk, "WithdrawalsRequireCooldown")
      .withArgs(cooler);

    // Back to zero, withdrawal works again
    expect(await cooler.setCooldownPeriod(etk, 0))
      .to.emit(cooler, "CooldownPeriodChanged")
      .withArgs(etk, DAY, 0);
    await expect(pool.connect(lp).withdraw(etk, _A(100), lp, lp)).to.emit(pool, "Withdraw");
  });

  it("It checks withdrawal schedule inputs (when >= cooldownPeriod, amount > 0, etk active, allowance)", async () => {
    const { cooler, etk, lp } = await helpers.loadFixture(etokenFixture);

    await etk.setCooler(cooler);
    await cooler.setCooldownPeriod(etk, 7 * DAY);

    // Requires allowance
    await expect(cooler.connect(lp).scheduleWithdrawal(etk, 0, _A(100)))
      .to.be.revertedWithCustomError(etk, "ERC20InsufficientAllowance")
      .withArgs(cooler, _A(0), _A(100));

    await etk.connect(lp).approve(cooler, _A(101));
    expect(await etk.allowance(lp, cooler)).to.equal(_A(101));

    const now = await helpers.time.latest();

    await expect(cooler.scheduleWithdrawal(etk, now + 3 * DAY, _A(100)))
      .to.be.revertedWithCustomError(cooler, "WithdrawalRequestEarlierThanMin")
      .withArgs(captureAny.uint, now + 3 * DAY);
    expect(captureAny.lastUint).to.closeTo(now + 7 * DAY, 60);

    // To schedule withdrawals, the cooler must be active
    await etk.setCooler(ZeroAddress);
    await expect(cooler.scheduleWithdrawal(etk, 0, _A(100)))
      .to.be.revertedWithCustomError(cooler, "InvalidEToken")
      .withArgs(etk);

    await etk.setCooler(cooler);

    // Amount = 0 is rejected too
    await expect(cooler.scheduleWithdrawal(etk, 0, _A(0))).to.be.revertedWithCustomError(
      cooler,
      "CannotDoZeroWithdrawals"
    );

    await expect(cooler.connect(lp).scheduleWithdrawal(etk, 0, _A(100)))
      .to.emit(cooler, "WithdrawalRequested")
      .withArgs(etk, 1n, lp, captureAny.uint, SCALE_INITIAL, _A(100))
      .to.emit(etk, "Transfer")
      .withArgs(lp, cooler, _A(100))
      .to.emit(cooler, "Transfer")
      .withArgs(ZeroAddress, lp, 1n); // lp receives the NFT
    expect(captureAny.lastUint).to.closeTo(now + 7 * DAY, 60);
    expect(await etk.allowance(lp, cooler)).to.equal(_A(1)); // Spends 100 in allowance
  });

  it("Checks withdrawal can't be executed before deadline or twice", async () => {
    const { cooler, etk, lp, pool } = await helpers.loadFixture(etokenFixture);

    await etk.setCooler(cooler);
    await cooler.setCooldownPeriod(etk, 7 * DAY);
    await etk.connect(lp).approve(cooler, _A(100));

    const now = await helpers.time.latest();

    await expect(cooler.connect(lp).scheduleWithdrawal(etk, now + 8 * DAY, _A(100)))
      .to.emit(cooler, "WithdrawalRequested")
      .withArgs(etk, 1n, lp, now + 8 * DAY, SCALE_INITIAL, _A(100))
      .to.emit(etk, "Transfer")
      .withArgs(lp, cooler, _A(100))
      .to.emit(cooler, "Transfer")
      .withArgs(ZeroAddress, lp, 1n); // lp receives the NFT

    expect(await cooler.getCurrentValue(1n)).to.equal(_A(100));
    expect(await cooler.getCurrentValue(2n)).to.equal(_A(0)); // Non-existent return 0
    expect(await cooler.ownerOf(1n)).to.equal(lp);

    // Fails with not existent NFTs
    await expect(cooler.executeWithdrawal(2n))
      .to.be.revertedWithCustomError(cooler, "InvalidWithdrawalRequest")
      .withArgs(2n);

    // Fails if earlier than expiration
    await helpers.time.increaseTo(now + 3 * DAY);
    await expect(cooler.executeWithdrawal(1n))
      .to.be.revertedWithCustomError(cooler, "WithdrawalNotReady")
      .withArgs(1n, now + 8 * DAY);

    await helpers.time.increaseTo(now + 8 * DAY);
    await expect(cooler.executeWithdrawal(1n))
      .to.emit(cooler, "WithdrawalExecuted")
      .withArgs(etk, 1n, lp, _A(100), _A(100))
      .to.emit(pool, "Withdraw")
      .withArgs(etk, cooler, lp, cooler, _A(100));

    expect(await cooler.getCurrentValue(1n)).to.equal(_A(0)); // NFT value back to 0

    // Can't be executed twice
    await expect(cooler.executeWithdrawal(1n))
      .to.be.revertedWithCustomError(cooler, "InvalidWithdrawalRequest")
      .withArgs(1n);
    await expect(cooler.ownerOf(1n)).to.be.revertedWithCustomError(cooler, "ERC721NonexistentToken").withArgs(1n);
  });

  it("Checks the earnings are redistributed to the rest of the LPs - YV Version", async () => {
    const { cooler, etk, lp, lp2, pool, yieldVault } = await helpers.loadFixture(etokenFixture);

    await etk.connect(lp).transfer(lp2, _A(2000)); // Now LP2=2000, LP=1000

    await expect(etk.setYieldVault(yieldVault, false)).to.emit(etk, "YieldVaultChanged");
    await expect(etk.depositIntoYieldVault(_A(3000)))
      .to.emit(yieldVault, "Deposit")
      .withArgs(etk, etk, _A(3000), _A(3000));
    await yieldVault.discreteEarning(_A(300));
    await expect(etk.recordEarnings())
      .to.emit(etk, "EarningsRecorded")
      .withArgs(_A(300) - 1n);

    expect(await etk.getCurrentScale(true)).to.closeTo(wadMul(SCALE_INITIAL, _W("1.1")), _W("0.00001"));

    await etk.setCooler(cooler);
    await cooler.setCooldownPeriod(etk, 7 * DAY);

    await etk.connect(lp).approve(cooler, _A(500));

    const now = await helpers.time.latest();

    expect(await etk.totalSupply()).to.closeTo(_A(3300), _A("0.001")); // Initial TS=3300
    const lp2_initial = 2200;
    const lp_initial = 1100;

    await expect(cooler.connect(lp).scheduleWithdrawal(etk, 0, _A(500)))
      .to.emit(cooler, "Transfer")
      .withArgs(ZeroAddress, lp, 1n); // lp receives the NFT

    expect(await cooler.getCurrentValue(1n)).to.equal(_A(500));

    await yieldVault.discreteEarning(_A(-600));
    await expect(etk.recordEarnings())
      .to.emit(etk, "EarningsRecorded")
      .withArgs(-_A(600) + 1n);

    expect(await etk.totalSupply()).to.closeTo(_A(2700), _A("0.001"));
    // The current value of the NFT goes down, because it reflects the losses
    expect(await cooler.getCurrentValue(1n)).to.closeTo(_A(500 * (2700 / 3300)), _A("0.0001"));

    // Now produce more earnings
    await yieldVault.discreteEarning(_A(1300));
    await expect(etk.recordEarnings())
      .to.emit(etk, "EarningsRecorded")
      .withArgs(_A(1300) - 1n);

    expect(await etk.totalSupply()).to.closeTo(_A(4000), _A("0.001"));
    // The current value of the NFT stays at 500, because the earnings go to remaining LPs
    expect(await cooler.getCurrentValue(1n)).to.equal(_A(500));

    await helpers.time.increaseTo(now + 8 * DAY);
    await expect(cooler.executeWithdrawal(1n))
      .to.emit(cooler, "WithdrawalExecuted")
      .withArgs(etk, 1n, lp, _A(500), _A(500))
      .to.emit(pool, "Withdraw")
      .withArgs(etk, cooler, lp, cooler, _A(500))
      .to.emit(etk, "ETokensRedistributed")
      .withArgs(cooler, captureAny.uint);

    const etkProfit = 4000 / 3300; // etkProfit during the cooling period
    const redistributed = 500 * (etkProfit - 1);
    expect(captureAny.lastUint).to.closeTo(_A(redistributed), _A("0.001")); // Profits generated by the 500

    expect(await etk.totalSupply()).to.closeTo(_A(3500), _A("0.001"));
    const lp_before_redistribution = (lp_initial - 500) * etkProfit;
    const lp2_before_redistribution = lp2_initial * etkProfit;
    const ts_before_redistribution = 3500 - redistributed;
    expect(await etk.balanceOf(lp2)).to.closeTo(
      _A(lp2_before_redistribution) + _A(redistributed * (lp2_before_redistribution / ts_before_redistribution)),
      _A("0.001")
    );
    expect(await etk.balanceOf(lp)).to.closeTo(
      _A(lp_before_redistribution) + _A(redistributed * (lp_before_redistribution / ts_before_redistribution)),
      _A("0.001")
    );
  });

  it("Checks the losses do impact the withdrawal result and funds can't be locked when scheduled", async () => {
    const { cooler, etk, lp, lp2, pool, fakePA } = await helpers.loadFixture(etokenFixture);

    await etk.connect(lp).transfer(lp2, _A(2000)); // Now LP2=2000, LP=1000
    await etk.setCooler(cooler);
    await cooler.setCooldownPeriod(etk, 7 * DAY);
    await etk.connect(lp2).approve(cooler, _A(500));

    await etk.connect(fakePA).lockScr(1234n, _A(2600), _W(365 / 2600)); // Interest accrues $ 1 / day

    await helpers.time.increase(30 * DAY);

    expect(await etk.totalSupply()).to.closeTo(_A(3030), _A("0.001")); // Initial TS=3030

    const lp2_initial = 2000 + 30 * (2 / 3);
    const lp_initial = 1000 + 30 * (1 / 3);

    expect(await etk.fundsAvailableToLock()).to.closeTo(_A(3030 - 2600), _A("0.0001"));

    await expect(cooler.connect(lp2).scheduleWithdrawal(etk, 0, _A(500)))
      .to.emit(cooler, "Transfer")
      .withArgs(ZeroAddress, lp2, 1n); // lp receives the NFT

    expect(await cooler.getCurrentValue(1n)).to.equal(_A(500));
    expect(await etk.fundsAvailableToLock()).to.equal(_A(0));

    await helpers.time.increase(30 * DAY); // Total 60 interest accrued
    // Withdrawal fails because the funds are locked. This cooling mechanism doesn't check locking on scheduling,
    // but it checks it on withdrawal (as always)
    await expect(cooler.executeWithdrawal(1n))
      .to.be.revertedWithCustomError(etk, "ExceedsMaxWithdraw")
      .withArgs(_A(500), captureAny.uint);
    expect(captureAny.lastUint).to.closeTo(_A(3060 - 2600), _A("0.001"));

    await helpers.time.increase(60 * DAY); // Total 120 interest accrued
    expect(await etk.fundsAvailableToLock()).to.closeTo(_A(20), _A("0.001"));

    await expect(etk.connect(fakePA).lockScr(2345n, _A(100), _W(365 / 2600)))
      .to.be.revertedWithCustomError(etk, "NotEnoughScrFunds")
      .withArgs(_A(100), captureAny.uint);
    expect(captureAny.lastUint).to.closeTo(_A(20), _A("0.001"));

    // Unlock the SCR and produce a loss of 1000
    await expect(etk.connect(fakePA).unlockScr(1234n, _A(2600), _W(365 / 2600), _A(0))).not.to.be.reverted;
    await expect(etk.connect(fakePA).internalLoan(_A(1000), fakePA)).not.to.be.reverted;

    expect(await etk.totalSupply()).to.closeTo(_A(3000 + 120 - 1000), _A("0.001"));
    const lossPercentage = (3000 + 120 - 1000) / 3030;

    const [withdrawAmount1, withdrawAmount2] = [newCaptureAny(), newCaptureAny()];
    await expect(cooler.executeWithdrawal(1n))
      .to.emit(cooler, "WithdrawalExecuted")
      .withArgs(etk, 1n, lp2, _A(500), withdrawAmount1.uint)
      .to.emit(pool, "Withdraw")
      .withArgs(etk, cooler, lp2, cooler, withdrawAmount2.uint)
      .not.to.emit(etk, "ETokensRedistributed");

    expect(withdrawAmount1.lastUint).to.closeTo(_A(500 * lossPercentage), _A("0.0001"));
    expect(withdrawAmount2.lastUint).to.equal(withdrawAmount1.lastUint);

    expect(await etk.balanceOf(lp2)).to.closeTo(_A((lp2_initial - 500) * lossPercentage), _A("0.001"));
    expect(await etk.balanceOf(lp)).to.closeTo(_A(lp_initial * lossPercentage), _A("0.001"));
  });

  it("Checks it works well when scheduled infinite withdrawals exceed totalSupply", async () => {
    const { cooler, etk, lp, lp2, pool, fakePA, currency } = await helpers.loadFixture(etokenFixture);

    await etk.connect(lp).transfer(lp2, _A(2000)); // Now LP2=2000, LP=1000
    await etk.setCooler(cooler);
    await cooler.setCooldownPeriod(etk, 7 * DAY);
    await etk.connect(lp2).approve(cooler, MaxUint256);
    await etk.connect(lp).approve(cooler, MaxUint256);

    await etk.connect(fakePA).lockScr(1234n, _A(2600), _W(365 / 2600)); // Interest accrues $ 1 / day
    await currency.connect(fakePA).transfer(etk, _A(30) + 500n); // transfer the CoC

    await helpers.time.increase(30 * DAY);

    expect(await etk.totalSupply()).to.closeTo(_A(3030), _A("0.001")); // Initial TS=3030

    const lp2_initial = 2000 + 30 * (2 / 3);
    const lp_initial = 1000 + 30 * (1 / 3);

    expect(await etk.fundsAvailableToLock()).to.closeTo(_A(3030 - 2600), _A("0.0001"));

    await expect(cooler.connect(lp2).scheduleWithdrawal(etk, 0, MaxUint256))
      .to.emit(cooler, "WithdrawalRequested")
      .withArgs(etk, 1n, lp2, anyUint, anyUint, captureAny.uint)
      .to.emit(cooler, "Transfer")
      .withArgs(ZeroAddress, lp2, 1n); // lp receives the NFT

    const requestAmount1 = captureAny.lastUint;
    expect(requestAmount1).to.closeTo(_A(lp2_initial), _A("0.0001"));

    expect(await etk.fundsAvailableToLock()).to.equal(_A(0));

    expect(await cooler.getCurrentValue(1n)).to.equal(requestAmount1);
    expect(await cooler.pendingWithdrawals(etk)).to.equal(requestAmount1);

    await expect(cooler.connect(lp).scheduleWithdrawal(etk, 0, MaxUint256))
      .to.emit(cooler, "WithdrawalRequested")
      .withArgs(etk, 2n, lp, anyUint, anyUint, captureAny.uint)
      .to.emit(cooler, "Transfer")
      .withArgs(ZeroAddress, lp, 2n); // lp receives the NFT

    const requestAmount2 = captureAny.lastUint;
    expect(requestAmount2).to.closeTo(_A(lp_initial), _A("0.0001"));
    expect(await cooler.pendingWithdrawals(etk)).to.equal(requestAmount1 + requestAmount2);

    // Unlock the SCR and produce a loss of 1000
    await expect(etk.connect(fakePA).unlockScr(1234n, _A(2600), _W(365 / 2600), _A(0))).not.to.be.reverted;
    await expect(etk.connect(fakePA).internalLoan(_A(1000), fakePA)).not.to.be.reverted;

    expect(await etk.totalSupply()).to.closeTo(_A(3030 - 1000), _A("0.001"));
    expect(await etk.fundsAvailableToLock()).to.equal(_A(0));
    const lossPercentage = 2030 / 3030;

    await helpers.time.increase(7 * DAY);

    const [withdrawAmount1, withdrawAmount2] = [newCaptureAny(), newCaptureAny()];
    await expect(cooler.executeWithdrawal(1n))
      .to.emit(cooler, "WithdrawalExecuted")
      .withArgs(etk, 1n, lp2, requestAmount1, withdrawAmount1.uint)
      .to.emit(pool, "Withdraw")
      .withArgs(etk, cooler, lp2, cooler, withdrawAmount2.uint)
      .not.to.emit(etk, "ETokensRedistributed");

    expect(withdrawAmount1.lastUint).to.closeTo(_A(lp2_initial * lossPercentage), _A("0.0001"));
    expect(withdrawAmount2.lastUint).to.equal(withdrawAmount1.lastUint);

    await expect(cooler.executeWithdrawal(2n))
      .to.emit(cooler, "WithdrawalExecuted")
      .withArgs(etk, 2n, lp, requestAmount2, withdrawAmount1.uint)
      .to.emit(pool, "Withdraw")
      .withArgs(etk, cooler, lp, cooler, withdrawAmount2.uint)
      .not.to.emit(etk, "ETokensRedistributed");

    expect(withdrawAmount1.lastUint).to.closeTo(_A(lp_initial * lossPercentage), _A("0.0001"));
    expect(withdrawAmount2.lastUint).to.equal(withdrawAmount1.lastUint);

    expect(await etk.totalSupply()).to.closeTo(0, 1n);
    expect(await cooler.pendingWithdrawals(etk)).to.equal(0);
  });

  it("Checks withdrawals can be requested with permit", async () => {
    const { cooler, etk, lp, lp2, pool } = await helpers.loadFixture(etokenFixture);

    await etk.connect(lp).transfer(lp2, _A(2000)); // Now LP2=2000, LP=1000
    await etk.setCooler(cooler);
    await cooler.setCooldownPeriod(etk, 7 * DAY);

    const coolerAddr = await ethers.resolveAddress(cooler);
    const { sig, deadline } = await makeEIP2612Signature(hre, etk, lp, coolerAddr, _A(600));

    await expect(cooler.connect(lp).scheduleWithdrawalWithPermit(etk, 0, _A(600), deadline, sig.v, sig.r, sig.s))
      .to.emit(cooler, "WithdrawalRequested")
      .withArgs(etk, 1n, lp, anyUint, SCALE_INITIAL, _A(600))
      .to.emit(cooler, "Transfer")
      .withArgs(ZeroAddress, lp, 1n); // lp receives the NFT

    expect(await etk.allowance(lp, cooler)).to.equal(_A(0));

    const { sig: sig2, deadline: deadline2 } = await makeEIP2612Signature(hre, etk, lp2, coolerAddr, _A(1000));
    // Front-run the permit
    await etk.permit(lp2, cooler, _A(1000), deadline2, sig2.v, sig2.r, sig2.s);
    await expect(cooler.connect(lp2).scheduleWithdrawalWithPermit(etk, 0, _A(1000), deadline2, sig2.v, sig2.r, sig2.s))
      .to.emit(cooler, "WithdrawalRequested")
      .withArgs(etk, 2n, lp2, anyUint, SCALE_INITIAL, _A(1000))
      .to.emit(cooler, "Transfer")
      .withArgs(ZeroAddress, lp2, 2n); // lp receives the NFT

    expect(await etk.allowance(lp2, cooler)).to.equal(_A(0));

    const { sig: sig3, deadline: deadline3 } = await makeEIP2612Signature(hre, etk, lp, coolerAddr, MaxUint256);

    expect(await etk.allowance(lp, cooler)).to.equal(0);
    await expect(cooler.connect(lp).scheduleWithdrawalWithPermit(etk, 0, MaxUint256, deadline3, sig3.v, sig3.r, sig3.s))
      .to.emit(cooler, "WithdrawalRequested")
      .withArgs(etk, 3n, lp, anyUint, SCALE_INITIAL, _A(400))
      .to.emit(cooler, "Transfer")
      .withArgs(ZeroAddress, lp, 3n); // lp receives the NFT

    expect(await etk.allowance(lp, cooler)).to.equal(MaxUint256); // When allowance = MaxUint256 is not reduced

    // Test the execution of the withdrawals works fine
    await helpers.time.increase(10 * DAY);
    await expect(cooler.executeWithdrawal(1n)).to.emit(pool, "Withdraw").withArgs(etk, cooler, lp, cooler, _A(600));
    await expect(cooler.executeWithdrawal(2n)).to.emit(pool, "Withdraw").withArgs(etk, cooler, lp2, cooler, _A(1000));
    await expect(cooler.executeWithdrawal(3n)).to.emit(pool, "Withdraw").withArgs(etk, cooler, lp, cooler, _A(400));
  });

  it("Checks the owner of the NFT receives the money", async () => {
    const { cooler, etk, lp, lp2, pool, currency } = await helpers.loadFixture(etokenFixture);

    await etk.setCooler(cooler);
    await cooler.setCooldownPeriod(etk, 7 * DAY);
    await etk.connect(lp).approve(cooler, _A(150));

    expect(await currency.balanceOf(lp2)).to.equal(_A(0));

    const now = await helpers.time.latest();

    await expect(cooler.connect(lp).scheduleWithdrawal(etk, 0, _A(100)))
      .to.emit(cooler, "Transfer")
      .withArgs(ZeroAddress, lp, 1n); // lp receives the NFT

    await expect(cooler.connect(lp).scheduleWithdrawal(etk, 0, _A(50)))
      .to.emit(cooler, "Transfer")
      .withArgs(ZeroAddress, lp, 2n); // lp receives another NFT

    expect(await cooler.getCurrentValue(1n)).to.equal(_A(100));
    expect(await cooler.getCurrentValue(2n)).to.equal(_A(50));

    await expect(cooler.connect(lp).safeTransferFrom(lp, lp2, 1n))
      .to.emit(cooler, "Transfer")
      .withArgs(lp, lp2, 1n);

    await helpers.time.increaseTo(now + 8 * DAY);
    await expect(cooler.executeWithdrawal(1n))
      .to.emit(cooler, "WithdrawalExecuted")
      .withArgs(etk, 1n, lp2, _A(100), _A(100))
      .to.emit(pool, "Withdraw")
      .withArgs(etk, cooler, lp2, cooler, _A(100));

    expect(await currency.balanceOf(lp2)).to.equal(_A(100));

    expect(await cooler.getCurrentValue(1n)).to.equal(_A(0)); // NFT value back to 0

    await expect(cooler.executeWithdrawal(2n))
      .to.emit(cooler, "WithdrawalExecuted")
      .withArgs(etk, 2n, lp, _A(50), _A(50))
      .to.emit(pool, "Withdraw")
      .withArgs(etk, cooler, lp, cooler, _A(50));
  });
});
