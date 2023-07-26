const hre = require("hardhat");
const { _W, grantRole, getTransactionEvent } = require("../js/utils");
const { RiskModuleParameter } = require("../js/enums");

async function initCurrency(options, initial_targets, initial_balances) {
  const Currency = await hre.ethers.getContractFactory("TestCurrency");
  let currency = await Currency.deploy(
    options.name || "Test Currency",
    options.symbol || "TEST",
    options.initial_supply,
    options.decimals || 18
  );
  initial_targets = initial_targets || [];
  await Promise.all(
    initial_targets.map(async function (user, index) {
      await currency.transfer(user.address, initial_balances[index]);
    })
  );
  return currency;
}

async function createRiskModule(
  pool,
  premiumsAccount,
  contractFactory,
  {
    rmName,
    collRatio,
    srRoc,
    ensuroPPFee,
    maxPayoutPerPolicy,
    exposureLimit,
    moc,
    wallet,
    extraArgs,
    extraConstructorArgs,
  }
) {
  extraArgs = extraArgs || [];
  extraConstructorArgs = extraConstructorArgs || [];
  const _A = pool._A || _W;
  const rm = await hre.upgrades.deployProxy(
    contractFactory,
    [
      rmName || "RiskModule",
      _W(collRatio) || _W(1),
      _W(ensuroPPFee) || _W(0),
      _W(srRoc) || _W("0.1"),
      _A(maxPayoutPerPolicy) || _A(1000),
      _A(exposureLimit) || _A(1000000),
      wallet || "0xdD2FD4581271e230360230F9337D5c0430Bf44C0", // Random address
      ...extraArgs,
    ],
    {
      kind: "uups",
      constructorArgs: [pool.address, premiumsAccount.address, ...extraConstructorArgs],
    }
  );

  await rm.deployed();

  if (moc !== undefined && moc != 1.0) {
    moc = _W(moc);
    await rm.setParam(RiskModuleParameter.moc, moc);
  }
  return rm;
}

async function addRiskModule(
  pool,
  premiumsAccount,
  contractFactory,
  {
    rmName,
    collRatio,
    srRoc,
    ensuroPPFee,
    maxPayoutPerPolicy,
    exposureLimit,
    moc,
    wallet,
    extraArgs,
    extraConstructorArgs,
  }
) {
  const rm = await createRiskModule(pool, premiumsAccount, contractFactory, {
    rmName,
    collRatio,
    srRoc,
    ensuroPPFee,
    maxPayoutPerPolicy,
    exposureLimit,
    moc,
    wallet,
    extraArgs,
    extraConstructorArgs,
  });

  await pool.addComponent(rm.address, 2);
  return rm;
}

async function createEToken(
  pool,
  { etkName, etkSymbol, maxUtilizationRate, poolLoanInterestRate, extraArgs, extraConstructorArgs }
) {
  const EToken = await hre.ethers.getContractFactory("EToken");
  extraArgs = extraArgs || [];
  extraConstructorArgs = extraConstructorArgs || [];
  const etk = await hre.upgrades.deployProxy(
    EToken,
    [
      etkName === undefined ? "EToken" : etkName,
      etkSymbol === undefined ? "eUSD1YEAR" : etkSymbol,
      _W(maxUtilizationRate) || _W(1),
      _W(poolLoanInterestRate) || _W("0.05"),
      ...extraArgs,
    ],
    {
      kind: "uups",
      unsafeAllow: ["delegatecall"], // This holds, because EToken is a reserve and uses delegatecall
      constructorArgs: [pool.address, ...extraConstructorArgs],
    }
  );

  await etk.deployed();
  return etk;
}

async function addEToken(
  pool,
  { etkName, etkSymbol, maxUtilizationRate, poolLoanInterestRate, extraArgs, extraConstructorArgs }
) {
  const etk = await createEToken(pool, {
    etkName,
    etkSymbol,
    maxUtilizationRate,
    poolLoanInterestRate,
    extraArgs,
    extraConstructorArgs,
  });
  await pool.addComponent(etk.address, 1);
  return etk;
}

const randomAddress = "0x89cDb70Fee571251a66E34caa1673cE40f7549Dc";

/**
 * Deploys the PolicyPool contract and AccessManager
 *
 * By default deployes de PolicyPool and AccessManager and grants LEVEL 1, 2, 3 permissions
 *
 * options:
 * - .currency: mandatory, the address of the currency used in the PolicyPool
 * - .access: if specified, doesn't create an AccessManager, uses this address.toLowerCase
 * - .nftName: default "Policy NFT"
 * - .nftSymbol: default "EPOL"
 * - .treasuryAddress: default randomAddress
 * - .grantRoles: default []. List of additional roles to grant
 * - .dontGrantL123Roles: if specified, doesn't grants LEVEL1, 2 and 3 roles.
 */
async function deployPool(options) {
  const PolicyPool = await hre.ethers.getContractFactory("PolicyPool");
  const AccessManager = await hre.ethers.getContractFactory("AccessManager");

  let accessManager;

  if (options.access === undefined) {
    // Deploy AccessManager
    accessManager = await hre.upgrades.deployProxy(AccessManager, [], { kind: "uups" });
    await accessManager.deployed();
  } else {
    accessManager = await hre.ethers.getContractAt("AccessManager", options.access);
  }

  const policyPool = await hre.upgrades.deployProxy(
    PolicyPool,
    [
      options.nftName === undefined ? "Policy NFT" : options.nftName,
      options.nftSymbol === undefined ? "EPOL" : options.nftSymbol,
      options.treasuryAddress || randomAddress,
    ],
    {
      constructorArgs: [accessManager.address, options.currency],
      kind: "uups",
    }
  );

  await policyPool.deployed();

  for (const role of options.grantRoles || []) {
    await grantRole(hre, accessManager, role);
  }

  if (options.dontGrantL123Roles === undefined) {
    await grantRole(hre, accessManager, "LEVEL1_ROLE");
    await grantRole(hre, accessManager, "LEVEL2_ROLE");
    await grantRole(hre, accessManager, "LEVEL3_ROLE");
  }

  return policyPool;
}

async function deployPremiumsAccount(pool, options, addToPool = true) {
  const PremiumsAccount = await hre.ethers.getContractFactory("PremiumsAccount");
  const premiumsAccount = await hre.upgrades.deployProxy(PremiumsAccount, [], {
    constructorArgs: [
      pool.address,
      options.jrEtkAddr || hre.ethers.constants.AddressZero,
      options.srEtkAddr || hre.ethers.constants.AddressZero,
    ],
    kind: "uups",
    unsafeAllow: ["delegatecall"], // This holds, because EToken is a reserve and uses delegatecall
  });

  await premiumsAccount.deployed();

  if (addToPool) await pool.addComponent(premiumsAccount.address, 3);

  return premiumsAccount;
}

async function makePolicy(pool, rm, cust, payout, premium, lossProb, expiration, internalId, method = "newPolicy") {
  let tx = await rm.connect(cust)[method](payout, premium, lossProb, expiration, cust.address, internalId);
  let receipt = await tx.wait();
  const newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");

  return newPolicyEvt;
}

if (process.env.ENABLE_HH_WARNINGS !== "yes") hre.upgrades.silenceWarnings();

module.exports = {
  addEToken,
  addRiskModule,
  createEToken,
  createRiskModule,
  deployPool,
  deployPremiumsAccount,
  initCurrency,
  makePolicy,
};
