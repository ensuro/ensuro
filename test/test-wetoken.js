const { expect } = require("chai");
const hre = require("hardhat");
const helpers = require("@nomicfoundation/hardhat-network-helpers");

const { amountFunction, _W } = require("@ensuro/utils/js/utils");
const { initCurrency } = require("@ensuro/utils/js/test-utils");
const { deployPool, addEToken, deployWhitelist } = require("../js/test-utils");
const { makeWhitelistStatus, SCALE_INITIAL } = require("../js/utils");

const { ethers } = hre;
const { ZeroAddress, MaxUint256 } = ethers;

const _A = amountFunction(6);
const WAD = _W(1);
// Share scale so 1 WEToken = 1 eToken at the eToken's initial scale: SCALE_INITIAL * 10^(18-6)
const SHARE_SCALE = SCALE_INITIAL * 10n ** 12n;

describe("WEToken", () => {
  async function wetokenFixture() {
    const [owner, lp, lp2, freezerAcc] = await hre.ethers.getSigners();
    const currency = await initCurrency(
      { name: "Test USDC", symbol: "USDC", decimals: 6, initial_supply: _A(10000) },
      [lp, lp2],
      [_A(5000), _A(2000)]
    );
    const pool = await deployPool({ currency });
    pool._A = _A;
    const etk = await addEToken(pool, {});

    await currency.connect(lp).approve(pool, _A(5000));
    await pool.connect(lp).deposit(etk, _A(3000), lp);

    const WEToken = await ethers.getContractFactory("WEToken");
    const wetk = await WEToken.deploy(etk, "Wrapped EToken", "WETK", freezerAcc.address, owner.address);

    await etk.connect(lp).approve(wetk, MaxUint256);

    return { currency, pool, etk, wetk, lp, lp2, owner, freezerAcc };
  }

  async function wetokenWithWLFixture() {
    const ret = await wetokenFixture();
    const { pool, etk } = ret;
    const wl = await deployWhitelist(pool, {});
    await etk.setWhitelist(wl);
    return { wl, ...ret };
  }

  async function wetokenWithYieldFixture() {
    const ret = await wetokenFixture();
    const { etk, currency } = ret;
    const TestERC4626 = await ethers.getContractFactory("TestERC4626");
    const yieldVault = await TestERC4626.deploy("Yield Vault", "YIELD", currency);
    await etk.setYieldVault(yieldVault, false);
    return { yieldVault, ...ret };
  }

  it("Deposits eTokens for WETokens at initial scale", async () => {
    const { etk, wetk, lp } = await helpers.loadFixture(wetokenFixture);
    const etkAmount = _A(1000);
    // shares = assets * SHARE_SCALE / scale; at SCALE_INITIAL 1 eToken gives exactly 1 WEToken
    const expectedWetk = (etkAmount * SHARE_SCALE) / SCALE_INITIAL;

    expect(await wetk.convertToShares(etkAmount)).to.equal(expectedWetk);
    await expect(wetk.connect(lp).deposit(etkAmount, lp.address))
      .to.emit(wetk, "Deposit")
      .withArgs(lp, lp, etkAmount, expectedWetk);
    expect(await wetk.balanceOf(lp)).to.equal(expectedWetk);
    expect(await etk.balanceOf(wetk)).to.equal(etkAmount);
  });

  it("Redeems WETokens for eTokens at initial scale", async () => {
    const { etk, wetk, lp } = await helpers.loadFixture(wetokenFixture);
    const etkAmount = _A(1000);
    const expectedWetk = (etkAmount * SHARE_SCALE) / SCALE_INITIAL;
    await wetk.connect(lp).deposit(etkAmount, lp.address);

    expect(await wetk.convertToAssets(expectedWetk)).to.equal(etkAmount);
    await expect(wetk.connect(lp).redeem(expectedWetk, lp.address, lp.address))
      .to.emit(wetk, "Withdraw")
      .withArgs(lp, lp, lp, etkAmount, expectedWetk);
    expect(await etk.balanceOf(lp)).to.closeTo(_A(3000), 1n);
    expect(await wetk.balanceOf(lp)).to.equal(0n);
  });

  it("Round-trips deposit then redeem with no loss", async () => {
    const { etk, wetk, lp } = await helpers.loadFixture(wetokenFixture);
    const etkBefore = await etk.balanceOf(lp);
    const etkAmount = _A(1000);
    const wetkMinted = (etkAmount * SHARE_SCALE) / SCALE_INITIAL;

    await wetk.connect(lp).deposit(etkAmount, lp.address);
    await wetk.connect(lp).redeem(wetkMinted, lp.address, lp.address);

    expect(await wetk.balanceOf(lp)).to.equal(0n);
    expect(await etk.balanceOf(lp)).to.closeTo(etkBefore, 1n);
  });

  it("Conversion view functions return correct rates at initial scale", async () => {
    const { wetk } = await helpers.loadFixture(wetokenFixture);
    // convertToAssets(WAD) = WAD * scale / SHARE_SCALE = 1e6 (= 1 eToken)
    expect(await wetk.convertToAssets(WAD)).to.equal(10n ** 6n);
    // convertToShares(WAD) = WAD * SHARE_SCALE / scale
    expect(await wetk.convertToShares(WAD)).to.equal((WAD * SHARE_SCALE) / SCALE_INITIAL);
  });

  it("WETokens gain value as yield accrues", async () => {
    const { etk, wetk, lp, yieldVault } = await helpers.loadFixture(wetokenWithYieldFixture);
    const etkAmount = _A(1000);
    const wetkMinted = (etkAmount * SHARE_SCALE) / SCALE_INITIAL;
    await wetk.connect(lp).deposit(etkAmount, lp.address);

    // Generate yield: move USDC to vault, earn 100 USDC (etk receives ~50 due to virtual share)
    await etk.depositIntoYieldVault(MaxUint256);
    await yieldVault.discreteEarning(_A(100));
    await etk.recordEarnings();

    // 1 WEToken was worth 1 eToken (1e6 base units) at the initial scale and appreciates with the yield
    expect(await wetk.convertToAssets(WAD)).to.be.gt(10n ** 6n);
    expect(await wetk.convertToAssets(wetkMinted)).to.be.gt(etkAmount);
  });

  it("Redeeming dust WEToken shares floors the eToken amount; below 1e-6 WEToken no eToken is received", async () => {
    const { etk, wetk, lp } = await helpers.loadFixture(wetokenFixture);
    await wetk.connect(lp).deposit(_A(1000), lp.address);

    let etkBalance = await etk.balanceOf(lp);
    let wetkBalance = await wetk.balanceOf(lp);

    // Redeem from 0.1 WEToken down to 0.000000000000000001 (1 base unit)
    for (let exp = 17n; exp >= 0n; exp--) {
      const shares = 10n ** exp;
      const expectedAssets = (shares * SCALE_INITIAL) / SHARE_SCALE; // floors to 0 for dust
      expect(await wetk.previewRedeem(shares)).to.equal(expectedAssets);

      await wetk.connect(lp).redeem(shares, lp.address, lp.address);

      etkBalance += expectedAssets;
      wetkBalance -= shares;
      expect(await etk.balanceOf(lp)).to.equal(etkBalance);
      expect(await wetk.balanceOf(lp)).to.equal(wetkBalance);
    }
  });

  it("Dust threshold: 1e-6 WEToken redeems exactly 1 eToken base unit, 1 unit less redeems nothing", async () => {
    const { etk, wetk, lp } = await helpers.loadFixture(wetokenFixture);
    await wetk.connect(lp).deposit(_A(1000), lp.address);

    const etkBefore = await etk.balanceOf(lp);
    const threshold = SHARE_SCALE / SCALE_INITIAL; // 1e12 shares = 1e-6 WEToken

    expect(await wetk.previewRedeem(threshold - 1n)).to.equal(0n);
    await wetk.connect(lp).redeem(threshold - 1n, lp.address, lp.address);
    expect(await etk.balanceOf(lp)).to.equal(etkBefore);

    expect(await wetk.previewRedeem(threshold)).to.equal(1n);
    await wetk.connect(lp).redeem(threshold, lp.address, lp.address);
    expect(await etk.balanceOf(lp)).to.equal(etkBefore + 1n);
  });

  it("setFreezer can only be called by owner", async () => {
    const { wetk, lp } = await helpers.loadFixture(wetokenFixture);
    await expect(wetk.connect(lp).setFreezer(lp.address))
      .to.be.revertedWithCustomError(wetk, "OwnableUnauthorizedAccount")
      .withArgs(lp);
  });

  it("setFreezer updates freezer and emits FreezerChanged", async () => {
    const { wetk, owner, lp, freezerAcc } = await helpers.loadFixture(wetokenFixture);
    await expect(wetk.connect(owner).setFreezer(lp.address)).to.emit(wetk, "FreezerChanged").withArgs(freezerAcc, lp);
    expect(await wetk.freezer()).to.equal(lp.address);
  });

  it("setFrozen reverts when called by non-freezer", async () => {
    const { wetk, lp, lp2 } = await helpers.loadFixture(wetokenFixture);
    await expect(wetk.connect(lp).setFrozen(lp2.address, true)).to.be.revertedWithCustomError(wetk, "NotFreezer");
  });

  it("setFrozen freezes account and blocks outgoing transfers", async () => {
    const { wetk, lp, lp2, freezerAcc, wl } = await helpers.loadFixture(wetokenWithWLFixture);
    await wetk.connect(lp).deposit(_A(1000), lp.address);

    // Blacklist lp for sendTransfer so freeze is consistent with whitelist
    await wl.whitelistAddress(lp.address, makeWhitelistStatus("UUBW"));

    await expect(wetk.connect(freezerAcc).setFrozen(lp.address, true))
      .to.emit(wetk, "AccountFrozen")
      .withArgs(lp, true);
    expect(await wetk.frozen(lp.address)).to.equal(true);

    const wetkBalance = await wetk.balanceOf(lp);
    await expect(wetk.connect(lp).transfer(lp2.address, wetkBalance))
      .to.be.revertedWithCustomError(wetk, "FrozenAccount")
      .withArgs(lp);
  });

  it("Redeem is blocked for frozen accounts", async () => {
    const { wetk, lp, freezerAcc, wl } = await helpers.loadFixture(wetokenWithWLFixture);
    await wetk.connect(lp).deposit(_A(1000), lp.address);
    await wl.whitelistAddress(lp.address, makeWhitelistStatus("UUBW"));
    await wetk.connect(freezerAcc).setFrozen(lp.address, true);

    // ERC-4626 allows arbitrary receiver, so burns must also be blocked to prevent
    // a frozen owner from draining underlying eTokens to another address.
    const wetkBalance = await wetk.balanceOf(lp);
    await expect(wetk.connect(lp).redeem(wetkBalance, lp.address, lp.address))
      .to.be.revertedWithCustomError(wetk, "FrozenAccount")
      .withArgs(lp);
  });

  it("Receiving WETokens is not blocked for frozen accounts", async () => {
    const { wetk, lp, lp2, freezerAcc, wl } = await helpers.loadFixture(wetokenWithWLFixture);
    await wetk.connect(lp).deposit(_A(1000), lp.address);

    // Freeze lp2: freeze check only looks at `from`, not `to`
    await wl.whitelistAddress(lp2.address, makeWhitelistStatus("UUBW"));
    await wetk.connect(freezerAcc).setFrozen(lp2.address, true);

    const wetkBalance = await wetk.balanceOf(lp);
    await expect(wetk.connect(lp).transfer(lp2.address, wetkBalance)).not.to.be.reverted;
    expect(await wetk.balanceOf(lp2)).to.equal(wetkBalance);
  });

  it("FrozenStateMismatch when freezing a whitelist-allowed user", async () => {
    const { wetk, lp, freezerAcc } = await helpers.loadFixture(wetokenWithWLFixture);
    // Default whitelist has sendTransfer=W → wlFrozen=false; frozen_=true → mismatch
    await expect(wetk.connect(freezerAcc).setFrozen(lp.address, true))
      .to.be.revertedWithCustomError(wetk, "FrozenStateMismatch")
      .withArgs(lp, false, true);
  });

  it("FrozenStateMismatch when unfreezing a whitelist-blocked user", async () => {
    const { wetk, lp, freezerAcc, wl } = await helpers.loadFixture(wetokenWithWLFixture);
    await wl.whitelistAddress(lp.address, makeWhitelistStatus("UUBW"));
    await wetk.connect(freezerAcc).setFrozen(lp.address, true);

    // Whitelist still has sendTransfer=B → wlFrozen=true; frozen_=false → mismatch
    await expect(wetk.connect(freezerAcc).setFrozen(lp.address, false))
      .to.be.revertedWithCustomError(wetk, "FrozenStateMismatch")
      .withArgs(lp, true, false);
  });

  it("NoWhitelistConfigured when freezer is zero and eToken has no whitelist", async () => {
    const { wetk, owner, lp } = await helpers.loadFixture(wetokenFixture);
    await wetk.connect(owner).setFreezer(ZeroAddress);
    await expect(wetk.connect(lp).setFrozen(lp.address, true)).to.be.revertedWithCustomError(
      wetk,
      "NoWhitelistConfigured"
    );
  });

  it("Open-freeze mode: anyone can call setFrozen when freezer is address(0)", async () => {
    const { wetk, owner, lp, lp2, wl } = await helpers.loadFixture(wetokenWithWLFixture);
    await wetk.connect(owner).setFreezer(ZeroAddress);
    await wl.whitelistAddress(lp.address, makeWhitelistStatus("UUBW"));

    // lp2 is not the (now-removed) freezer but can still call setFrozen
    await expect(wetk.connect(lp2).setFrozen(lp.address, true)).to.emit(wetk, "AccountFrozen").withArgs(lp, true);
    expect(await wetk.frozen(lp.address)).to.equal(true);
  });

  it("Freezer with no whitelist can freeze and unfreeze accounts", async () => {
    const { wetk, lp, freezerAcc } = await helpers.loadFixture(wetokenFixture);
    // No whitelist on etk, but freezer is set — bypass whitelist validation
    await expect(wetk.connect(freezerAcc).setFrozen(lp.address, true))
      .to.emit(wetk, "AccountFrozen")
      .withArgs(lp, true);
    expect(await wetk.frozen(lp.address)).to.equal(true);

    await expect(wetk.connect(freezerAcc).setFrozen(lp.address, false))
      .to.emit(wetk, "AccountFrozen")
      .withArgs(lp, false);
    expect(await wetk.frozen(lp.address)).to.equal(false);
  });

  it("decimals returns 18 regardless of underlying eToken decimals", async () => {
    const { wetk } = await helpers.loadFixture(wetokenFixture);
    expect(await wetk.decimals()).to.equal(18);
  });

  it("Contract becomes fully permissionless after renouncing freezer and ownership", async () => {
    const { wetk, owner, lp, lp2, wl } = await helpers.loadFixture(wetokenWithWLFixture);

    // Hand off to open-freeze mode then burn ownership so no one can ever change it back
    await wetk.connect(owner).setFreezer(ZeroAddress);
    await wetk.connect(owner).renounceOwnership();

    expect(await wetk.freezer()).to.equal(ZeroAddress);
    expect(await wetk.owner()).to.equal(ZeroAddress);

    // No one can restore a freezer — even the original owner is locked out
    await expect(wetk.connect(owner).setFreezer(lp.address))
      .to.be.revertedWithCustomError(wetk, "OwnableUnauthorizedAccount")
      .withArgs(owner);

    // But anyone can still call setFrozen, validated against the whitelist
    await wl.whitelistAddress(lp.address, makeWhitelistStatus("UUBW"));
    await expect(wetk.connect(lp2).setFrozen(lp.address, true)).to.emit(wetk, "AccountFrozen").withArgs(lp, true);
  });
});
