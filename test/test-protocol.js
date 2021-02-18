const { expect } = require("chai");

describe("EnsuroProtocol", function() {
  let Protocol;

  beforeEach(async () => {
    Protocol = await ethers.getContractFactory("EnsuroProtocol");
  });

  it("Should create with Ether and can only be destroyed by owner", async function() {
    const [owner, addr1] = await ethers.getSigners();
    const protocol = await Protocol.deploy({value: 1000});
    expect(await protocol.ocean()).to.equal(1000); 
    expect(await protocol.mcr()).to.equal(0); 
    await expect(protocol.connect(addr1).destroy()).to.be.revertedWith('Only owner can destroy'); 
    await expect(protocol.connect(owner).destroy()).not.to.be.reverted;
  });

  it("Should accept new policies and lock capital", async function() {
    const [owner, risk_module, cust, provider] = await ethers.getSigners();

    // Create protocol and fund it with 500 wei from provider
    const protocol = await Protocol.deploy();
    expect(await protocol.ocean()).to.equal(0); 
    expect(await protocol.mcr()).to.equal(0); 
    expect(await protocol.connect(provider).invest({value: 500})).to.changeEtherBalance(protocol, 500); 
    expect(await protocol.ocean()).to.equal(500); 


    let now = Math.floor(new Date().getTime() / 1000);

    // Invalid policies should be reverted
    await expect(protocol.new_policy(1234, now - 1000, 1, 36, cust.address)).to.be.revertedWith(
      "Policy can't expire in the past"
    );
    let riskm_calls = protocol.connect(risk_module);
    await expect(riskm_calls.new_policy(1234, now + 1000, 100, 3600, cust.address)).to.be.revertedWith(
      "Not enought free capital in the pool"
    );

    // Test valid policy - should be stored
    await expect(riskm_calls.new_policy(1234, now + 1000, 10, 360, cust.address, {value: 10})).not.to.be.reverted;
    expect(await protocol.ocean()).to.equal(150); 
    expect(await protocol.mcr()).to.equal(350); 

    // Create another policy
    await expect(riskm_calls.new_policy(2222, now + 1000, 1, 100, cust.address, {value: 1})).not.to.be.reverted;
    expect(await protocol.ocean()).to.equal(51); 
    expect(await protocol.mcr()).to.equal(449); 
    expect(await protocol.pending_premiums()).to.equal(11); 

    let policy = await protocol.get_policy(risk_module.address, 1234);
    expect(policy.customer).to.equal(cust.address);
    expect(policy.prize).to.equal(360);
    expect(policy.premium).to.equal(10);

    // Expire the 1st policy
    await expect(protocol.expire_policy(risk_module.address, 1111)).to.be.revertedWith("Policy not found");
    await expect(protocol.expire_policy(risk_module.address, 1234)).to.be.revertedWith("Policy not expired yet");

    await ethers.provider.send("evm_increaseTime", [1000]);
    await ethers.provider.send("evm_mine");
    await expect(protocol.expire_policy(risk_module.address, 1234)).not.to.be.reverted;

    expect(await protocol.ocean()).to.equal(411); 
    expect(await protocol.mcr()).to.equal(99); 
    expect(await protocol.pending_premiums()).to.equal(1);

    // Resolve 2nd policy in favor of the customer
    expect(await riskm_calls.resolve_policy(2222, true)).to.changeEtherBalances(
      [cust, protocol], [100, -100]
    ); 

    expect(await protocol.ocean()).to.equal(411); 
    expect(await protocol.mcr()).to.equal(0); 
    expect(await protocol.pending_premiums()).to.equal(0);
  });

});
