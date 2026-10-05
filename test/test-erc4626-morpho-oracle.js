const { expect } = require("chai");
const hre = require("hardhat");
const helpers = require("@nomicfoundation/hardhat-network-helpers");

const { amountFunction, _W } = require("@ensuro/utils/js/utils");
const { initCurrency } = require("@ensuro/utils/js/test-utils");
const { deployPool, addEToken } = require("../js/test-utils");

const { ethers } = hre;
const { MaxUint256 } = ethers;

const _A = amountFunction(6);
const WAD = _W(1);

describe("ERC4626MorphoOracle", () => {
  async function fixture() {
    const [owner, lp] = await hre.ethers.getSigners();
    const currency = await initCurrency(
      { name: "Test USDC", symbol: "USDC", decimals: 6, initial_supply: _A(10000) },
      [lp],
      [_A(5000)]
    );
    const pool = await deployPool({ currency });
    pool._A = _A;
    const etk = await addEToken(pool, {});

    await currency.connect(lp).approve(pool, _A(5000));
    await pool.connect(lp).deposit(etk, _A(3000), lp);

    const WEToken = await ethers.getContractFactory("WEToken");
    const wetk = await WEToken.deploy(etk, "Wrapped EToken", "WETK", owner.address, owner.address);

    const ERC4626MorphoOracle = await ethers.getContractFactory("ERC4626MorphoOracle");
    const oracle = await ERC4626MorphoOracle.deploy(wetk);

    return { currency, pool, etk, wetk, oracle, lp, owner };
  }

  async function fixtureWithYield() {
    const ret = await fixture();
    const { etk, currency } = ret;
    const TestERC4626 = await ethers.getContractFactory("TestERC4626");
    const yieldVault = await TestERC4626.deploy("Yield Vault", "YIELD", currency);
    await etk.setYieldVault(yieldVault, false);
    return { yieldVault, ...ret };
  }

  it("Stores the vault immutably", async () => {
    const { oracle, wetk } = await helpers.loadFixture(fixture);
    expect(await oracle.vault()).to.equal(await wetk.getAddress());
  });

  it("Returns 1e24 (1 underlying per share) at the initial scale", async () => {
    const { oracle, wetk, lp, etk } = await helpers.loadFixture(fixture);

    await etk.connect(lp).approve(wetk, MaxUint256);
    await wetk.connect(lp).deposit(_A(1000), lp.address);

    expect(await oracle.price()).to.equal(10n ** 24n);
  });

  it("Price grows as the vault accrues yield", async () => {
    const { oracle, wetk, lp, etk, yieldVault } = await helpers.loadFixture(fixtureWithYield);

    await etk.connect(lp).approve(wetk, MaxUint256);
    await wetk.connect(lp).deposit(_A(1000), lp.address);

    const initialPrice = await oracle.price();
    expect(initialPrice).to.equal(10n ** 24n);

    await etk.depositIntoYieldVault(MaxUint256);
    await yieldVault.discreteEarning(_A(100));
    await etk.recordEarnings();

    expect(await oracle.price()).to.be.gt(initialPrice);
  });

  it("Matches convertToAssets scaled by 1e18", async () => {
    const { oracle, wetk } = await helpers.loadFixture(fixture);
    const expected = (await wetk.convertToAssets(WAD)) * 10n ** 18n;
    expect(await oracle.price()).to.equal(expected);
  });
});
