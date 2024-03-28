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

    return { currency, _A, owner, access, PolicyPool };
  }

  async function setupFixtureWithPool() {
    const ret = await setupFixture();
    const policyPool = await deployPool({ currency: ret.currency, access: ret.access });
    return { policyPool, ...ret };
  }

  async function setupFixtureWithPoolAndPA() {
    const ret = await setupFixtureWithPool();
    const premiumsAccount = await deployPremiumsAccount(ret.policyPool, {});
    return { premiumsAccount, ...ret };
  }

  // Nothing to check in AccessManager constructor

  it("Checks PolicyPool constructor validations", async () => {
    const { access, PolicyPool, currency } = await helpers.loadFixture(setupFixtureWithPool);
    const initArgs = ["foo", "bar", rndAddr];
    const currencyAddr = await hre.ethers.resolveAddress(currency);
    const accessAddr = await hre.ethers.resolveAddress(access);
    await expect(
      hre.upgrades.deployProxy(PolicyPool, initArgs, {
        constructorArgs: [ZeroAddress, currencyAddr],
        ...deployProxyArgs,
      })
    ).to.be.revertedWithCustomError(PolicyPool, "NoZeroAccess");
    await expect(
      hre.upgrades.deployProxy(PolicyPool, initArgs, {
        constructorArgs: [accessAddr, ZeroAddress],
        ...deployProxyArgs,
      })
    ).to.be.revertedWithCustomError(PolicyPool, "NoZeroCurrency");
  });

  it("Checks EToken constructor validations", async () => {
    const EToken = await hre.ethers.getContractFactory("EToken");
    const initArgs = ["foo", "bar", 0, 0];
    await expect(
      hre.upgrades.deployProxy(EToken, initArgs, { constructorArgs: [ZeroAddress], ...deployReserveArgs })
    ).to.be.revertedWithCustomError(EToken, "NoZeroPolicyPool");
  });

  it("Checks PremiumsAccount constructor validations", async () => {
    const PremiumsAccount = await hre.ethers.getContractFactory("PremiumsAccount");
    await expect(
      hre.upgrades.deployProxy(PremiumsAccount, [], {
        constructorArgs: [ZeroAddress, ZeroAddress, ZeroAddress],
        ...deployReserveArgs,
      })
    ).to.be.revertedWithCustomError(PremiumsAccount, "NoZeroPolicyPool");
  });

  it("Checks TrustfulRiskModule constructor validations", async () => {
    const { premiumsAccount, policyPool, currency, access } = await helpers.loadFixture(setupFixtureWithPoolAndPA);
    const TrustfulRiskModule = await hre.ethers.getContractFactory("TrustfulRiskModule");
    const initArgs = ["foo", 0, 0, 0, 0, 0, rndAddr];
    const paAddr = await hre.ethers.resolveAddress(premiumsAccount);
    const poolAddr = await hre.ethers.resolveAddress(policyPool);
    await expect(
      hre.upgrades.deployProxy(TrustfulRiskModule, initArgs, {
        constructorArgs: [ZeroAddress, paAddr],
        ...deployProxyArgs,
      })
    ).to.be.revertedWithCustomError(TrustfulRiskModule, "NoZeroPolicyPool");
    await expect(
      hre.upgrades.deployProxy(TrustfulRiskModule, initArgs, {
        constructorArgs: [poolAddr, ZeroAddress],
        ...deployProxyArgs,
      })
    ).to.be.reverted;
    const anotherPool = await deployPool({
      currency: currency,
      access: access,
      dontGrantL123Roles: true,
    });
    const anotherPA = await deployPremiumsAccount(anotherPool, {});
    const anotherPAAddr = await hre.ethers.resolveAddress(anotherPA);
    await expect(
      hre.upgrades.deployProxy(TrustfulRiskModule, initArgs, {
        constructorArgs: [poolAddr, anotherPAAddr],
        ...deployProxyArgs,
      })
    ).to.be.revertedWithCustomError(TrustfulRiskModule, "PremiumsAccountMustBePartOfThePool");
  });

  it("Checks SignedQuoteRiskModule constructor validations", async () => {
    const { premiumsAccount, policyPool, currency, access } = await helpers.loadFixture(setupFixtureWithPoolAndPA);
    const SignedQuoteRiskModule = await hre.ethers.getContractFactory("SignedQuoteRiskModule");
    const initArgs = ["foo", 0, 0, 0, 0, 0, rndAddr];
    const poolAddr = await hre.ethers.resolveAddress(policyPool);
    const paAddr = await hre.ethers.resolveAddress(premiumsAccount);
    await expect(
      hre.upgrades.deployProxy(SignedQuoteRiskModule, initArgs, {
        constructorArgs: [ZeroAddress, paAddr, false],
        ...deployProxyArgs,
      })
    ).to.be.revertedWithCustomError(SignedQuoteRiskModule, "NoZeroPolicyPool");
    await expect(
      hre.upgrades.deployProxy(SignedQuoteRiskModule, initArgs, {
        constructorArgs: [poolAddr, ZeroAddress, false],
        ...deployProxyArgs,
      })
    ).to.be.reverted;
    const anotherPool = await deployPool({
      currency: currency,
      access: access,
      dontGrantL123Roles: true,
    });
    const anotherPA = await deployPremiumsAccount(anotherPool, {});
    const anotherPaAddr = await hre.ethers.resolveAddress(anotherPA);
    await expect(
      hre.upgrades.deployProxy(SignedQuoteRiskModule, initArgs, {
        constructorArgs: [poolAddr, anotherPaAddr, false],
        ...deployProxyArgs,
      })
    ).to.be.revertedWithCustomError(SignedQuoteRiskModule, "PremiumsAccountMustBePartOfThePool");
  });

  it("Checks LPManualWhitelist constructor validations", async () => {
    const LPManualWhitelist = await hre.ethers.getContractFactory("LPManualWhitelist");
    await expect(
      hre.upgrades.deployProxy(LPManualWhitelist, [], { constructorArgs: [ZeroAddress], ...deployProxyArgs })
    ).to.be.revertedWithCustomError(LPManualWhitelist, "NoZeroPolicyPool");
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
