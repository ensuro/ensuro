const { expect } = require("chai");
const helpers = require("@nomicfoundation/hardhat-network-helpers");
const { amountFunction } = require("../js/utils");
const { initCurrency, deployPool, deployPremiumsAccount } = require("../js/test-utils");

const { ZeroAddress } = hre.ethers;

describe("Constructor validations", function () {
  const rndAddr = "0xd758af6bfc2f0908d7c5f89942be52c36a6b3cab";
  const deployProxyArgs = {
    kind: "uups",
  };

  // Proxy args when the contract is a Reserve (EToken or PremiumsAccount)
  const deployReserveArgs = {
    kind: "uups",
    unsafeAllow: ["delegatecall"],
  };

  async function setupFixture() {
    const [owner] = await hre.ethers.getSigners();
    const _A = amountFunction(6);

    const currency = await initCurrency({ name: "Test USDC", symbol: "USDC", decimals: 6, initial_supply: _A(10000) });
    const AccessManager = await hre.ethers.getContractFactory("AccessManager");
    const PolicyPool = await hre.ethers.getContractFactory("PolicyPool");

    // Deploy AccessManager
    const access = await hre.upgrades.deployProxy(AccessManager, [], { kind: "uups" });

    await access.waitForDeployment();

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
    const policyPool = await deployPool({ currency: ret.currency.target, access: ret.access.target });
    return {
      policyPool,
      ...ret,
    };
  }

  async function setupFixtureWithPoolAndPA() {
    const ret = await setupFixtureWithPool();
    const premiumsAccount = await deployPremiumsAccount(ret.policyPool, {});
    return {
      premiumsAccount,
      ...ret,
    };
  }

  // Nothing to check in AccessManager constructor

  it("Checks PolicyPool constructor validations", async () => {
    const { access, PolicyPool, currency } = await helpers.loadFixture(setupFixtureWithPool);
    const initArgs = ["foo", "bar", rndAddr];
    await expect(
      hre.upgrades.deployProxy(PolicyPool, initArgs, {
        constructorArgs: [ZeroAddress, currency.target],
        ...deployProxyArgs,
      })
    ).to.be.revertedWith("PolicyPool: access cannot be zero address");
    await expect(
      hre.upgrades.deployProxy(PolicyPool, initArgs, {
        constructorArgs: [access.target, ZeroAddress],
        ...deployProxyArgs,
      })
    ).to.be.revertedWith("PolicyPool: currency cannot be zero address");
  });

  it("Checks EToken constructor validations", async () => {
    const EToken = await hre.ethers.getContractFactory("EToken");
    const initArgs = ["foo", "bar", 0, 0];
    await expect(
      hre.upgrades.deployProxy(EToken, initArgs, { constructorArgs: [ZeroAddress], ...deployReserveArgs })
    ).to.be.revertedWith("PolicyPoolComponent: policyPool cannot be zero address");
  });

  it("Checks PremiumsAccount constructor validations", async () => {
    const PremiumsAccount = await hre.ethers.getContractFactory("PremiumsAccount");
    await expect(
      hre.upgrades.deployProxy(PremiumsAccount, [], {
        constructorArgs: [ZeroAddress, ZeroAddress, ZeroAddress],
        ...deployReserveArgs,
      })
    ).to.be.revertedWith("PolicyPoolComponent: policyPool cannot be zero address");
  });

  it("Checks TrustfulRiskModule constructor validations", async () => {
    const { premiumsAccount, policyPool, currency, access } = await helpers.loadFixture(setupFixtureWithPoolAndPA);
    const TrustfulRiskModule = await hre.ethers.getContractFactory("TrustfulRiskModule");
    const initArgs = ["foo", 0, 0, 0, 0, 0, rndAddr];
    await expect(
      hre.upgrades.deployProxy(TrustfulRiskModule, initArgs, {
        constructorArgs: [ZeroAddress, premiumsAccount.target],
        ...deployProxyArgs,
      })
    ).to.be.revertedWith("PolicyPoolComponent: policyPool cannot be zero address");
    await expect(
      hre.upgrades.deployProxy(TrustfulRiskModule, initArgs, {
        constructorArgs: [policyPool.target, ZeroAddress],
        ...deployProxyArgs,
      })
    ).to.be.reverted;
    const anotherPool = await deployPool({
      currency: currency.target,
      access: access.target,
      dontGrantL123Roles: true,
    });
    const anotherPA = await deployPremiumsAccount(anotherPool, {});
    await expect(
      hre.upgrades.deployProxy(TrustfulRiskModule, initArgs, {
        constructorArgs: [policyPool.target, anotherPA.target],
        ...deployProxyArgs,
      })
    ).to.be.revertedWith("The PremiumsAccount must be part of the Pool");
  });

  it("Checks SignedQuoteRiskModule constructor validations", async () => {
    const { premiumsAccount, policyPool, currency, access } = await helpers.loadFixture(setupFixtureWithPoolAndPA);
    const SignedQuoteRiskModule = await hre.ethers.getContractFactory("SignedQuoteRiskModule");
    const initArgs = ["foo", 0, 0, 0, 0, 0, rndAddr];
    await expect(
      hre.upgrades.deployProxy(SignedQuoteRiskModule, initArgs, {
        constructorArgs: [ZeroAddress, premiumsAccount.target, false],
        ...deployProxyArgs,
      })
    ).to.be.revertedWith("PolicyPoolComponent: policyPool cannot be zero address");
    await expect(
      hre.upgrades.deployProxy(SignedQuoteRiskModule, initArgs, {
        constructorArgs: [policyPool.target, ZeroAddress, false],
        ...deployProxyArgs,
      })
    ).to.be.reverted;
    const anotherPool = await deployPool({
      currency: currency.target,
      access: access.target,
      dontGrantL123Roles: true,
    });
    const anotherPA = await deployPremiumsAccount(anotherPool, {});
    await expect(
      hre.upgrades.deployProxy(SignedQuoteRiskModule, initArgs, {
        constructorArgs: [policyPool.target, anotherPA.target, false],
        ...deployProxyArgs,
      })
    ).to.be.revertedWith("The PremiumsAccount must be part of the Pool");
  });

  it("Checks LPManualWhitelist constructor validations", async () => {
    const LPManualWhitelist = await hre.ethers.getContractFactory("LPManualWhitelist");
    await expect(
      hre.upgrades.deployProxy(LPManualWhitelist, [], { constructorArgs: [ZeroAddress], ...deployProxyArgs })
    ).to.be.revertedWith("PolicyPoolComponent: policyPool cannot be zero address");
  });

  it("Checks ERC4626AssetManager constructor validations", async () => {
    const ERC4626AssetManager = await hre.ethers.getContractFactory("ERC4626AssetManager");
    await expect(ERC4626AssetManager.deploy(ZeroAddress, rndAddr)).to.be.revertedWith(
      "LiquidityThresholdAssetManager: asset cannot be zero address"
    );
    await expect(ERC4626AssetManager.deploy(rndAddr, ZeroAddress)).to.be.revertedWith(
      "ERC4626AssetManager: vault cannot be zero address"
    );
  });
});
