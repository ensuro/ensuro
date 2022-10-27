const { expect } = require("chai");
const helpers = require("@nomicfoundation/hardhat-network-helpers");
const { initCurrency, deployPool, deployPremiumsAccount, amountFunction } = require("./test-utils");

describe("Supports interface implementation", function () {
  const invalidInterfaceId = "0x12345678";
  const zeroAddress = hre.ethers.constants.AddressZero;
  const rndAddr = "0xd758af6bfc2f0908d7c5f89942be52c36a6b3cab";

  async function setupFixture() {
    const [owner] = await hre.ethers.getSigners();
    /**
     * Interface ids were calculated with this code, but we prefer to leave the values hard-coded, so this
     * test fails when we change some interface. This way we can be sure we don't change interfaces
     * by accident
     */
    /*
    const InterfaceIdCalculator = await ethers.getContractFactory("InterfaceIdCalculator");
    const iidCalculator = await InterfaceIdCalculator.deploy();
    const interfaces = [
      "IERC165",
      "IERC20",
      "IERC20Metadata",
      "IERC721",
      "IAccessControl",
      "IEToken",
      "IPolicyPool",
      "IPolicyPoolComponent",
      "IEToken",
      "IRiskModule",
      "IPremiumsAccount",
      "ILPWhitelist",
      "IAccessManager",
      "IAssetManager",
    ];
    const interfaceIds = {};
    for (const iName of interfaces) {
      interfaceIds[iName] = await iidCalculator[iName.toUpperCase() + "_INTERFACEID"]();
    }
    // console.log(interfaceIds);
    */
    const interfaceIds = {
      IERC165: "0x01ffc9a7",
      IERC20: "0x36372b07",
      IERC20Metadata: "0xa219a025",
      IERC721: "0x80ac58cd",
      IAccessControl: "0x7965db0b",
      IEToken: "0x027466bc",
      IPolicyPool: "0x4b195a48",
      IPolicyPoolComponent: "0x4cea22a4",
      IRiskModule: "0xda40804f",
      IPremiumsAccount: "0xb76712ec",
      ILPWhitelist: "0x6823eaea",
      IAccessManager: "0x272b8c47",
      IAssetManager: "0x799c2a5c",
    };

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
      interfaceIds,
    };
  }

  async function setupFixtureWithPool() {
    const ret = await setupFixture();
    const policyPool = await deployPool(hre, { currency: ret.currency.address });
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

  it("Checks AccessManager supported interfaces", async () => {
    const { interfaceIds, access } = await helpers.loadFixture(setupFixture);
    expect(await access.supportsInterface(interfaceIds.IERC165)).to.be.true;
    expect(await access.supportsInterface(interfaceIds.IAccessControl)).to.be.true;
    expect(await access.supportsInterface(interfaceIds.IAccessManager)).to.be.true;
    expect(await access.supportsInterface(invalidInterfaceId)).to.be.false;
  });

  it("Checks PolicyPool supported interfaces", async () => {
    const { policyPool, interfaceIds } = await helpers.loadFixture(setupFixtureWithPool);
    expect(await policyPool.supportsInterface(interfaceIds.IERC165)).to.be.true;
    expect(await policyPool.supportsInterface(interfaceIds.IPolicyPool)).to.be.true;
    expect(await policyPool.supportsInterface(interfaceIds.IERC721)).to.be.true;
    expect(await policyPool.supportsInterface(interfaceIds.IAccessManager)).to.be.false;
  });

  it("Checks EToken supported interfaces", async () => {
    const { policyPool, interfaceIds } = await helpers.loadFixture(setupFixtureWithPool);
    const EToken = await hre.ethers.getContractFactory("EToken");
    const etk = await EToken.deploy(policyPool.address);
    expect(await etk.supportsInterface(interfaceIds.IERC165)).to.be.true;
    expect(await etk.supportsInterface(interfaceIds.IERC20)).to.be.true;
    expect(await etk.supportsInterface(interfaceIds.IERC20Metadata)).to.be.true;
    expect(await etk.supportsInterface(interfaceIds.IEToken)).to.be.true;
    expect(await etk.supportsInterface(interfaceIds.IERC721)).to.be.false;
  });

  it("Checks PremiumsAccount supported interfaces", async () => {
    const { interfaceIds, premiumsAccount } = await helpers.loadFixture(setupFixtureWithPoolAndPA);
    expect(await premiumsAccount.supportsInterface(interfaceIds.IERC165)).to.be.true;
    expect(await premiumsAccount.supportsInterface(interfaceIds.IPremiumsAccount)).to.be.true;
    expect(await premiumsAccount.supportsInterface(interfaceIds.IERC721)).to.be.false;
  });

  it("Checks TrustfulRiskModule supported interfaces", async () => {
    const { interfaceIds, premiumsAccount, policyPool } = await helpers.loadFixture(setupFixtureWithPoolAndPA);
    const TrustfulRiskModule = await hre.ethers.getContractFactory("TrustfulRiskModule");
    const rm = await TrustfulRiskModule.deploy(policyPool.address, premiumsAccount.address);
    expect(await rm.supportsInterface(interfaceIds.IERC165)).to.be.true;
    expect(await rm.supportsInterface(interfaceIds.IRiskModule)).to.be.true;
    expect(await rm.supportsInterface(interfaceIds.IPremiumsAccount)).to.be.false;
  });

  it("Checks SignedQuoteRiskModule supported interfaces", async () => {
    const { interfaceIds, premiumsAccount, policyPool } = await helpers.loadFixture(setupFixtureWithPoolAndPA);
    const SignedQuoteRiskModule = await hre.ethers.getContractFactory("SignedQuoteRiskModule");
    const rm = await SignedQuoteRiskModule.deploy(policyPool.address, premiumsAccount.address, false);
    expect(await rm.supportsInterface(interfaceIds.IERC165)).to.be.true;
    expect(await rm.supportsInterface(interfaceIds.IRiskModule)).to.be.true;
    expect(await rm.supportsInterface(interfaceIds.IPremiumsAccount)).to.be.false;
  });

  it("Checks LPManualWhitelist supported interfaces", async () => {
    const { policyPool, interfaceIds } = await helpers.loadFixture(setupFixtureWithPool);
    const LPManualWhitelist = await hre.ethers.getContractFactory("LPManualWhitelist");
    const wh = await LPManualWhitelist.deploy(policyPool.address);
    expect(await wh.supportsInterface(interfaceIds.IERC165)).to.be.true;
    expect(await wh.supportsInterface(interfaceIds.ILPWhitelist)).to.be.true;
    expect(await wh.supportsInterface(interfaceIds.IPremiumsAccount)).to.be.false;
  });

  it("Broken if ERC4626AssetManager asset have zero address", async () => {
    const ERC4626AssetManager = await hre.ethers.getContractFactory("ERC4626AssetManager");
    await expect(ERC4626AssetManager.deploy(zeroAddress, rndAddr)).to.be.revertedWith(
      "LiquidityThresholdAssetManager: asset cannot be zero address"
    );
  });

  it("Broken if ERC4626AssetManager vault have zero address", async () => {
    const { currency } = await helpers.loadFixture(setupFixtureWithPool);
    const ERC4626AssetManager = await hre.ethers.getContractFactory("ERC4626AssetManager");
    await expect(ERC4626AssetManager.deploy(currency.address, zeroAddress)).to.be.revertedWith(
      "ERC4626AssetManager: vault cannot be zero address"
    );
  });

  it("Checks ERC4626AssetManager supported interfaces", async () => {
    const { currency, interfaceIds } = await helpers.loadFixture(setupFixtureWithPool);
    const ERC4626AssetManager = await hre.ethers.getContractFactory("ERC4626AssetManager");
    const am = await ERC4626AssetManager.deploy(currency.address, currency.address);
    expect(await am.supportsInterface(interfaceIds.IERC165)).to.be.true;
    expect(await am.supportsInterface(interfaceIds.IAssetManager)).to.be.true;
    expect(await am.supportsInterface(interfaceIds.IERC20)).to.be.false;
  });
});
