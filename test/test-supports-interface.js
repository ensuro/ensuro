const { expect } = require("chai");
const helpers = require("@nomicfoundation/hardhat-network-helpers");
const { amountFunction, _W } = require("@ensuro/utils/js/utils");
const { initCurrency } = require("@ensuro/utils/js/test-utils");
const { deployPool, deployPremiumsAccount } = require("../js/test-utils");

describe("Supports interface implementation", function () {
  // eslint-disable-next-line multiline-comment-style
  /* According to ERC165Checker.sol:
        // Any contract that implements ERC165 must explicitly indicate support of
        // InterfaceId_ERC165 and explicitly indicate non-support of InterfaceId_Invalid=0xffffffff
  */
  const invalidInterfaceId = "0xffffffff";

  async function setupFixture() {
    const [owner] = await hre.ethers.getSigners();

    /**
     * Interface ids were calculated with this code, but we prefer to leave the values hard-coded, so this
     * test fails when we change some interface. This way we can be sure we don't change interfaces
     * by accident
     *
    const InterfaceIdCalculator = await ethers.getContractFactory("InterfaceIdCalculator");
    const iidCalculator = await InterfaceIdCalculator.deploy();
    const iinterfaces = [
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
      "IAssetManager",
      "IPolicyHolder",
    ];
    const iinterfaceIds = {};
    for (const iName of iinterfaces) {
      iinterfaceIds[iName] = await iidCalculator.getFunction(iName.toUpperCase() + "_INTERFACEID")();
    }
    console.log(iinterfaceIds);
    */
    const interfaceIds = {
      IERC165: "0x01ffc9a7",
      IERC20: "0x36372b07",
      IERC20Metadata: "0xa219a025",
      IERC721: "0x80ac58cd",
      IAccessControl: "0x7965db0b",
      IEToken: "0x90770621",
      // IPolicyPool: "0x3234fad6", - Up to v2.7
      // IPolicyPool: "0x0ce33b78", - Up to v2.9
      IPolicyPool: "0x7d73446f",
      IPolicyPoolComponent: "0x4d15eb03",
      IRiskModule: "0xda40804f",
      // IPremiumsAccount: "0xb76712ec", - Up to v2.7
      IPremiumsAccount: "0x1ce4a652",
      ILPWhitelist: "0xf8722d89",
      IAssetManager: "0x799c2a5c",
      IPolicyHolder: "0x3ece0a89",
    };

    const _A = amountFunction(6);

    const currency = await initCurrency({ name: "Test USDC", symbol: "USDC", decimals: 6, initial_supply: _A(10000) });
    const PolicyPool = await hre.ethers.getContractFactory("PolicyPool");
    const FixedRateVault = await hre.ethers.getContractFactory("FixedRateVault");

    return {
      currency,
      _A,
      owner,
      PolicyPool,
      interfaceIds,
      FixedRateVault,
    };
  }

  async function setupFixtureWithPool() {
    const ret = await setupFixture();
    const policyPool = await deployPool({ currency: ret.currency });
    return { policyPool, ...ret };
  }

  async function setupFixtureWithPoolAndPA() {
    const ret = await setupFixtureWithPool();
    const premiumsAccount = await deployPremiumsAccount(ret.policyPool, {});
    return {
      premiumsAccount,
      ...ret,
    };
  }

  it("Checks PolicyPool supported interfaces", async () => {
    const { policyPool, interfaceIds } = await helpers.loadFixture(setupFixtureWithPool);
    expect(await policyPool.supportsInterface(interfaceIds.IERC165)).to.be.true;
    expect(await policyPool.supportsInterface(interfaceIds.IPolicyPool)).to.be.true;
    expect(await policyPool.supportsInterface(interfaceIds.IERC721)).to.be.true;
    expect(await policyPool.supportsInterface(invalidInterfaceId)).to.be.false;
  });

  it("Checks EToken supported interfaces", async () => {
    const { policyPool, interfaceIds } = await helpers.loadFixture(setupFixtureWithPool);
    const EToken = await hre.ethers.getContractFactory("EToken");
    const etk = await EToken.deploy(policyPool);
    expect(await etk.supportsInterface(interfaceIds.IERC165)).to.be.true;
    expect(await etk.supportsInterface(interfaceIds.IERC20)).to.be.true;
    expect(await etk.supportsInterface(interfaceIds.IERC20Metadata)).to.be.true;
    expect(await etk.supportsInterface(interfaceIds.IPolicyPoolComponent)).to.be.true;
    expect(await etk.supportsInterface(interfaceIds.IEToken)).to.be.true;
    expect(await etk.supportsInterface(interfaceIds.IERC721)).to.be.false;
    expect(await etk.supportsInterface(invalidInterfaceId)).to.be.false;
  });

  it("Checks PremiumsAccount supported interfaces", async () => {
    const { interfaceIds, premiumsAccount } = await helpers.loadFixture(setupFixtureWithPoolAndPA);
    expect(await premiumsAccount.supportsInterface(interfaceIds.IERC165)).to.be.true;
    expect(await premiumsAccount.supportsInterface(interfaceIds.IPolicyPoolComponent)).to.be.true;
    expect(await premiumsAccount.supportsInterface(interfaceIds.IPremiumsAccount)).to.be.true;
    expect(await premiumsAccount.supportsInterface(interfaceIds.IERC721)).to.be.false;
    expect(await premiumsAccount.supportsInterface(invalidInterfaceId)).to.be.false;
  });

  it("Checks Reserves reject invalid asset manager", async () => {
    const { premiumsAccount, policyPool } = await helpers.loadFixture(setupFixtureWithPoolAndPA);
    const TrustfulRiskModule = await hre.ethers.getContractFactory("TrustfulRiskModule");
    const rm = await TrustfulRiskModule.deploy(policyPool, premiumsAccount);
    await expect(premiumsAccount.setAssetManager(rm, true)).to.be.revertedWith(
      "Reserve: asset manager doesn't implements the required interface"
    );
  });

  it("Checks TrustfulRiskModule supported interfaces", async () => {
    const { interfaceIds, premiumsAccount, policyPool } = await helpers.loadFixture(setupFixtureWithPoolAndPA);
    const TrustfulRiskModule = await hre.ethers.getContractFactory("TrustfulRiskModule");
    const rm = await TrustfulRiskModule.deploy(policyPool, premiumsAccount);
    expect(await rm.supportsInterface(interfaceIds.IERC165)).to.be.true;
    expect(await rm.supportsInterface(interfaceIds.IPolicyPoolComponent)).to.be.true;
    expect(await rm.supportsInterface(interfaceIds.IRiskModule)).to.be.true;
    expect(await rm.supportsInterface(interfaceIds.IPremiumsAccount)).to.be.false;
    expect(await rm.supportsInterface(invalidInterfaceId)).to.be.false;
  });

  it("Checks SignedQuoteRiskModule supported interfaces", async () => {
    const { interfaceIds, premiumsAccount, policyPool } = await helpers.loadFixture(setupFixtureWithPoolAndPA);
    const SignedQuoteRiskModule = await hre.ethers.getContractFactory("SignedQuoteRiskModule");
    const rm = await SignedQuoteRiskModule.deploy(policyPool, premiumsAccount, false);
    expect(await rm.supportsInterface(interfaceIds.IERC165)).to.be.true;
    expect(await rm.supportsInterface(interfaceIds.IRiskModule)).to.be.true;
    expect(await rm.supportsInterface(interfaceIds.IPremiumsAccount)).to.be.false;
    expect(await rm.supportsInterface(invalidInterfaceId)).to.be.false;
  });

  it("Checks LPManualWhitelist supported interfaces", async () => {
    const { policyPool, interfaceIds } = await helpers.loadFixture(setupFixtureWithPool);
    const LPManualWhitelist = await hre.ethers.getContractFactory("LPManualWhitelist");
    const wh = await LPManualWhitelist.deploy(policyPool);
    expect(await wh.supportsInterface(interfaceIds.IERC165)).to.be.true;
    expect(await wh.supportsInterface(interfaceIds.ILPWhitelist)).to.be.true;
    expect(await wh.supportsInterface(interfaceIds.IPremiumsAccount)).to.be.false;
    expect(await wh.supportsInterface(invalidInterfaceId)).to.be.false;
  });

  it("Checks ERC4626AssetManager supported interfaces", async () => {
    const { currency, interfaceIds, FixedRateVault } = await helpers.loadFixture(setupFixtureWithPool);
    const vault = await FixedRateVault.deploy("MyVault", "MYV", currency, _W(1));
    const ERC4626AssetManager = await hre.ethers.getContractFactory("ERC4626AssetManager");
    const am = await ERC4626AssetManager.deploy(currency, vault);
    expect(await am.supportsInterface(interfaceIds.IERC165)).to.be.true;
    expect(await am.supportsInterface(interfaceIds.IAssetManager)).to.be.true;
    expect(await am.supportsInterface(interfaceIds.IERC20)).to.be.false;
    expect(await am.supportsInterface(invalidInterfaceId)).to.be.false;
  });

  it("Checks ERC4626PlusVaultAssetManager supported interfaces", async () => {
    const { currency, interfaceIds, FixedRateVault } = await helpers.loadFixture(setupFixtureWithPool);
    const vault = await FixedRateVault.deploy("MyVault", "MYV", currency, _W(1));
    const discVault = await FixedRateVault.deploy("My Other Vault", "MOV", currency, _W(1));
    const ERC4626PlusVaultAssetManager = await hre.ethers.getContractFactory("ERC4626PlusVaultAssetManager");
    const am = await ERC4626PlusVaultAssetManager.deploy(currency, vault, discVault);
    expect(await am.supportsInterface(interfaceIds.IERC165)).to.be.true;
    expect(await am.supportsInterface(interfaceIds.IAssetManager)).to.be.true;
    expect(await am.supportsInterface(interfaceIds.IERC20)).to.be.false;
    expect(await am.supportsInterface(invalidInterfaceId)).to.be.false;
  });
});
