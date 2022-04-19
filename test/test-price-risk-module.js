const { expect } = require("chai");
const { initCurrency, deployPool, _E, _W, _R, addRiskModule,
        amountFunction, grantRole, addEToken } = require("./test-utils");


describe("Test PriceRiskModule contract", function() {
  let currency;
  let wmatic;
  let pool;
  let priceOracle;
  let PriceRiskModule;
  let owner, lp, cust;
  let _A;
  let etk;

  beforeEach(async () => {
    [owner, lp, cust] = await ethers.getSigners();

    _A = amountFunction(6);

    currency = await initCurrency(
      {name: "Test USDC", symbol: "USDC", decimals: 6, initial_supply: _A(10000)},
      [lp, cust], [_A(5000), _A(500)]
    );

    wmatic = await initCurrency(
      {name: "Test WETH", symbol: "WETH", decimals: 18, initial_supply: _E("1000")},
    );

    pool = await deployPool(hre, {currency: currency.address, grantRoles: ["LEVEL1_ROLE", "LEVEL2_ROLE"]});
    pool._A = _A;

    const PriceOracle = await ethers.getContractFactory("PriceOracle");
    priceOracle = await PriceOracle.deploy();
    const Exchange = await ethers.getContractFactory("Exchange");
    const exchange = await hre.upgrades.deployProxy(Exchange, [
      priceOracle.address,
      ethers.constants.AddressZero,
      _E("0.02")
      ],
      {constructorArgs: [pool.address], kind: 'uups'}
    );
    let poolConfig = await ethers.getContractAt("PolicyPoolConfig", await pool.config());
    await poolConfig.setExchange(exchange.address);

    PriceRiskModule = await ethers.getContractFactory("PriceRiskModule");

    etk = await addEToken(pool, {});
    await currency.connect(lp).approve(pool.address, _A(5000));
    await pool.connect(lp).deposit(etk.address, _A(5000));
  });

  function _makeArray(n, initialValue) {
    const ret = new Array(n);
    for (i=0; i < n; i++) {
      ret[i] = initialValue;
    }
    return ret;
  }

  it("Should reject if prices not defined", async function() {
    const rm = await addRiskModule(pool, PriceRiskModule, {
      extraConstructorArgs: [wmatic.address, currency.address, _W("0.01")],
    });

    const start = (await owner.provider.getBlock("latest")).timestamp;
    await expect(
      rm.pricePolicy(_A(100), true, _A(1000), start + 3600)
    ).to.be.revertedWith("Division by zero");

    await priceOracle.setAssetPrice(currency.address, _E("0.000333333")); // 1 ETH = 3000 USDC

    await expect(
      rm.pricePolicy(_A(100), true, _A(1000), start + 3600)
    ).to.be.revertedWith("Price not available");

    await priceOracle.setAssetPrice(wmatic.address, _E("0.0005")); // 1 ETH = 2000 WMATIC

    await expect(
      rm.pricePolicy(_A(2), true, _A(1000), start + 3600)
    ).to.be.revertedWith("Price already under trigger value");

    await expect(
      rm.pricePolicy(_A(1), false, _A(1000), start + 3600)
    ).to.be.revertedWith("Price already above trigger value");

    await expect(
      rm.pricePolicy(_A(1.1), true, _A(1000), start + 3600)
    ).to.be.revertedWith("Duration or up/down not supported!");

    grantRole(hre, rm, "PRICER_ROLE", owner.address);

    const priceSlots = await rm.PRICE_SLOTS();

    console.log(priceSlots);
    const cdf = _makeArray(priceSlots, 0);

    cdf[0] = _R("0.1");
    cdf[priceSlots - 1] = _R("0.1");
    await rm.connect(owner).setCDF(1, cdf);

    await expect(
      rm.pricePolicy(_A(1.1), true, _A(1000), start + 3600)
    ).to.be.revertedWith("Price variation not supported");

    const [premium, lossProb] = await rm.pricePolicy(_A(0.8), true, _A(1000), start + 3600);
    expect(lossProb).to.be.equal(_R("0.1"));

    expect(await rm.getMinimumPremium(_A(1000), lossProb, start + 3600)).to.be.equal(premium);
  });

  it("Should reject if prices not defined", async function() {
  });
});
