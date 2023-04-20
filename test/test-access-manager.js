const { expect } = require("chai");
const hre = require("hardhat");
const helpers = require("@nomicfoundation/hardhat-network-helpers");

const { accessControlMessage, getRole, getComponentRole } = require("./test-utils");

describe("AccessManager", () => {
  let owner, backend, user;

  const someComponent = "0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199";

  beforeEach(async () => {
    [owner, backend, user] = await hre.ethers.getSigners();
  });

  it("Allows roleAdmin to grant component roles", async () => {
    const { accessManager } = await helpers.loadFixture(accessManagerFixture);

    await expect(
      accessManager.connect(backend).grantComponentRole(someComponent, getRole("SOME_ROLE"), user.address)
    ).to.be.revertedWith("AccessControl: msg.sender needs roleAdmin or componentRoleAdmin");

    await accessManager.grantRole(getRole("DEFAULT_ADMIN_ROLE"), backend.address);

    await accessManager.connect(backend).grantComponentRole(someComponent, getRole("SOME_ROLE"), user.address);

    expect(await accessManager.hasComponentRole(someComponent, getRole("SOME_ROLE"), user.address, false)).to.equal(
      true
    );
  });

  it("Allows component-specific default roleAdmin to grant component roles", async () => {
    const { accessManager } = await helpers.loadFixture(accessManagerFixture);

    await expect(
      accessManager.connect(backend).grantComponentRole(someComponent, getRole("SOME_ROLE"), user.address)
    ).to.be.revertedWith("AccessControl: msg.sender needs roleAdmin or componentRoleAdmin");

    await accessManager.grantComponentDefaultRoleAdmin(someComponent, backend.address);

    await accessManager.connect(backend).grantComponentRole(someComponent, getRole("SOME_ROLE"), user.address);

    expect(await accessManager.hasComponentRole(someComponent, getRole("SOME_ROLE"), user.address, false)).to.equal(
      true
    );
  });

  it("Does not override explicit role admin with component default role admin", async () => {
    // TODO: This test does not make sense if we don't provide a "setRoleAdmin" method. Same goes for the check on the contract itself.
    const { accessManager } = await helpers.loadFixture(accessManagerFixture);

    // Role admin for SOME_ROLE is not DEFAULT_ROLE_ADMIN
    await accessManager.setRoleAdmin(getComponentRole(someComponent, "SOME_ROLE"), getRole("SOME_ROLE_ADMIN"));

    expect(await accessManager.hasComponentRole(someComponent, getRole("SOME_ROLE"), user.address, true)).to.equal(
      false
    );
    expect(
      await accessManager.hasComponentRole(someComponent, getRole("SOME_ROLE_ADMIN"), backend.address, true)
    ).to.equal(false);

    // DEFAULT_ADMIN_ROLE cannot grant SOME_ROLE
    expect(await accessManager.hasRole(getRole("DEFAULT_ADMIN_ROLE"), owner.address)).to.equal(true);
    await expect(
      accessManager.connect(owner).grantComponentRole(someComponent, getRole("SOME_ROLE"), user.address)
    ).to.be.revertedWith("AccessControl: msg.sender needs roleAdmin or componentRoleAdmin");

    // Component default role admin cannot grant SOME_ROLE
    await accessManager.grantComponentDefaultRoleAdmin(someComponent, backend.address);
    await expect(
      accessManager.connect(backend).grantComponentRole(someComponent, getRole("SOME_ROLE"), user.address)
    ).to.be.revertedWith("AccessControl: msg.sender needs roleAdmin or componentRoleAdmin");

    // SOME_ROLE_ADMIN can grant SOME_ROLE
    await accessManager.grantRole(getRole("SOME_ROLE_ADMIN"), backend.address);
    await accessManager.connect(backend).grantComponentRole(someComponent, getRole("SOME_ROLE"), user.address);
  });

  it("Does not allow for collisions between component roles and global roles", async () => {
    const { accessManager } = await helpers.loadFixture(accessManagerFixture);

    // given a standalone role
    const role = getRole("GUARDIAN_ROLE"); // 0x55435dd261a4b9b3364963f7738a7a662ad9c84396d64be3365284bb7f0a5041

    // and a component
    const component = someComponent;

    // we grant backend component-default-role-admin for this component
    await accessManager.grantComponentDefaultRoleAdmin(component, backend.address);

    // backend can now grant roles on this component
    await accessManager.connect(backend).grantComponentRole(component, getRole("SOME_ROLE"), user.address);

    expect(await accessManager.hasComponentRole(component, getRole("SOME_ROLE"), user.address, false)).to.be.true;

    // backend cannot grant global GUARDIAN_ROLE to users by abusing grantComponentRole?
    expect(await accessManager.hasRole(getRole("GUARDIAN_ROLE"), user.address)).to.be.false;
    const collisionRole = getComponentRole(component, role); // Such that: collisionRole ^ component == role
    await accessManager.connect(backend).grantComponentRole(component, collisionRole, user.address);
    expect(await accessManager.hasRole(role, user.address)).to.be.false;

    // but the component role was still granted
    expect(await accessManager.hasComponentRole(component, role, user.address, false)).to.be.true;
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

    // Now the checks pass
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
