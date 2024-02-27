const { expect } = require("chai");
const hre = require("hardhat");
const helpers = require("@nomicfoundation/hardhat-network-helpers");

const { amountFunction, grantRole } = require("../js/utils");
const { initCurrency, deployPool, addEToken } = require("../js/test-utils");

describe("Etoken", () => {
  const _A = amountFunction(6);
  let lp, lp2;

  beforeEach(async () => {
    [, lp, lp2] = await hre.ethers.getSigners();
  });

  it("Refuses transfers to null address", async () => {
    const { etk } = await helpers.loadFixture(etokenFixture);
    await expect(etk.transfer(hre.ethers.ZeroAddress, _A(10))).to.be.revertedWith(
      "EToken: transfer to the zero address"
    );
  });

  it("Checks user balance", async () => {
    const { etk } = await helpers.loadFixture(etokenFixture);

    await expect(etk.connect(lp2).transfer(lp, _A(10))).to.be.revertedWith("EToken: transfer amount exceeds balance");
  });

  it("Returns the available funds", async () => {
    const { etk, pool } = await helpers.loadFixture(etokenFixture);
    expect(await etk.fundsAvailable()).to.equal(_A(3000));

    await pool.connect(lp).withdraw(etk, _A(3000));

    expect(await etk.fundsAvailable()).to.equal(_A(0));
  });

  it("Only allows PolicyPool to add new borrowers", async () => {
    const { etk } = await helpers.loadFixture(etokenFixture);

    await expect(etk.addBorrower(lp)).to.be.revertedWith("The caller must be the PolicyPool");
  });

  it("Only allows PolicyPool to remove borrowers", async () => {
    const { etk } = await helpers.loadFixture(etokenFixture);

    await expect(etk.removeBorrower(lp)).to.be.revertedWith("The caller must be the PolicyPool");
  });

  it("Allows setting whitelist to null", async () => {
    const { etk, pool } = await helpers.loadFixture(etokenFixture);

    grantRole(hre, await pool.access(), "GUARDIAN_ROLE");

    expect(await etk.setWhitelist(hre.ethers.ZeroAddress)).to.emit(await pool.access(), "ComponentChanged");

    expect(await etk.whitelist()).to.equal(hre.ethers.ZeroAddress);
  });

  it("Can't create etoken without name or symbol", async () => {
    const { pool } = await helpers.loadFixture(etokenFixture);

    await expect(addEToken(pool, { etkName: "" })).to.be.revertedWith("EToken: name cannot be empty");
    await expect(addEToken(pool, { etkSymbol: "" })).to.be.revertedWith("EToken: symbol cannot be empty");
  });

  async function etokenFixture() {
    const currency = await initCurrency(
      { name: "Test USDC", symbol: "USDC", decimals: 6, initial_supply: _A(10000) },
      [lp],
      [_A(5000)]
    );

    const pool = await deployPool({
      currency: currency,
      grantRoles: [],
      treasuryAddress: "0x87c47c9a5a2aa74ae714857d64911d9a091c25b1", // Random address
    });
    pool._A = _A;

    const etk = await addEToken(pool, {});

    await currency.connect(lp).approve(pool, _A(5000));
    await pool.connect(lp).deposit(etk, _A(3000));

    return { currency, pool, etk };
  }
});
