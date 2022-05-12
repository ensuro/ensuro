const { expect } = require("chai");
const { impersonate, deployPool, _E, _W, _R, addRiskModule,
        addEToken, amountFunction, getTransactionEvent } = require("./test-utils");


describe("Test AaveHodlerVault contract - run at https://polygonscan.com/block/28165780", function() {
  let USDC;
  let pool;
  let priceRM;
  let PriceRiskModule;
  let EnsuroLPAaveHodlerVault;
  let usrUSDC;
  let usrWMATIC;
  let _A;

  const ADDRESSES = {
    usdc: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
    wmatic: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
    weth: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
    etk: "0xCFfDcC8e99Aa22961704b9C7b67Ed08A66EA45Da",
    aave: "0xd05e3E715d945B59290df0ae8eF85c1BdB684744",  // AAVE Address Provider
    oracle: "0x0229f777b0fab107f9591a41d5f02e4e98db6f2d",  // AAVE PriceOracle
    sushi: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506",  // Sushiswap router
    assetMgr: "0x09d9Dd252659a497F3525F257e204E7192beF132",
    usrUSDC: "0x4d97dcd97ec945f40cf65f87097ace5ea0476045", // Random account with lot of USDC
    usrWMATIC: "0x55FF76BFFC3Cdd9D5FdbBC2ece4528ECcE45047e", // Random account with log of WMATIC
  };
  const _BN = ethers.BigNumber.from;

  beforeEach(async () => {
    await network.provider.request({
      method: "hardhat_reset",
      params: [
        {
          forking: {
            jsonRpcUrl: process.env.ALCHEMY_URL,
            blockNumber: 28165780,
          },
        },
      ],
    });
    USDC = await ethers.getContractAt("IERC20Metadata", ADDRESSES.usdc);
    WMATIC = await ethers.getContractAt("IERC20Metadata", ADDRESSES.wmatic);
    pool = await deployPool(hre, {currency: ADDRESSES.usdc, grantRoles: ["LEVEL1_ROLE", "LEVEL2_ROLE"]});
    pool._A = _A = amountFunction(6);

    usrUSDC = await impersonate(ADDRESSES.usrUSDC, _E("10"));
    usrWMATIC = await impersonate(ADDRESSES.usrWMATIC, _E("10"));

    const Exchange = await ethers.getContractFactory("Exchange");
    const exchange = await hre.upgrades.deployProxy(Exchange, [
      ADDRESSES.oracle,
      ADDRESSES.sushi,
      _E("0.02")
      ],
      {constructorArgs: [pool.address], kind: 'uups'}
    );
    await exchange.deployed();

    let poolConfig = await ethers.getContractAt("PolicyPoolConfig", await pool.config());
    await poolConfig.setExchange(exchange.address);

    PriceRiskModule = await ethers.getContractFactory("PriceRiskModule");
    priceRM = await addRiskModule(pool, PriceRiskModule, {
      extraConstructorArgs: [WMATIC.address, USDC.address, _W("0.01")],
    });

    EnsuroLPAaveHodlerVault = await ethers.getContractFactory("EnsuroLPAaveHodlerVault", usrWMATIC);

    etk = await addEToken(pool, {});
    await USDC.connect(usrUSDC).approve(pool.address, _A(10000));
    await pool.connect(usrUSDC).deposit(etk.address, _A(10000));
  });

  it("Should deposit into AAVE and withdraw", async function() {
    const vault = await hre.upgrades.deployProxy(EnsuroLPAaveHodlerVault, [
      [_W("1.02"), _W("1.10"), _W("1.2"), _W("1.3"), 24 * 3600],
      etk.address
    ], {
      kind: 'uups',
      unsafeAllow: ["delegatecall"],
      constructorArgs: [priceRM.address, ADDRESSES.aave]
    });

    await WMATIC.connect(usrWMATIC).approve(vault.address, _W(100));

    const startBalance = await WMATIC.balanceOf(usrWMATIC.address);
    await vault.connect(usrWMATIC).depositCollateral(_W(100), false);

    await hre.network.provider.request(
      {method: "evm_increaseTime", params: [365 * 24 * 3600]}
    );

    await hre.network.provider.request(
      {method: "evm_mine", params: []}
    );

    await vault.connect(usrWMATIC).withdrawAll();

    const endBalance = await WMATIC.balanceOf(usrWMATIC.address);
    console.log(endBalance.sub(startBalance))

    // Around 2.51% interest
    expect(endBalance.sub(startBalance)).to.closeTo(_W(2.51), _W(0.01));
   });

});
