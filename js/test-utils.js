const hre = require("hardhat");
const { _W, getTransactionEvent, AM_ROLES } = require("@ensuro/utils/js/utils");
const { deployAMPProxy, attachAsAMP, getAccessManager } = require("@ensuro/access-managed-proxy/js/deployProxy");
const { RiskModuleParameter } = require("./enums");
const { ampConfig } = require("./ampConfig");

const { ethers } = hre;
const { ZeroAddress } = ethers;

const randomAddress = "0x89cDb70Fee571251a66E34caa1673cE40f7549Dc";

async function makeAllPublic(contract, accessManager) {
  const skipSelectors = await (await attachAsAMP(contract)).PASS_THRU_METHODS();
  const selectors = contract.interface.fragments
    .filter((fragment) => fragment.type === "function" && skipSelectors.indexOf(fragment.selector) < 0)
    .map((fragment) => fragment.selector);
  await accessManager.setTargetFunctionRole(contract, selectors, AM_ROLES.PUBLIC_ROLE);
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
    contractName,
    disableAC,
  }
) {
  extraArgs = extraArgs || [];
  extraConstructorArgs = extraConstructorArgs || [];
  const _A = pool._A || _W;
  maxPayoutPerPolicy = maxPayoutPerPolicy !== undefined ? _A(maxPayoutPerPolicy) : _A(1000);
  exposureLimit = exposureLimit !== undefined ? _A(exposureLimit) : _A(1000000);
  contractName = contractName || "RiskModule";

  const accessManager = await getAccessManager(pool);
  const poolAddr = await ethers.resolveAddress(pool);
  const paAddr = await ethers.resolveAddress(premiumsAccount);
  const rm = await deployAMPProxy(
    contractFactory,
    [
      rmName || "RiskModule",
      _W(collRatio) || _W(1),
      _W(ensuroPPFee) || _W(0),
      _W(srRoc) || _W("0.1"),
      maxPayoutPerPolicy,
      exposureLimit,
      wallet || "0xdD2FD4581271e230360230F9337D5c0430Bf44C0", // Random address
      ...extraArgs,
    ],
    {
      kind: "uups",
      constructorArgs: [poolAddr, paAddr, ...extraConstructorArgs],
      unsafeAllow: ["missing-initializer"],
      acMgr: accessManager,
      ...ampConfig[contractName],
    }
  );

  await rm.waitForDeployment();

  if (disableAC || disableAC === undefined) await makeAllPublic(rm, accessManager);

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

  await pool.addComponent(rm, 2);
  return rm;
}

async function createEToken(
  pool,
  { etkName, etkSymbol, maxUtilizationRate, poolLoanInterestRate, extraArgs, extraConstructorArgs, disableAC }
) {
  const EToken = await ethers.getContractFactory("EToken");
  extraArgs = extraArgs || [];
  extraConstructorArgs = extraConstructorArgs || [];
  const poolAddr = await ethers.resolveAddress(pool);
  const accessManager = await getAccessManager(pool);
  const etk = await deployAMPProxy(
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
      constructorArgs: [poolAddr, ...extraConstructorArgs],
      acMgr: accessManager,
      ...ampConfig.EToken,
    }
  );

  await etk.waitForDeployment();

  if (disableAC || disableAC === undefined) await makeAllPublic(etk, accessManager);
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
  await pool.addComponent(etk, 1);
  return etk;
}

/**
 * Deploys the PolicyPool contract and AccessManager
 *
 * By default deployes de PolicyPool and AccessManager and grants LEVEL 1, 2, 3 permissions
 *
 * options:
 * - .currency: mandatory, the address of the currency used in the PolicyPool
 * - .nftName: default "Policy NFT"
 * - .nftSymbol: default "EPOL"
 * - .treasuryAddress: default randomAddress
 * - .disableAC: default true. If true, disables the access control making all non skipped methods accessible by
 *               anyone (PUBLIC_ROLE)
 */
async function deployPool(options) {
  const PolicyPool = await ethers.getContractFactory("PolicyPool");

  let accessManager;

  if (options.access === undefined) {
    const AccessManager = await ethers.getContractFactory("AccessManager");
    let admin = options.admin;
    if (admin === undefined) {
      [admin] = await ethers.getSigners();
    }
    // Deploy AccessManager
    accessManager = await AccessManager.deploy(admin);
    await accessManager.waitForDeployment();
  } else {
    accessManager = await ethers.getContractAt("AccessManager", options.access);
  }

  const currencyAddr = await ethers.resolveAddress(options.currency);
  const policyPool = await deployAMPProxy(
    PolicyPool,
    [
      options.nftName === undefined ? "Policy NFT" : options.nftName,
      options.nftSymbol === undefined ? "EPOL" : options.nftSymbol,
      options.treasuryAddress || randomAddress,
    ],
    {
      constructorArgs: [currencyAddr],
      acMgr: accessManager,
      ...ampConfig.PolicyPool,
    }
  );

  await policyPool.waitForDeployment();

  if (options.disableAC || options.disableAC === undefined) await makeAllPublic(policyPool, accessManager);

  return policyPool;
}

async function deployPremiumsAccount(pool, options, addToPool = true) {
  const PremiumsAccount = await ethers.getContractFactory("PremiumsAccount");
  const poolAddr = await ethers.resolveAddress(pool);
  const jrEtkAddr = options.jrEtk ? await ethers.resolveAddress(options.jrEtk) : ZeroAddress;
  const srEtkAddr = options.srEtk ? await ethers.resolveAddress(options.srEtk) : ZeroAddress;
  const accessManager = await getAccessManager(pool);
  const premiumsAccount = await deployAMPProxy(PremiumsAccount, [], {
    constructorArgs: [poolAddr, jrEtkAddr, srEtkAddr],
    kind: "uups",
    unsafeAllow: ["delegatecall"], // This holds, because PremiumsAccount is a reserve and uses delegatecall
    acMgr: accessManager,
    ...ampConfig.PremiumsAccount,
  });

  await premiumsAccount.waitForDeployment();
  if (options.disableAC || options.disableAC === undefined) await makeAllPublic(premiumsAccount, accessManager);

  if (addToPool) await pool.addComponent(premiumsAccount, 3);

  return premiumsAccount;
}

async function makePolicy(pool, rm, cust, payout, premium, lossProb, expiration, internalId, method = "newPolicy") {
  let tx = await rm.connect(cust)[method](payout, premium, lossProb, expiration, cust, internalId);
  let receipt = await tx.wait();
  const newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");

  return newPolicyEvt;
}

module.exports = {
  addEToken,
  addRiskModule,
  createEToken,
  createRiskModule,
  deployPool,
  deployPremiumsAccount,
  makePolicy,
  makeAllPublic,
};
