const hre = require("hardhat");
const { _W, getTransactionEvent, AM_ROLES, getAddress } = require("@ensuro/utils/js/utils");
const { deployAMPProxy, attachAsAMP, getAccessManager } = require("@ensuro/access-managed-proxy/js/deployProxy");
const { ComponentKind } = require("./enums");
const { ampConfig } = require("./ampConfig");
const { makeFTUWInputData, makeWhitelistStatus } = require("./utils");

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
  { underwriter, wallet, extraArgs, extraConstructorArgs, disableAC }
) {
  extraArgs = extraArgs || [];
  extraConstructorArgs = extraConstructorArgs || [];

  if (underwriter === undefined) {
    const FullTrustedUW = await hre.ethers.getContractFactory("FullTrustedUW");
    underwriter = await FullTrustedUW.deploy();
  }

  const accessManager = await getAccessManager(pool);
  const poolAddr = await ethers.resolveAddress(pool);
  const paAddr = await ethers.resolveAddress(premiumsAccount);
  const RiskModule = await hre.ethers.getContractFactory("RiskModule");
  const rm = await deployAMPProxy(
    RiskModule,
    [
      getAddress(underwriter),
      wallet || "0xdD2FD4581271e230360230F9337D5c0430Bf44C0", // Random address
      ...extraArgs,
    ],
    {
      kind: "uups",
      constructorArgs: [poolAddr, paAddr, ...extraConstructorArgs],
      unsafeAllow: ["missing-initializer"],
      acMgr: accessManager,
      ...ampConfig.RiskModule,
    }
  );

  await rm.waitForDeployment();

  if (disableAC || disableAC === undefined) await makeAllPublic(rm, accessManager);

  return rm;
}

async function addRiskModule(
  pool,
  premiumsAccount,
  { underwriter, exposureLimit, wallet, extraArgs, extraConstructorArgs }
) {
  const rm = await createRiskModule(pool, premiumsAccount, {
    underwriter,
    wallet,
    extraArgs,
    extraConstructorArgs,
  });

  await pool.addComponent(rm, ComponentKind.riskModule);
  if (exposureLimit !== null) {
    exposureLimit = exposureLimit !== undefined ? pool._A(exposureLimit) : pool._A(1000000);
    await pool.setExposureLimit(rm, exposureLimit);
  }
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
  await pool.addComponent(etk, ComponentKind.eToken);
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
    acMgr: accessManager,
    ...ampConfig.PremiumsAccount,
  });

  await premiumsAccount.waitForDeployment();
  if (options.disableAC || options.disableAC === undefined) await makeAllPublic(premiumsAccount, accessManager);

  if (addToPool) await pool.addComponent(premiumsAccount, ComponentKind.premiumsAccount);

  return premiumsAccount;
}

async function deployWhitelist(pool, options) {
  const Whitelist = await ethers.getContractFactory(options.wlClass || "LPManualWhitelist");
  const poolAddr = await ethers.resolveAddress(pool);
  const accessManager = await getAccessManager(pool);
  const wl = await deployAMPProxy(Whitelist, [options.defaultStatus || makeWhitelistStatus("BBWW")], {
    kind: "uups",
    constructorArgs: [poolAddr],
    acMgr: accessManager,
    ...ampConfig.LPManualWhitelist,
  });

  await wl.waitForDeployment();
  if (options.disableAC || options.disableAC === undefined) await makeAllPublic(wl, accessManager);

  return wl;
}

async function makePolicy(pool, rm, cust, payout, premium, lossProb, expiration, internalId, params) {
  let tx = await rm.newPolicy(makeFTUWInputData({ payout, premium, lossProb, expiration, internalId, params }), cust);
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
  deployWhitelist,
  makePolicy,
  makeAllPublic,
};
