const { expect } = require("chai");
const { impersonate } = require("./test-utils");


describe("Test EToken Upgrade - run at block 31692000", function() {
  let pool;
  let USDC;
  let lp;
  const ADDRESSES = {
    usdc: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
    pool: "0xF7ED72430bEA07D8dB6eC264603811381F5af8e0",
    // adminsMultisig: "0x9F764e042D8a370131F0D148da0607EA699b2Bb3",
    adminsMultisig: "0xCfcd29CD20B6c64A4C0EB56e29E5ce3CD69336D2",
    custTreasury: "0xd01587ecd64504851e181b36153ef4d93c2bf939",
    lp: "0x2557fe0959934F3814C6ee72AB46E6687b81b8CA",
    riskModule: "0x02D158f550dd434526E0BC4a65F7DD50DDB9afEE",
    pricerAccount: "0x9dA2192C820C5cC37d26A3F97d7BcF1Bc04232A3",
    eUSD1YEAR: "0xCFfDcC8e99Aa22961704b9C7b67Ed08A66EA45Da",
    eUSDiz: "0x42d8f96A573405E4B850bAe08d75449Bd32bf7dc",
    newImpl: "0x58B0671852F4C9C4bF5Ffe2B5f2A2F99A1D7c335",
    oldImpl: "0x47f3e03b0ba95d7a2ef494156e2ea8592e24f25b",
  };
  let adminsMultisig;
  const _E = ethers.utils.parseEther;
  const _BN = ethers.BigNumber.from;

  beforeEach(async () => {
    await network.provider.request({
      method: "hardhat_reset",
      params: [
        {
          forking: {
            jsonRpcUrl: process.env.ALCHEMY_URL,
            blockNumber: 31692000,
          },
        },
      ],
    });
    USDC = await ethers.getContractAt("IERC20Metadata", ADDRESSES.usdc);
    pool = await ethers.getContractAt("PolicyPool", ADDRESSES.pool);
    eUSD1YEAR = await ethers.getContractAt("EToken", ADDRESSES.eUSD1YEAR);
    eUSDiz = await ethers.getContractAt("EToken", ADDRESSES.eUSDiz);
    adminsMultisig = await impersonate(ADDRESSES.adminsMultisig, _E("10"));
    lp = await impersonate(ADDRESSES.lp, _E("10"));
  });

  it("Should fix the totalWithdrawable error", async function() {
    let oneCent = _BN(10000);
    let scr = await eUSD1YEAR.scr();
    let totalSupply = await eUSD1YEAR.totalSupply();
    // Current version of the code - SCR locks 110% (because annual interest of 10% is also locked)
    expect(await eUSD1YEAR.totalWithdrawable()).to.closeTo(
      totalSupply.sub(scr.mul(110).div(100)), oneCent
    );
    tx = await eUSD1YEAR.connect(adminsMultisig).upgradeTo(ADDRESSES.newImpl);
    expect(await eUSD1YEAR.totalWithdrawable()).to.closeTo(totalSupply.sub(scr), oneCent);
  });

  it("Should install an upgradeable contract", async function() {
    tx = await eUSD1YEAR.connect(adminsMultisig).upgradeTo(ADDRESSES.newImpl);
    tx = await eUSD1YEAR.connect(adminsMultisig).upgradeTo(ADDRESSES.oldImpl);
  });

  it("Should be able to withdraw 20k after upgrade", async function() {
    let prevBalance = await USDC.balanceOf(lp.address);
    let usd20k = _BN(20000).mul(_BN(1e6));
    tx = await pool.connect(lp).withdraw(ADDRESSES.eUSD1YEAR, usd20k);
    let newBalance = await USDC.balanceOf(lp.address);
    expect(newBalance.gt(prevBalance));
    expect(newBalance.sub(prevBalance).toNumber()).to.be.lessThan(usd20k.toNumber());
    tx = await eUSD1YEAR.connect(adminsMultisig).upgradeTo(ADDRESSES.newImpl);
    tx = await pool.connect(lp).withdraw(ADDRESSES.eUSD1YEAR, usd20k.sub(newBalance.sub(prevBalance)));
    let newBalance2 = await USDC.balanceOf(lp.address);
    expect(newBalance2.sub(prevBalance)).to.be.equal(usd20k);
  });

});
