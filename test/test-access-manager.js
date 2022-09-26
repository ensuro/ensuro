const { expect } = require("chai");
const hre = require("hardhat");
const helpers = require("@nomicfoundation/hardhat-network-helpers");

const { accessControlMessage, getRole } = require("./test-utils");

describe("AccessManager", () => {
  let owner, backend, user;

  const someComponent = "0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199";

  beforeEach(async () => {
    [owner, backend, user] = await hre.ethers.getSigners();
  });

  it("Only allows roleAdmin to grant component roles", async () => {
    const { accessManager } = await helpers.loadFixture(accessManagerFixture);

    await expect(
      accessManager.connect(backend).grantComponentRole(someComponent, getRole("SOME_ROLE"), user.address)
    ).to.be.revertedWith(accessControlMessage(backend.address, null, "DEFAULT_ADMIN_ROLE"));

    await accessManager.grantRole(getRole("DEFAULT_ADMIN_ROLE"), backend.address);

    await accessManager.connect(backend).grantComponentRole(someComponent, getRole("SOME_ROLE"), user.address);

    expect(await accessManager.hasComponentRole(someComponent, getRole("SOME_ROLE"), user.address, false)).to.equal(
      true
    );
  });

  it("Checks global roles only when asked to", async () => {
    const { accessManager } = await helpers.loadFixture(accessManagerFixture);

    expect(await accessManager.hasComponentRole(someComponent, getRole("SOME_ROLE"), user.address, true)).to.equal(
      false
    );

    // Grant a global role
    await accessManager.grantRole(getRole("SOME_ROLE"), user.address);

    // The user has the role globally
    expect(await accessManager.hasComponentRole(someComponent, getRole("SOME_ROLE"), user.address, true)).to.equal(
      true
    );
    await expect(accessManager.checkComponentRole(someComponent, getRole("SOME_ROLE"), user.address, true)).not.to.be
      .reverted;
    await expect(
      accessManager.checkComponentRole2(
        someComponent,
        getRole("SOME_ROLE"),
        getRole("SOME_OTHER_ROLE"),
        user.address,
        true
      )
    ).not.to.be.reverted;

    // The user does not have the role "locally"
    expect(await accessManager.hasComponentRole(someComponent, getRole("SOME_ROLE"), user.address, false)).to.equal(
      false
    );
    await expect(accessManager.checkComponentRole(someComponent, getRole("SOME_ROLE"), user.address, false)).to.be
      .reverted;
    await expect(
      accessManager.checkComponentRole2(
        someComponent,
        getRole("SOME_ROLE"),
        getRole("SOME_OTHER_ROLE"),
        user.address,
        false
      )
    ).to.be.reverted;

    // Grant another role locally
    await accessManager.grantComponentRole(someComponent, getRole("SOME_OTHER_ROLE"), user.address);

    // No the checks pass
    expect(
      await accessManager.hasComponentRole(someComponent, getRole("SOME_OTHER_ROLE"), user.address, false)
    ).to.equal(true);
    await expect(accessManager.checkComponentRole(someComponent, getRole("SOME_OTHER_ROLE"), user.address, false)).not
      .to.be.reverted;
    await expect(
      accessManager.checkComponentRole2(
        someComponent,
        getRole("SOME_OTHER_ROLE"),
        getRole("YET_ANOTHER_ROLE"),
        user.address,
        false
      )
    ).not.to.be.reverted;
  });

  async function accessManagerFixture() {
    const AccessManager = await hre.ethers.getContractFactory("AccessManager");
    const accessManager = await hre.upgrades.deployProxy(AccessManager, [], { kind: "uups" });

    return { AccessManager, accessManager };
  }
});
