const { expect } = require("chai");
const helpers = require("@nomicfoundation/hardhat-network-helpers");
const { amountFunction } = require("@ensuro/utils/js/utils");
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
      // IPolicyPool: "0x7d73446f", - Before `refactoring-rms` branch that changed Policy struct
      IPolicyPool: "0x4a19696a",
      IPolicyPoolComponent: "0x4d15eb03",
      // IRiskModule: "0xda40804f", - Up to v2.9
      IRiskModule: "0x21b7e09b",
      // IPremiumsAccount: "0xb76712ec", - Up to v2.7
      // IPremiumsAccount: "0x1ce4a652", - Up to v2.9
      // IPremiumsAccount: "0x42a0fe0b", - Before `refactoring-rms` branch that changed Policy struct
      IPremiumsAccount: "0x19fb2a71",
      ILPWhitelist: "0xf8722d89",
      IPolicyHolder: "0x3ece0a89",
    };

    const _A = amountFunction(6);

    const currency = await initCurrency({ name: "Test USDC", symbol: "USDC", decimals: 6, initial_supply: _A(10000) });
    const PolicyPool = await hre.ethers.getContractFactory("PolicyPool");

    return {
      currency,
      _A,
      owner,
      PolicyPool,
      interfaceIds,
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

  it("Checks RiskModule supported interfaces", async () => {
    const { interfaceIds, premiumsAccount, policyPool } = await helpers.loadFixture(setupFixtureWithPoolAndPA);
    const RiskModule = await hre.ethers.getContractFactory("RiskModule");
    const rm = await RiskModule.deploy(policyPool, premiumsAccount);
    expect(await rm.supportsInterface(interfaceIds.IERC165)).to.be.true;
    expect(await rm.supportsInterface(interfaceIds.IPolicyPoolComponent)).to.be.true;
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
});
