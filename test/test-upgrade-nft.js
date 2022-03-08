const { expect } = require("chai");
const { DAY, WEEK, init_currency, approve_multiple, check_balances,
        now, add_risk_module, expected_change, impersonate } = require("./test-utils");


/*fit = it;
it = function() {}*/

fit = function() {};

describe("Test PolicyNFT Upgrade - run at block 25737706", function() {
  let USDC;
  let pool;
  let poolSigner;
  let PolicyNFT;
  let PolicyNFTv1_Upgrade;
  let PolicyNFTv1;
  let nft;
  const ADDRESSES = {
    usdc: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
    pool: "0xF7ED72430bEA07D8dB6eC264603811381F5af8e0",
    // adminsMultisig: "0x9F764e042D8a370131F0D148da0607EA699b2Bb3",
    adminsMultisig: "0xCfcd29CD20B6c64A4C0EB56e29E5ce3CD69336D2",
    custTreasury: "0xd01587ecd64504851e181b36153ef4d93c2bf939",
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
            blockNumber: 25737706,
          },
        },
      ],
    });
    pool = await ethers.getContractAt("PolicyPool", ADDRESSES.pool);
    nft = await ethers.getContractAt("PolicyNFTv1", await pool.policyNFT());
    USDC = await ethers.getContractAt("IERC20Metadata", ADDRESSES.usdc);
    await hre.network.provider.request(
      {method: "hardhat_impersonateAccount", params: [ADDRESSES.adminsMultisig]}
    );
    adminsMultisig = await impersonate(ADDRESSES.adminsMultisig, _E("10"));
    poolSigner = await impersonate(ADDRESSES.pool, _E("10"));
    PolicyNFT = await ethers.getContractFactory("PolicyNFT");
    PolicyNFTv1 = await ethers.getContractFactory("PolicyNFTv1");
    PolicyNFTv1_Upgrade = await ethers.getContractFactory("PolicyNFTv1_Upgrade");
  });

  it("Should fail with the new contract", async function() {
    const newImpl = await PolicyNFT.deploy();
    await expect(nft.upgradeTo(newImpl.address)).to.be.reverted;
  });

  it("Should be able to upgrade and keep policyPool unchanged", async function() {
    const newImpl = await PolicyNFTv1_Upgrade.deploy();
    tx = await nft.connect(adminsMultisig).upgradeTo(newImpl.address);
    nft = await ethers.getContractAt("PolicyNFTv1_Upgrade", nft.address);
    expect(await nft.name()).to.equal("Ensuro Policies NFT");
    expect(await nft.symbol()).to.equal("EPOL");
    expect(await nft.policyPool()).to.equal(ADDRESSES.pool);
    expect(await nft.balanceOf(ADDRESSES.custTreasury)).to.equal(704);
    await expect(
      nft.connect(poolSigner).functions["safeMint(address,uint256)"](ADDRESSES.custTreasury, 1111)
    ).not.to.be.reverted;
    expect(await nft.balanceOf(ADDRESSES.custTreasury)).to.equal(705);
    // New version rejects safeMint calls without policyId
    await expect(
      nft.connect(poolSigner).functions["safeMint(address)"](ADDRESSES.custTreasury)
    ).to.be.reverted;
    await expect(
      nft.connect(poolSigner).functions["safeMint(address,uint256)"](ADDRESSES.custTreasury, 567)
    ).to.be.revertedWith("ERC721: token already minted");
  });
});
