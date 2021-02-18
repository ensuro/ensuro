const { expect } = require("chai");

describe("EnsuroRoulette", function() {
  let protocol;
  let roulette;
  let now;

  beforeEach(async () => {
    const Protocol = await ethers.getContractFactory("EnsuroProtocol");
    protocol = await Protocol.deploy({value: 1000});
    await protocol.deployed();
    const Roulette = await ethers.getContractFactory("EnsuroRoulette");
    roulette = await Roulette.deploy(protocol.address);
    await roulette.deployed();
    now = Math.floor(new Date().getTime() / 1000);
  });

  it("Should reject invalid policies", async function() {
    expect(await roulette.protocol()).to.equal(protocol.address);

    await expect(
      roulette.new_policy(234, 1, 36, now + 2000)
    ).to.be.revertedWith('Allowed roulette values are from 0 to 36');

    await expect(
      roulette.new_policy(3, 1, 40, now + 2000)
    ).to.be.revertedWith('Prize must be 36 times the premium');

    await expect(
      roulette.new_policy(3, 2, 72, now + 2000, {value: 0})
    ).to.be.revertedWith('You must pay the premium');

  });

  it("Should inject valid policies in the protocol and resolve in favor of customer or not", async function() {
    const [owner, cust] = await ethers.getSigners();
    await roulette.connect(cust).new_policy(17, 2, 72, now + 2000, {value: 2});
    await roulette.connect(cust).new_policy(15, 3, 108, now + 2000, {value: 3});
    // TODO: learn how to read the value from policy_id
    
    expect(await roulette.policy_count()).to.equal(2);

    expect(await roulette.get_roulette_value(1)).to.equal(17);
    expect(await roulette.get_roulette_value(2)).to.equal(15);
    expect(await protocol.mcr()).to.equal(72 + 108 - 2 - 3);

    // Swipe roulette for first policy
    expect(await roulette.swipe_roulette(1, 17)).to.changeEtherBalances(
      [cust, protocol], [72, -72]
    );
    expect(await protocol.mcr()).to.equal(108 - 3);
    expect(await protocol.ocean()).to.equal(1000 - (108 - 3) - 70);  // net loss == 70

    // Swipe roulette for 2nd policy
    expect(await roulette.swipe_roulette(2, 3)).not.to.changeEtherBalances(
      [cust, protocol]
    );
    expect(await protocol.mcr()).to.equal(0);
    expect(await protocol.ocean()).to.equal(1000 - 70 + 3);  // net loss == 67
  });

  it("Should remove from risk module expired policies", async function() {
    const [owner, cust] = await ethers.getSigners();
    await roulette.connect(cust).new_policy(32, 2, 72, now + 2000, {value: 2});
    expect(await roulette.get_roulette_value(1)).to.equal(32);
    
    await ethers.provider.send("evm_increaseTime", [2000]);
    await ethers.provider.send("evm_mine");
    await expect(protocol.expire_policy(roulette.address, 1)).not.to.be.reverted;

    expect(await protocol.ocean()).to.equal(1002);
    expect(await protocol.mcr()).to.equal(0);
    expect(await roulette.get_roulette_value(1)).to.equal(9999);
  });
});
