const { expect } = require("chai");
const {
  initCurrency,
  deployPool,
  deployPremiumsAccount,
  addRiskModule,
  amountFunction,
  addEToken,
} = require("./test-utils");
const { ethers } = require("hardhat");

describe("Supports interface implementation", function () {
  let currency;
  let pool;
  let accessManager;
  let premiumsAccount;
  let _A;
  let owner, lp, cust, backend;
  let RiskModule;
  let rm;
  let LPManualWhitelist, wl;
  let assetManager, am;
  let PolicyPoolComponent, ppc;

  beforeEach(async () => {
    [owner, lp, cust, backend] = await ethers.getSigners();

    _A = amountFunction(6);

    currency = await initCurrency(
      { name: "Test USDC", symbol: "USDC", decimals: 6, initial_supply: _A(10000) },
      [lp, cust, backend],
      [_A(5000), _A(500), _A(1000)]
    );

    pool = await deployPool(hre, {
      currency: currency.address,
      grantRoles: ["LEVEL1_ROLE", "LEVEL2_ROLE"],
      treasuryAddress: "0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199", // Random address
    });
    pool._A = _A;

    etk = await addEToken(pool, {});

    premiumsAccount = await deployPremiumsAccount(hre, pool, { srEtkAddr: etk.address });

    accessManager = await ethers.getContractAt("AccessManager", await pool.access());

    RiskModule = await ethers.getContractFactory("RiskModuleMock");

    await currency.connect(lp).approve(pool.address, _A(5000));
    await pool.connect(lp).deposit(etk.address, _A(5000));

    rm = await addRiskModule(pool, premiumsAccount, RiskModule, {
      extraArgs: [],
    });
    await accessManager.grantComponentRole(rm.address, await rm.PRICER_ROLE(), backend.address);

    LPManualWhitelist = await hre.ethers.getContractFactory("LPManualWhitelist");
    wl = await LPManualWhitelist.deploy(pool.address);

    assetManager = await hre.ethers.getContractFactory("ERC4626AssetManager");
    am = await assetManager.deploy(etk.address, rm.address);

    PolicyPoolComponent = await ethers.getContractFactory("PolicyPoolComponentMock");
    ppc = await PolicyPoolComponent.deploy(pool.address);
  });

  it("RiskModule broken if have different interfaceId", async () => {
    // This is a test to check if the interfaceId is correct
    // > const InterfaceIdCalculator = await ethers.getContractFactory("InterfaceIdCalculator")
    // > const iidCalculator = await InterfaceIdCalculator.deploy()
    // > await iidCalculator.IRiskModule_interfaceId()
    // '0xda40804f'
    // > await iidCalculator.IERC165_interfaceId()
    // '0x01ffc9a7'

    // Supports this interface's
    const ierc165InterfaceId = "0x01ffc9a7";
    const rmInterfaceId = "0xda40804f";

    // Doesn't support this interface's
    const etknterfaceId = "0x027466bc";
    const wrongInterfaceId = "0xffffffff";

    expect(await rm.supportsInterface(wrongInterfaceId)).to.be.false;
    expect(await rm.supportsInterface(etknterfaceId)).to.be.false;

    expect(await rm.supportsInterface(rmInterfaceId)).to.be.true;
    expect(await rm.supportsInterface(ierc165InterfaceId)).to.be.true;
  });

  it("EToken broken if have different interfaceId", async () => {
    // This is a test to check if the interfaceId is correct
    // > const InterfaceIdCalculator = await ethers.getContractFactory("InterfaceIdCalculator")
    // > const iidCalculator = await InterfaceIdCalculator.deploy()
    // > await iidCalculator.IEToken_interfaceId()
    // '0x027466bc'
    // > await iidCalculator.IERC165_interfaceId()
    // '0x01ffc9a7'

    // Supports this interface's
    const ierc165InterfaceId = "0x01ffc9a7";
    const etknterfaceId = "0x027466bc";

    // Doesn't support this interface's
    const rmInterfaceId = "0xda40804f";
    const wrongInterfaceId = "0xffffffff";

    expect(await etk.supportsInterface(wrongInterfaceId)).to.be.false;
    expect(await etk.supportsInterface(rmInterfaceId)).to.be.false;

    expect(await etk.supportsInterface(etknterfaceId)).to.be.true;
    expect(await etk.supportsInterface(ierc165InterfaceId)).to.be.true;
  });

  it("PremiumsAccount broken if have different interfaceId", async () => {
    // This is a test to check if the interfaceId is correct
    // > const InterfaceIdCalculator = await ethers.getContractFactory("InterfaceIdCalculator")
    // > const iidCalculator = await InterfaceIdCalculator.deploy()
    // > await iidCalculator.IPremiumsAccount_interfaceId()
    // '0xb76712ec'
    // > await iidCalculator.IERC165_interfaceId()
    // '0x01ffc9a7'

    // Supports this interface's
    const ierc165InterfaceId = "0x01ffc9a7";
    const paInterfaceId = "0xb76712ec";

    // Doesn't support this interface's
    const etknterfaceId = "0x027466bc";
    const wrongInterfaceId = "0xffffffff";

    expect(await premiumsAccount.supportsInterface(wrongInterfaceId)).to.be.false;
    expect(await premiumsAccount.supportsInterface(etknterfaceId)).to.be.false;

    expect(await premiumsAccount.supportsInterface(paInterfaceId)).to.be.true;
    expect(await premiumsAccount.supportsInterface(ierc165InterfaceId)).to.be.true;
  });

  it("Pool broken if have different interfaceId", async () => {
    // This is a test to check if the interfaceId is correct
    // > const InterfaceIdCalculator = await ethers.getContractFactory("InterfaceIdCalculator")
    // > const iidCalculator = await InterfaceIdCalculator.deploy()
    // > await iidCalculator.IPolicyPool_interfaceId()
    // '0x4b195a48'
    // > await iidCalculator.IERC165_interfaceId()
    // '0x01ffc9a7'

    // Supports this interface's
    const ierc165InterfaceId = "0x01ffc9a7";
    const poolInterfaceId = "0x4b195a48";

    // Doesn't support this interface's
    const wrongInterfaceId = "0xffffffff";
    const rmInterfaceId = "0xda40804f";

    expect(await pool.supportsInterface(wrongInterfaceId)).to.be.false;
    expect(await pool.supportsInterface(rmInterfaceId)).to.be.false;

    expect(await pool.supportsInterface(poolInterfaceId)).to.be.true;
    expect(await pool.supportsInterface(ierc165InterfaceId)).to.be.true;
  });

  it("LPWhitelist broken if have different interfaceId", async () => {
    // This is a test to check if the interfaceId is correct
    // > const InterfaceIdCalculator = await ethers.getContractFactory("InterfaceIdCalculator")
    // > const iidCalculator = await InterfaceIdCalculator.deploy()
    // > await iidCalculator.ILPWhitelist_interfaceId()
    // '0x6823eaea'
    // > await iidCalculator.IERC165_interfaceId()
    // '0x01ffc9a7'

    // Supports this interface's
    const ierc165InterfaceId = "0x01ffc9a7";
    const whitelistInterfaceId = "0x6823eaea";

    // Doesn't support this interface's
    const etknterfaceId = "0x027466bc";
    const wrongInterfaceId = "0xffffffff";

    expect(await wl.supportsInterface(wrongInterfaceId)).to.be.false;
    expect(await wl.supportsInterface(etknterfaceId)).to.be.false;

    expect(await wl.supportsInterface(whitelistInterfaceId)).to.be.true;
    expect(await wl.supportsInterface(ierc165InterfaceId)).to.be.true;
  });

  it("AccessManager broken if have different interfaceId", async () => {
    // This is a test to check if the interfaceId is correct
    // > const InterfaceIdCalculator = await ethers.getContractFactory("InterfaceIdCalculator")
    // > const iidCalculator = await InterfaceIdCalculator.deploy()
    // > await iidCalculator.IAccessManager_interfaceId()
    // '0x272b8c47'
    // > await iidCalculator.IERC165_interfaceId()
    // '0x01ffc9a7'

    // Supports this interface's
    const ierc165InterfaceId = "0x01ffc9a7";
    const amInterfaceId = "0x272b8c47";

    // Doesn't support this interface's
    const etknterfaceId = "0x027466bc";
    const wrongInterfaceId = "0xffffffff";

    expect(await accessManager.supportsInterface(wrongInterfaceId)).to.be.false;
    expect(await accessManager.supportsInterface(etknterfaceId)).to.be.false;

    expect(await accessManager.supportsInterface(amInterfaceId)).to.be.true;
    expect(await accessManager.supportsInterface(ierc165InterfaceId)).to.be.true;
  });

  it("AssetManager broken if have different interfaceId", async () => {
    // This is a test to check if the interfaceId is correct
    // > const InterfaceIdCalculator = await ethers.getContractFactory("InterfaceIdCalculator")
    // > const iidCalculator = await InterfaceIdCalculator.deploy()
    // > await iidCalculator.IAssetManager_interfaceId()
    // '0x799c2a5c'
    // > await iidCalculator.IERC165_interfaceId()
    // '0x01ffc9a7'

    // Supports this interface's
    const ierc165InterfaceId = "0x01ffc9a7";
    const assetManagerInterfaceId = "0x799c2a5c";

    // Doesn't support this interface's
    const etknterfaceId = "0x027466bc";
    const wrongInterfaceId = "0xffffffff";

    expect(await am.supportsInterface(wrongInterfaceId)).to.be.false;
    expect(await am.supportsInterface(etknterfaceId)).to.be.false;

    expect(await am.supportsInterface(assetManagerInterfaceId)).to.be.true;
    expect(await am.supportsInterface(ierc165InterfaceId)).to.be.true;
  });

  it("Broken if ERC4626AssetManager asset have zero address", async () => {
    const zeroAddress = "0x0000000000000000000000000000000000000000";
    await expect(assetManager.deploy(zeroAddress, rm.address)).to.be.revertedWith(
      "LiquidityThresholdAssetManager: asset cannot be zero address"
    );
  });

  it("PolicyPoolComponent broken if have different interfaceId", async () => {
    // This is a test to check if the interfaceId is correct
    // > const InterfaceIdCalculator = await ethers.getContractFactory("InterfaceIdCalculator")
    // > const iidCalculator = await InterfaceIdCalculator.deploy()
    // > await iidCalculator.IPolicyPoolComponent_interfaceId()
    // '0x4cea22a4'
    // > await iidCalculator.IERC165_interfaceId()
    // '0x01ffc9a7'

    // Supports this interface's
    const ierc165InterfaceId = "0x01ffc9a7";
    const ppcInterfaceId = "0x4cea22a4";

    // Doesn't support this interface's
    const etknterfaceId = "0x027466bc";
    const wrongInterfaceId = "0xffffffff";

    expect(await ppc.supportsInterface(wrongInterfaceId)).to.be.false;
    expect(await ppc.supportsInterface(etknterfaceId)).to.be.false;

    expect(await ppc.supportsInterface(ppcInterfaceId)).to.be.true;
    expect(await ppc.supportsInterface(ierc165InterfaceId)).to.be.true;
  });
});
