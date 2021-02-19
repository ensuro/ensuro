const { expect } = require("chai");

describe("EnsuroProtocol", function() {
  let Protocol;
  let currency;

  beforeEach(async () => {
    Currency = await ethers.getContractFactory("TestCurrency");
    currency = await Currency.deploy(2000);
    Protocol = await ethers.getContractFactory("EnsuroProtocol");
  });

  it("Should be created with currency and invest and can only be destroyed by owner", async function() {
    const [owner, addr1] = await ethers.getSigners();
    const protocol = await Protocol.deploy(currency.address);
    expect(await protocol.ocean_available()).to.equal(0); 
    expect(await protocol.mcr()).to.equal(0); 
    await expect(protocol.connect(addr1).destroy()).to.be.revertedWith('Only owner can destroy'); 
    await expect(protocol.connect(owner).destroy()).not.to.be.reverted;
  });

  it("Should accept new policies and lock capital", async function() {
    const [owner, risk_module, cust, provider] = await ethers.getSigners();

    expect(await currency.balanceOf(owner.address)).to.equal(2000);

    // Create protocol and fund it with 500 wei from provider
    const protocol = await Protocol.deploy(currency.address);
    expect(await protocol.ocean_available()).to.equal(0); 
    expect(await protocol.mcr()).to.equal(0);

    // Fund the provider and authorize 500 from provider to protocol
    await currency.transfer(provider.address, 500);
    await currency.connect(provider).approve(protocol.address, 500);
    expect(await currency.balanceOf(owner.address)).to.equal(1500);
    expect(await currency.allowance(provider.address, protocol.address)).to.equal(500);

    await expect(() => protocol.connect(provider).invest(500)).to.changeTokenBalances(
      currency, [protocol, provider], [500, -500]
    ); 
    expect(await protocol.ocean_available()).to.equal(500); 

    await expect(protocol.add_risk_module(risk_module.address, 1)).not.to.be.reverted;
    
    const riskm_status = await protocol.get_risk_module_status(risk_module.address);
    expect(riskm_status.smart_contract).to.equal(risk_module.address);
    expect(riskm_status.status).to.equal(1);

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
    // Fund the customer and authorize 10 from customer to protocol
    await currency.transfer(cust.address, 11);
    await currency.connect(cust).approve(protocol.address, 10);

    await expect(riskm_calls.new_policy(1234, now + 1000, 10, 360, cust.address)).not.to.be.reverted;
    expect(await protocol.ocean_available()).to.equal(150); 
    expect(await protocol.mcr()).to.equal(350); 

    // Create another policy
    expect(await currency.allowance(cust.address, protocol.address)).to.equal(0);
    await expect(riskm_calls.new_policy(2222, now + 1000, 1, 100, cust.address)).to.be.reverted;
    // Aprove allowance and it should work
    await currency.connect(cust).approve(protocol.address, 1);
    await expect(riskm_calls.new_policy(2222, now + 1000, 1, 100, cust.address)).not.to.be.reverted;
    expect(await currency.balanceOf(protocol.address)).to.equal(51+11+449);
    expect(await currency.balanceOf(cust.address)).to.equal(0);
    expect(await protocol.ocean_available()).to.equal(51); 
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

    expect(await protocol.ocean_available()).to.equal(411); 
    expect(await protocol.mcr()).to.equal(99); 
    expect(await protocol.pending_premiums()).to.equal(1);

    // Resolve 2nd policy in favor of the customer
    await expect(() => riskm_calls.resolve_policy(2222, true)).to.changeTokenBalances(
      currency, [protocol, cust], [-100, 100]
    );

    expect(await protocol.ocean_available()).to.equal(411); 
    expect(await protocol.mcr()).to.equal(0); 
    expect(await protocol.pending_premiums()).to.equal(0);
  });

});
