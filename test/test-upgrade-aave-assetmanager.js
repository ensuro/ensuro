const { expect } = require("chai");
const { DAY, WEEK, init_currency, approve_multiple, check_balances,
        now, add_risk_module, expected_change, impersonate } = require("./test-utils");


/*fit = it;
it = function() {}*/

fit = function() {};

describe("Test AaveAssetManager Upgrade - run at block 23237626", function() {
  let USDC;
  let poolConfig;
  let pool;
  let etk;
  let poolSigner;
  let AaveAssetManager;
  let assetMgr;
  const ADDRESSES = {
    usdc: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
    pool: "0xF7ED72430bEA07D8dB6eC264603811381F5af8e0",
    etk: "0xCFfDcC8e99Aa22961704b9C7b67Ed08A66EA45Da",
    assetMgr: "0x09d9Dd252659a497F3525F257e204E7192beF132",
    adminsMultisig: "0x9F764e042D8a370131F0D148da0607EA699b2Bb3",
    aave: "0xd05e3E715d945B59290df0ae8eF85c1BdB684744",  // AAVE Address Provider
    sushi: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506",  // Sushiswap router
  };
  let adminsMultisig;
  const _E = ethers.utils.parseEther;

  beforeEach(async () => {
    await network.provider.request({
      method: "hardhat_reset",
      params: [
        {
          forking: {
            jsonRpcUrl: process.env.ALCHEMY_URL,
            blockNumber: 23237626,
          },
        },
      ],
    });
    assetMgr = await ethers.getContractAt("AaveAssetManager", ADDRESSES.assetMgr);
    USDC = await ethers.getContractAt("IERC20Metadata", ADDRESSES.usdc);
    pool = await ethers.getContractAt("PolicyPool", ADDRESSES.pool);
    etk = await ethers.getContractAt("EToken", ADDRESSES.etk);
    await hre.network.provider.request(
      {method: "hardhat_impersonateAccount", params: [ADDRESSES.adminsMultisig]}
    );
    adminsMultisig = await impersonate(ADDRESSES.adminsMultisig, _E("10"));
    poolSigner = await impersonate(ADDRESSES.pool, _E("10"));
    AaveAssetManager = await ethers.getContractFactory("AaveAssetManager");
  });

  it("Should reduce gas cost after upgrade", async function() {
    const [anon] = await ethers.getSigners();
    let tx = await assetMgr.checkpoint();
    let receipt = await tx.wait();
    let initialGas = receipt.gasUsed;
    const newImpl = await AaveAssetManager.deploy(ADDRESSES.pool, ADDRESSES.aave, ADDRESSES.sushi);
    expect(await newImpl.aToken()).to.equal(await assetMgr.aToken());
    expect(await newImpl.policyPool()).to.equal(await assetMgr.policyPool());
    await expect(assetMgr.upgradeTo(newImpl.address)).to.be.reverted;
    tx = await assetMgr.connect(adminsMultisig).upgradeTo(newImpl.address);
    receipt = await tx.wait();
    // Test with the new Implementatino
    tx = await assetMgr.checkpoint();
    receipt = await tx.wait();
    console.log(`Gas Used Before: ${initialGas.toString()} / After: ${receipt.gasUsed.toString()}`);
    // At least 20% gas improvement
    expect(receipt.gasUsed.toNumber()).to.be.lessThanOrEqual(initialGas.toNumber() * 0.8);
  });

  it("Should distribute earnings in deinvestAll - no upgrade", async function() {
    const [anon] = await ethers.getSigners();
    const balanceBefore = await USDC.balanceOf(ADDRESSES.pool);
    const investmentValueBefore = await assetMgr.getInvestmentValue();
    expect(balanceBefore).to.equal(2000e6);
    const premiumsBefore = await pool.purePremiums();
    const etkMoneyBefore = await etk.totalSupply();
    await assetMgr.connect(poolSigner).deinvestAll();
    const balanceAfter = await USDC.balanceOf(ADDRESSES.pool);
    expect(balanceAfter).to.be.gte(5000e6);
    const premiumsAfter = await pool.purePremiums();
    const etkMoneyAfter = await etk.totalSupply();
    console.log(`Balance before: ${balanceBefore.toString()} after: ${balanceAfter.toString()}`);
    console.log(`Premiums: before ${premiumsBefore.toString()} after: ${premiumsAfter.toString()}`);
    console.log(`ETK: before ${etkMoneyBefore.toString()} after: ${etkMoneyAfter.toString()}`);
    expect(etkMoneyBefore).to.be.equal(etkMoneyAfter); // Unchanged - this is the bug
    expect(premiumsBefore).to.be.equal(premiumsAfter); // Not changed - this is the bug
    expect(balanceAfter - balanceBefore).not.to.be.equal(investmentValueBefore);
  });

  it("Should distribute earnings in deinvestAll", async function() {
    const [anon] = await ethers.getSigners();
    const balanceBefore = await USDC.balanceOf(ADDRESSES.pool);
    await assetMgr.checkpoint();
    const investmentValueBefore = await assetMgr.getInvestmentValue();
    expect(balanceBefore).to.equal(2000e6);
    const premiumsBefore = await pool.purePremiums();
    const etkMoneyBefore = await etk.totalSupply();
    // Change to current implementation
    const newImpl = await AaveAssetManager.deploy(ADDRESSES.pool, ADDRESSES.aave, ADDRESSES.sushi);
    tx = await assetMgr.connect(adminsMultisig).upgradeTo(newImpl.address);
    tx = await assetMgr.connect(poolSigner).deinvestAll();
    const balanceAfter = await USDC.balanceOf(ADDRESSES.pool);
    expect(balanceAfter).to.be.gt(5023957829);  // More than the other case because selling unclaimed rew
    const premiumsAfter = await pool.purePremiums();
    const etkMoneyAfter = await etk.totalSupply();
    console.log(`Balance before: ${balanceBefore.toString()} after: ${balanceAfter.toString()}`);
    console.log(`Premiums: before ${premiumsBefore.toString()} after: ${premiumsAfter.toString()}`);
    console.log(`ETK: before ${etkMoneyBefore.toString()} after: ${etkMoneyAfter.toString()}`);
    expect(etkMoneyBefore).not.to.be.equal(etkMoneyAfter);
    expect(premiumsBefore).to.be.equal(premiumsAfter); // Stays as 0
    expect(balanceAfter.sub(balanceBefore)).to.be.equal(
      investmentValueBefore.add(etkMoneyAfter).sub(etkMoneyBefore)
    );
  });

});

