const { expect } = require("chai");
const helpers = require("@nomicfoundation/hardhat-network-helpers");
const { initCurrency, deployPool, deployPremiumsAccount, amountFunction } = require("./test-utils");

describe("Constructor validations", function () {
  const zeroAddress = hre.ethers.constants.AddressZero;
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
    const policyPool = await deployPool(hre, { currency: ret.currency.address, access: ret.access.address });
    return {
      policyPool,
      ...ret,
    };
  }

  async function setupFixtureWithPoolAndPA() {
    const ret = await setupFixtureWithPool();
    const premiumsAccount = await deployPremiumsAccount(hre, ret.policyPool, {});
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
        constructorArgs: [zeroAddress, currency.address],
        ...deployProxyArgs,
      })
    ).to.be.revertedWith("PolicyPool: access cannot be zero address");
    await expect(
      hre.upgrades.deployProxy(PolicyPool, initArgs, {
        constructorArgs: [access.address, zeroAddress],
        ...deployProxyArgs,
      })
    ).to.be.revertedWith("PolicyPool: currency cannot be zero address");
  });

  it("Checks EToken constructor validations", async () => {
    const EToken = await hre.ethers.getContractFactory("EToken");
    const initArgs = ["foo", "bar", 0, 0];
    await expect(
      hre.upgrades.deployProxy(EToken, initArgs, { constructorArgs: [zeroAddress], ...deployReserveArgs })
    ).to.be.revertedWith("PolicyPoolComponent: policyPool cannot be zero address");
  });

  it("Checks PremiumsAccount constructor validations", async () => {
    const PremiumsAccount = await hre.ethers.getContractFactory("PremiumsAccount");
    await expect(
      hre.upgrades.deployProxy(PremiumsAccount, [], {
        constructorArgs: [zeroAddress, zeroAddress, zeroAddress],
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
        constructorArgs: [zeroAddress, premiumsAccount.address],
        ...deployProxyArgs,
      })
    ).to.be.revertedWith("PolicyPoolComponent: policyPool cannot be zero address");
    await expect(
      hre.upgrades.deployProxy(TrustfulRiskModule, initArgs, {
        constructorArgs: [policyPool.address, zeroAddress],
        ...deployProxyArgs,
      })
    ).to.be.reverted;
    const anotherPool = await deployPool(hre, {
      currency: currency.address,
      access: access.address,
      dontGrantL123Roles: true,
    });
    const anotherPA = await deployPremiumsAccount(hre, anotherPool, {});
    await expect(
      hre.upgrades.deployProxy(TrustfulRiskModule, initArgs, {
        constructorArgs: [policyPool.address, anotherPA.address],
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
        constructorArgs: [zeroAddress, premiumsAccount.address, false],
        ...deployProxyArgs,
      })
    ).to.be.revertedWith("PolicyPoolComponent: policyPool cannot be zero address");
    await expect(
      hre.upgrades.deployProxy(SignedQuoteRiskModule, initArgs, {
        constructorArgs: [policyPool.address, zeroAddress, false],
        ...deployProxyArgs,
      })
    ).to.be.reverted;
    const anotherPool = await deployPool(hre, {
      currency: currency.address,
      access: access.address,
      dontGrantL123Roles: true,
    });
    const anotherPA = await deployPremiumsAccount(hre, anotherPool, {});
    await expect(
      hre.upgrades.deployProxy(SignedQuoteRiskModule, initArgs, {
        constructorArgs: [policyPool.address, anotherPA.address, false],
        ...deployProxyArgs,
      })
    ).to.be.revertedWith("The PremiumsAccount must be part of the Pool");
  });

  it("Checks LPManualWhitelist constructor validations", async () => {
    const LPManualWhitelist = await hre.ethers.getContractFactory("LPManualWhitelist");
    await expect(
      hre.upgrades.deployProxy(LPManualWhitelist, [], { constructorArgs: [zeroAddress], ...deployProxyArgs })
    ).to.be.revertedWith("PolicyPoolComponent: policyPool cannot be zero address");
  });

  it("Checks ERC4626AssetManager constructor validations", async () => {
    const ERC4626AssetManager = await hre.ethers.getContractFactory("ERC4626AssetManager");
    await expect(ERC4626AssetManager.deploy(zeroAddress, rndAddr)).to.be.revertedWith(
      "LiquidityThresholdAssetManager: asset cannot be zero address"
    );
    await expect(ERC4626AssetManager.deploy(rndAddr, zeroAddress)).to.be.revertedWith(
      "ERC4626AssetManager: vault cannot be zero address"
    );
  });
});
