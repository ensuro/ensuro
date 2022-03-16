const { expect } = require("chai");
const { impersonate, getTransactionEvent } = require("./test-utils");


describe("Test PolicyNFT Upgrade - run at block 25737706", function() {
  let pool;
  let poolSigner;
  let pricerSigner;
  let PolicyNFT;
  let PolicyNFTv1_Upgrade;
  let nft;
  let rm;
  const ADDRESSES = {
    usdc: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
    pool: "0xF7ED72430bEA07D8dB6eC264603811381F5af8e0",
    // adminsMultisig: "0x9F764e042D8a370131F0D148da0607EA699b2Bb3",
    adminsMultisig: "0xCfcd29CD20B6c64A4C0EB56e29E5ce3CD69336D2",
    custTreasury: "0xd01587ecd64504851e181b36153ef4d93c2bf939",
    riskModule: "0x02D158f550dd434526E0BC4a65F7DD50DDB9afEE",
    pricerAccount: "0x9dA2192C820C5cC37d26A3F97d7BcF1Bc04232A3",
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
            blockNumber: 25737706,
          },
        },
      ],
    });
    pool = await ethers.getContractAt("PolicyPool", ADDRESSES.pool);
    nft = await ethers.getContractAt("PolicyNFTv1", await pool.policyNFT());
    rm = await ethers.getContractAt("TrustfulRiskModule", ADDRESSES.riskModule);
    adminsMultisig = await impersonate(ADDRESSES.adminsMultisig, _E("10"));
    poolSigner = await impersonate(ADDRESSES.pool, _E("10"));
    pricerSigner = await impersonate(ADDRESSES.pricerAccount, _E("10"));
    PolicyNFT = await ethers.getContractFactory("PolicyNFT");
    PolicyNFTv1_Upgrade = await ethers.getContractFactory("PolicyNFTv1_Upgrade");
    PolicyPool = await ethers.getContractFactory("PolicyPool");
    TrustfulRiskModule = await ethers.getContractFactory("TrustfulRiskModule");
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

  const deployUpgrade = async function () {
    // Deploy and upgrade new PolicyPool implementation
    const purePremiums = await pool.purePremiums();
    const newPoolImpl = await PolicyPool.deploy(
      await pool.config(),
      await pool.policyNFT(),
      await pool.currency(),
    );
    await expect(pool.upgradeTo(newPoolImpl.address)).to.be.reverted;
    tx = await pool.connect(adminsMultisig).upgradeTo(newPoolImpl.address);
    expect(await pool.purePremiums()).to.equal(purePremiums);  // Pure Premiums didn't changed

    // Deploy and upgrade new PolicyNFT implementation
    const newNFTImpl = await PolicyNFTv1_Upgrade.deploy();
    await nft.connect(adminsMultisig).upgradeTo(newNFTImpl.address);
    nft = await ethers.getContractAt("PolicyNFTv1_Upgrade", nft.address);
    expect(await nft.policyPool()).to.equal(ADDRESSES.pool);

    // Deploy and upgrade new RiskModule implementation
    const totalScr = await rm.totalScr();
    const newRMImpl = await TrustfulRiskModule.deploy(pool.address);
    await expect(rm.upgradeTo(newRMImpl.address)).to.be.reverted;
    tx = await rm.connect(adminsMultisig).upgradeTo(newRMImpl.address);
    expect(await rm.policyPool()).to.equal(ADDRESSES.pool);
    expect(await rm.totalScr()).to.equal(totalScr);
    return {nft, rm, pool};
  };

  it("Should upgrade all the different components", async function() {
    await deployUpgrade();
  });

  it("Should keep working fine after upgrade", async function() {
    await hre.network.provider.send("evm_setNextBlockTimestamp", [1646819462]);
    const {rm, pool} = await deployUpgrade();
    // Replicate a TX with the new contracts
    // only the policyId should change
    // https://polygonscan.com/tx/0xb8dbd94fa849a81910fb1f8fd855774ffe52f04901dddd188736093bf11849ab
    let tx = await rm.connect(pricerSigner).newPolicy(
      "0x0000000000000000000000000000000000000000000000000000000040927ec8",
      "0x00000000000000000000000000000000000000000000000000000000094671b5",
      "0x00000000000000000000000000000000000000000056da9d67d20d7709000000",
      "0x0000000000000000000000000000000000000000000000000000000062497aac",
      "0xd01587ecd64504851e181b36153ef4d93c2bf939",
      1234
    );
    let receipt = await tx.wait();
    const newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");
    expect(newPolicyEvt.args.policy.id).to.equal(ADDRESSES.riskModule + "0000000000000000000004d2");
    // 0000000000000000000004d2 == 1234 as 96 bit hex
    expect(newPolicyEvt.args.policy.payout).to.equal("0x40927ec8");
    expect(newPolicyEvt.args.policy.premium).to.equal("0x94671b5");
    expect(newPolicyEvt.args.policy.scr).to.equal("0x0ecc1fdc");
    expect(newPolicyEvt.args.policy.lossProb).to.equal("0x56da9d67d20d7709000000");
    expect(newPolicyEvt.args.policy.purePremium).to.equal("0x08b66088");
    expect(newPolicyEvt.args.policy.premiumForEnsuro).to.equal("0x05d3ad2");
    // Minimal differences allowed in premiumForRm and premiumForLps
    expect(
      newPolicyEvt.args.policy.premiumForRm.sub(_BN("0x18da35")).abs().lte(_BN("0xf"))
    ).to.be.true;
    expect(
      newPolicyEvt.args.policy.premiumForLps.sub(_BN("0x19fc26")).abs().lte(_BN("0xf"))
    ).to.be.true;
    expect(newPolicyEvt.args.policy.riskModule).to.equal(ADDRESSES.riskModule);
    expect(newPolicyEvt.args.policy.expiration).to.equal(1648982700);

    // Resolve a Policy - Replicate this TX
    // https://polygonscan.com/tx/0xe9450e2c2a8d27e1d8171c8d6ef3bcea1125afeb8e5e3d5cbf809d25fa2d3d92
    await hre.network.provider.send("evm_setNextBlockTimestamp", [1647279960]);

    tx = await rm.connect(pricerSigner).resolvePolicy(
      [
        "0x217",  // 535
        "0x000000000000000000000000000000000000000000000000000000001226b6a6",
        "0x00000000000000000000000000000000000000000000000000000000029ec6f4",
        "0x0000000000000000000000000000000000000000000000000000000004258483",
        "0x00000000000000000000000000000000000000000056da9d67d20d7709000000",
        "0x000000000000000000000000000000000000000000000000000000000272f533",
        "0x00000000000000000000000000000000000000000000000000000000001a34f3",
        "0x0000000000000000000000000000000000000000000000000000000000070aac",
        "0x00000000000000000000000000000000000000000000000000000000000a9222",
        ADDRESSES.riskModule,
        "0x00000000000000000000000000000000000000000000000000000000621394ec",
        "0x0000000000000000000000000000000000000000000000000000000062438034",
      ],
      "0x1193fe0d"
    );
    receipt = await tx.wait();
    const resolvePolicyEvt = getTransactionEvent(pool.interface, receipt, "PolicyResolved");
    expect(resolvePolicyEvt.args.payout).to.equal("0x1193fe0d");
    expect(resolvePolicyEvt.args.policyId).to.equal(535);

    await hre.network.provider.send("evm_setNextBlockTimestamp", [1648982700 + 1]);

    // Expire the policy created above
    tx = await pool.expirePolicy(newPolicyEvt.args.policy);
    receipt = await tx.wait();
    const expirePolicyEvt = getTransactionEvent(pool.interface, receipt, "PolicyResolved");
    expect(expirePolicyEvt.args.payout).to.equal(0);
    expect(expirePolicyEvt.args.policyId).to.equal(ADDRESSES.riskModule + "0000000000000000000004d2");
  });
});
