const { expect } = require("chai");
const hre = require("hardhat");
const helpers = require("@nomicfoundation/hardhat-network-helpers");

const { captureAny, _W, _A } = require("@ensuro/utils/js/utils");
const { initCurrency } = require("@ensuro/utils/js/test-utils");
const { DAY } = require("@ensuro/utils/js/constants");
const { deployPool, addEToken, deployCooler } = require("../js/test-utils");

const { ethers } = hre;
const { ZeroAddress } = ethers;

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
      .withArgs(etk, 1n, lp, captureAny.uint, _W(1), _A(100))
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
      .withArgs(etk, 1n, lp, now + 8 * DAY, _W(1), _A(100))
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
