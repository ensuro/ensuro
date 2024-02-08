const { expect } = require("chai");
const hre = require("hardhat");
const helpers = require("@nomicfoundation/hardhat-network-helpers");

const { getRole, getComponentRole, accessControlMessage } = require("../js/utils");

describe("AccessManager", () => {
  let backend, signers, user;

  const someComponent = "0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199";

  beforeEach(async () => {
    [, backend, user, ...signers] = await hre.ethers.getSigners();
  });

  it("Allows DEFAULT_ADMIN_ROLE to grant component roles by default", async () => {
    const { accessManager } = await helpers.loadFixture(accessManagerFixture);

    await expect(
      accessManager.connect(backend).grantComponentRole(someComponent, getRole("SOME_ROLE"), user.address)
    ).to.be.revertedWith("AccessManager: msg.sender needs componentRoleAdmin");

    await accessManager.grantRole(getRole("DEFAULT_ADMIN_ROLE"), backend.address);

    await accessManager.connect(backend).grantComponentRole(someComponent, getRole("SOME_ROLE"), user.address);

    expect(await accessManager.hasComponentRole(someComponent, getRole("SOME_ROLE"), user.address, false)).to.equal(
      true
    );
  });

  it("Allows componentRoleAdmin to grant component roles", async () => {
    const { accessManager } = await helpers.loadFixture(accessManagerFixture);

    await expect(
      accessManager.connect(backend).grantComponentRole(someComponent, getRole("SOME_ROLE"), user.address)
    ).to.be.revertedWith("AccessManager: msg.sender needs componentRoleAdmin");

    // we define an admin role for componentRole SOME_ROLE and grant it to backend
    await accessManager.setComponentRoleAdmin(
      await accessManager.ANY_COMPONENT(),
      getRole("SOME_ROLE"),
      getRole("SOME_ROLE_ADMIN_ROLE")
    );
    await accessManager.grantRole(getRole("SOME_ROLE_ADMIN_ROLE"), backend.address);

    // backend can now grant the component role
    await accessManager.connect(backend).grantComponentRole(someComponent, getRole("SOME_ROLE"), user.address);
    expect(await accessManager.hasComponentRole(someComponent, getRole("SOME_ROLE"), user.address, false)).to.equal(
      true
    );

    // backend cannot grant the role globally
    await expect(accessManager.connect(backend).grantRole(getRole("SOME_ROLE"), user.address)).to.be.revertedWith(
      accessControlMessage(backend.address, null, "DEFAULT_ADMIN_ROLE")
    );
  });

  it("Gives precedence to the component-specific admin over ANY_COMPONENT admin", async () => {
    const { accessManager } = await helpers.loadFixture(accessManagerFixture);

    // Given a component role "SOME_ROLE"
    const SOME_ROLE = getRole("SOME_ROLE");

    // "SOME_ROLE_ADMIN" is the admin for the role on ANY_COMPONENT
    const SOME_ROLE_ADMIN = getRole("SOME_ROLE_ADMIN");
    await accessManager.setComponentRoleAdmin(await accessManager.ANY_COMPONENT(), SOME_ROLE, SOME_ROLE_ADMIN);
    await accessManager.grantRole(SOME_ROLE_ADMIN, backend.address);

    // "SOME_ROLE_AT_SOME_COMPONENT_ADMIN" is the admin for the role on a specific component
    const SOME_ROLE_AT_SOME_COMPONENT_ADMIN = getRole("SOME_ROLE_AT_SOME_COMPONENT_ADMIN");
    await accessManager
      .connect(backend)
      .setComponentRoleAdmin(someComponent, SOME_ROLE, SOME_ROLE_AT_SOME_COMPONENT_ADMIN);
    await accessManager.grantRole(SOME_ROLE_AT_SOME_COMPONENT_ADMIN, user.address);

    // component-specific admin can grant the role for someComponent but not for others
    await expect(accessManager.connect(user).grantComponentRole(someComponent, SOME_ROLE, signers[0].address))
      .to.emit(accessManager, "RoleGranted")
      .withArgs(getComponentRole(someComponent, SOME_ROLE), signers[0].address, user.address);

    const anotherComponent = "0xc1c459247a66c40bebb2020910806ee63f9e74dd";
    await expect(
      accessManager.connect(user).grantComponentRole(anotherComponent, SOME_ROLE, signers[0].address)
    ).to.be.revertedWith("AccessManager: msg.sender needs componentRoleAdmin");

    // ANY_COMPONENT admin can grant role on any component except someComponent
    await expect(accessManager.connect(backend).grantComponentRole(anotherComponent, SOME_ROLE, signers[1].address))
      .to.emit(accessManager, "RoleGranted")
      .withArgs(getComponentRole(anotherComponent, SOME_ROLE), signers[1].address, backend.address);

    await expect(
      accessManager.connect(backend).grantComponentRole(someComponent, SOME_ROLE, signers[1].address)
    ).to.be.revertedWith("AccessManager: msg.sender needs componentRoleAdmin");
  });

  it("Does not allow the zero address as a component", async () => {
    const { accessManager } = await helpers.loadFixture(accessManagerFixture);

    await expect(
      accessManager.setComponentRoleAdmin(
        hre.ethers.ZeroAddress,
        getRole("SOME_ROLE"),
        getRole("SOME_ROLE_ADMIN_ROLE")
      )
    ).to.be.revertedWith("AccessManager: invalid address for component");

    await expect(
      accessManager.grantComponentRole(hre.ethers.ZeroAddress, getRole("SOME_ROLE"), user.address)
    ).to.be.revertedWith("AccessManager: invalid address for component");
  });

  it("Allows changing the admin for global roles", async () => {
    const { accessManager } = await helpers.loadFixture(accessManagerFixture);

    // random user's can't set role admin
    await expect(
      accessManager.connect(backend).setRoleAdmin(getRole("SOME_ROLE"), getRole("SOME_ROLE_ADMIN"))
    ).to.be.revertedWith(accessControlMessage(backend.address, null, "DEFAULT_ADMIN_ROLE"));

    // current role admin can
    await accessManager.grantRole(getRole("DEFAULT_ADMIN_ROLE"), backend.address);
    await accessManager.connect(backend).setRoleAdmin(getRole("SOME_ROLE"), getRole("SOME_ROLE_ADMIN"));
    expect(await accessManager.getRoleAdmin(getRole("SOME_ROLE"))).to.equal(getRole("SOME_ROLE_ADMIN"));

    // once the admin was changed, old admin can't change it again
    await expect(
      accessManager.connect(backend).setRoleAdmin(getRole("SOME_ROLE"), getRole("SOME_ROLE_ADMIN"))
    ).to.be.revertedWith(accessControlMessage(backend.address, null, "SOME_ROLE_ADMIN"));

    // new admin can
    await accessManager.grantRole(getRole("SOME_ROLE_ADMIN"), user.address);
    await accessManager.connect(user).setRoleAdmin(getRole("SOME_ROLE"), getRole("SOME_ROLE_NEW_ADMIN"));
    expect(await accessManager.getRoleAdmin(getRole("SOME_ROLE"))).to.equal(getRole("SOME_ROLE_NEW_ADMIN"));
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
