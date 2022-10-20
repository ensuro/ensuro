const { expect } = require("chai");
const hre = require("hardhat");
const helpers = require("@nomicfoundation/hardhat-network-helpers");

const { initCurrency, amountFunction, _W } = require("./test-utils");

describe("Test Implementation contracts can't be initialized", function () {
  const rndAddr = "0xd758af6bfc2f0908d7c5f89942be52c36a6b3cab";

  async function setupFixture() {
    const [owner] = await hre.ethers.getSigners();

    const _A = amountFunction(6);

    const currency = await initCurrency({ name: "Test USDC", symbol: "USDC", decimals: 6, initial_supply: _A(10000) });
    const AccessManager = await hre.ethers.getContractFactory("AccessManager");
    const PolicyPool = await hre.ethers.getContractFactory("PolicyPool");

    // Deploy AccessManager
    const access = await hre.upgrades.deployProxy(AccessManager, [], { kind: "uups" });

    await access.deployed();

    return {
      currency,
      _A,
      owner,
      access,
      PolicyPool,
    };
  }

  async function setupFixtureWithPool() {
    const ret = await setupFixture();
    const policyPool = await hre.upgrades.deployProxy(ret.PolicyPool, ["Policy NFT", "EPOL", rndAddr], {
      constructorArgs: [ret.access.address, ret.currency.address],
      kind: "uups",
      unsafeAllow: ["delegatecall"],
    });

    await policyPool.deployed();

    return {
      policyPool,
      ...ret,
    };
  }

  it("Does not allow initialize AccessManager implementation", async () => {
    const AccessManager = await hre.ethers.getContractFactory("AccessManager");
    const access = await AccessManager.deploy();
    await expect(access.initialize()).to.be.revertedWith("contract is already initialized");
  });

  it("Does not allow initialize PolicyPool implementation", async () => {
    const { currency, access, PolicyPool } = await helpers.loadFixture(setupFixture);
    const pool = await PolicyPool.deploy(access.address, currency.address);
    await expect(pool.initialize("Ensuro", "EPOL", rndAddr)).to.be.revertedWith("contract is already initialized");
  });

  it("Does not allow initialize EToken implementation", async () => {
    const { policyPool } = await helpers.loadFixture(setupFixtureWithPool);
    const EToken = await hre.ethers.getContractFactory("EToken");
    const etk = await EToken.deploy(policyPool.address);
    await expect(etk.initialize("eUSD Foobar", "eUSD", _W(1), _W("0.05"))).to.be.revertedWith(
      "contract is already initialized"
    );
  });

  it("Does not allow initialize EToken implementation", async () => {
    const { policyPool } = await helpers.loadFixture(setupFixtureWithPool);
    const EToken = await hre.ethers.getContractFactory("EToken");
    const etk = await EToken.deploy(policyPool.address);
    await expect(etk.initialize("eUSD Foobar", "eUSD", _W(1), _W("0.05"))).to.be.revertedWith(
      "contract is already initialized"
    );
  });
});
