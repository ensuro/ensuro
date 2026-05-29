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

  it("Rejects wrap with zero amount", async () => {
    const { wetk } = await helpers.loadFixture(wetokenFixture);
    await expect(wetk.wrap(0n)).to.be.revertedWithCustomError(wetk, "ZeroAmount");
  });

  it("Rejects unwrap with zero amount", async () => {
    const { wetk } = await helpers.loadFixture(wetokenFixture);
    await expect(wetk.unwrap(0n)).to.be.revertedWithCustomError(wetk, "ZeroAmount");
  });

  it("Wraps eTokens to WETokens at initial scale", async () => {
    const { etk, wetk, lp } = await helpers.loadFixture(wetokenFixture);
    const etkAmount = _A(1000);
    // wetkAmount = etkAmount * WAD / scale; at SCALE_INITIAL each eToken unit gives 10000 WEToken units
    const expectedWetk = (etkAmount * WAD) / SCALE_INITIAL;

    expect(await wetk.getWETokenByEToken(etkAmount)).to.equal(expectedWetk);
    await expect(wetk.connect(lp).wrap(etkAmount)).to.emit(wetk, "Transfer").withArgs(ZeroAddress, lp, expectedWetk);
    expect(await wetk.balanceOf(lp)).to.equal(expectedWetk);
    expect(await etk.balanceOf(wetk)).to.equal(etkAmount);
  });

  it("Unwraps WETokens to eTokens at initial scale", async () => {
    const { etk, wetk, lp } = await helpers.loadFixture(wetokenFixture);
    const etkAmount = _A(1000);
    const expectedWetk = (etkAmount * WAD) / SCALE_INITIAL;
    await wetk.connect(lp).wrap(etkAmount);

    expect(await wetk.getETokenByWEToken(expectedWetk)).to.equal(etkAmount);
    await expect(wetk.connect(lp).unwrap(expectedWetk))
      .to.emit(wetk, "Transfer")
      .withArgs(lp, ZeroAddress, expectedWetk);
    expect(await etk.balanceOf(lp)).to.closeTo(_A(3000), 1n);
    expect(await wetk.balanceOf(lp)).to.equal(0n);
  });

  it("Round-trips wrap then unwrap with no loss", async () => {
    const { etk, wetk, lp } = await helpers.loadFixture(wetokenFixture);
    const etkBefore = await etk.balanceOf(lp);
    const etkAmount = _A(1000);
    const wetkMinted = (etkAmount * WAD) / SCALE_INITIAL;

    await wetk.connect(lp).wrap(etkAmount);
    await wetk.connect(lp).unwrap(wetkMinted);

    expect(await wetk.balanceOf(lp)).to.equal(0n);
    expect(await etk.balanceOf(lp)).to.closeTo(etkBefore, 1n);
  });

  it("Conversion view functions return correct rates at initial scale", async () => {
    const { wetk } = await helpers.loadFixture(wetokenFixture);
    expect(await wetk.eTokenPerWEToken()).to.equal(SCALE_INITIAL);
    expect(await wetk.weTokenPerEToken()).to.equal((WAD * WAD) / SCALE_INITIAL);
  });

  it("WETokens gain value as yield accrues", async () => {
    const { etk, wetk, lp, yieldVault } = await helpers.loadFixture(wetokenWithYieldFixture);
    const etkAmount = _A(1000);
    const wetkMinted = (etkAmount * WAD) / SCALE_INITIAL;
    await wetk.connect(lp).wrap(etkAmount);

    // Generate yield: move USDC to vault, earn 100 USDC (etk receives ~50 due to virtual share)
    await etk.depositIntoYieldVault(MaxUint256);
    await yieldVault.discreteEarning(_A(100));
    await etk.recordEarnings();

    expect(await wetk.eTokenPerWEToken()).to.be.gt(SCALE_INITIAL);
    expect(await wetk.getETokenByWEToken(wetkMinted)).to.be.gt(etkAmount);
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
    await wetk.connect(lp).wrap(_A(1000));

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

  it("Unwrap is not blocked for frozen accounts", async () => {
    const { wetk, lp, freezerAcc, wl } = await helpers.loadFixture(wetokenWithWLFixture);
    await wetk.connect(lp).wrap(_A(1000));
    await wl.whitelistAddress(lp.address, makeWhitelistStatus("UUBW"));
    await wetk.connect(freezerAcc).setFrozen(lp.address, true);

    // burn: to == address(0), so _update freeze check is skipped
    const wetkBalance = await wetk.balanceOf(lp);
    await expect(wetk.connect(lp).unwrap(wetkBalance)).not.to.be.reverted;
  });

  it("Receiving WETokens is not blocked for frozen accounts", async () => {
    const { wetk, lp, lp2, freezerAcc, wl } = await helpers.loadFixture(wetokenWithWLFixture);
    await wetk.connect(lp).wrap(_A(1000));

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
