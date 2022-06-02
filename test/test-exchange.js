const { expect } = require("chai");
const { impersonate, deployPool } = require("./test-utils");


describe("Test Exchange contract - run at https://polygonscan.com/block/27090801", function() {
  let USDC;
  let pool;
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
  const _E = ethers.utils.parseEther;
  const _BN = ethers.BigNumber.from;

  beforeEach(async () => {
    await network.provider.request({
      method: "hardhat_reset",
      params: [
        {
          forking: {
            jsonRpcUrl: process.env.ALCHEMY_URL,
            blockNumber: 27090801,
          },
        },
      ],
    });
    USDC = await ethers.getContractAt("IERC20Metadata", ADDRESSES.usdc);
    WMATIC = await ethers.getContractAt("IERC20Metadata", ADDRESSES.wmatic);
    pool = await deployPool(hre, {currency: ADDRESSES.usdc, grantRoles: ["LEVEL1_ROLE", "LEVEL2_ROLE"]});
  });

  it("Should convert between token prices", async function() {
    const Exchange = await ethers.getContractFactory("Exchange");
    const exchange = await hre.upgrades.deployProxy(Exchange, [
      ADDRESSES.oracle,
      ADDRESSES.sushi,
      _E("0.02")
      ],
      {constructorArgs: [pool.address], kind: 'uups'}
    );
    await exchange.deployed();
    const currentPriceWMatic = 1405918;
    const currentPriceWEth = 3078699628;
    expect(
      await exchange.convert(ADDRESSES.wmatic, ADDRESSES.usdc, _E("1"))
    ).to.equal(currentPriceWMatic);
    expect(
      await exchange.convert(ADDRESSES.usdc, ADDRESSES.wmatic, currentPriceWMatic)
    ).to.closeTo(_E("1"), _E("0.0001"));
    expect(
      await exchange.convert(ADDRESSES.usdc, ADDRESSES.wmatic, currentPriceWMatic * 5)
    ).to.closeTo(_E("5"), _E("0.0001"));
    expect(
      await exchange.convert(ADDRESSES.weth, ADDRESSES.usdc, _E("1"))
    ).to.equal(currentPriceWEth);

    expect(
      await exchange.convert(ADDRESSES.weth, ADDRESSES.wmatic, _E("2"))
    ).to.closeTo(_E("4379.629"), _E("0.01"));
  });

  it("DEX price shouldn't be that far from oracle price", async function() {
    const Exchange = await ethers.getContractFactory("Exchange");
    const exchange = await hre.upgrades.deployProxy(Exchange, [
      ADDRESSES.oracle,
      ADDRESSES.sushi,
      _E("0.02")
      ],
      {constructorArgs: [pool.address], kind: 'uups'}
    );
    await exchange.deployed();
    // Oracle values in USDC
    const currentPriceWMatic = _BN(1405918);
    const currentPriceWEth = _BN(3078699628);
    expect(
      await exchange.getAmountIn(ADDRESSES.usdc, ADDRESSES.wmatic, _E("10"))
    ).to.closeTo(currentPriceWMatic.mul(_BN(10)), _BN(150000));  // $ 0.15 difference allowed
    expect(
      await exchange.getAmountIn(ADDRESSES.usdc, ADDRESSES.weth, _E("5"))
    ).to.closeTo(currentPriceWEth.mul(_BN(5)), _BN(150e6));  // $ 150 difference allowed
  });

  it("Should be able to sell with the black box call received from exchange", async function() {
    const usrUSDC = await impersonate(ADDRESSES.usrUSDC, _E("10"));
    const usrWMATIC = await impersonate(ADDRESSES.usrWMATIC, _E("10"));
    const initialBalances = {
      usrUSDC: await USDC.balanceOf(usrUSDC.address),
      usrWMATIC: await WMATIC.balanceOf(usrWMATIC.address),
    }

    const Exchange = await ethers.getContractFactory("Exchange");
    const exchange = await hre.upgrades.deployProxy(Exchange, [
      ADDRESSES.oracle,
      ADDRESSES.sushi,
      _E("0.02")
      ],
      {constructorArgs: [pool.address], kind: 'uups'}
    );

    const swapRouter = await exchange.getSwapRouter();
    expect(swapRouter).to.be.equal(ADDRESSES.sushi);

    const timestamp = (await usrUSDC.provider.getBlock("latest")).timestamp;

    // Sell 100 USDC
    let sellCall = await exchange.sell(USDC.address, WMATIC.address, _BN(100e6), usrUSDC.address,
      timestamp + 1000
    );
    await USDC.connect(usrUSDC).approve(swapRouter, _BN(250e6));
    await expect(() => usrUSDC.sendTransaction({
      to: swapRouter, data: sellCall,
    })).to.changeTokenBalance(USDC, usrUSDC, _BN(-100e6));

    // Sell 150 USDC - Destination another account
    sellCall = await exchange.sell(USDC.address, WMATIC.address, _BN(150e6), pool.address,
      timestamp + 1500
    );
    await usrUSDC.sendTransaction({
      to: swapRouter, data: sellCall,
    });

    expect(await USDC.balanceOf(usrUSDC.address)).to.be.equal(initialBalances.usrUSDC.sub(_BN(250e6)));
    expect(await WMATIC.balanceOf(pool.address)).to.be.closeTo(_E("106.69"), _E("1"));
  });
});
