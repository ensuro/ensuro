const hre = require("hardhat");
const { _W, grantRole, getTransactionEvent } = require("../js/utils");
const { RiskModuleParameter } = require("../js/enums");
const helpers = require("@nomicfoundation/hardhat-network-helpers");

const { ethers } = hre;
const { ZeroAddress } = ethers;

async function initCurrency(options, initial_targets, initial_balances) {
  const Currency = await ethers.getContractFactory(options.contractClass || "TestCurrency");
  let currency = await Currency.deploy(
    options.name || "Test Currency",
    options.symbol || "TEST",
    options.initial_supply,
    options.decimals || 18
  );
  initial_targets = initial_targets || [];
  await Promise.all(
    initial_targets.map(async function (user, index) {
      await currency.transfer(user, initial_balances[index]);
    })
  );
  return currency;
}

/**
 *
 * @param currencyAddress The currency contract address, for example the USDC address
 * @param currencyOrigin An account that holds at least sum(initialBalances) of currency tokens
 * @param initialTargets Array of addresses that will receive the initial balances
 * @param initialBalances Initial balances for each address
 */
async function initForkCurrency(currencyAddress, currencyOrigin, initialTargets, initialBalances) {
  const currency = await ethers.getContractAt("IERC20", currencyAddress);
  await helpers.impersonateAccount(currencyOrigin);
  await helpers.setBalance(currencyOrigin, ethers.parseEther("100"));
  const whale = await ethers.getSigner(currencyOrigin);
  await Promise.all(
    initialTargets.map(async function (user, index) {
      await currency.connect(whale).transfer(user, initialBalances[index]);
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
  maxPayoutPerPolicy = maxPayoutPerPolicy !== undefined ? _A(maxPayoutPerPolicy) : _A(1000);
  exposureLimit = exposureLimit !== undefined ? _A(exposureLimit) : _A(1000000);

  const poolAddr = await ethers.resolveAddress(pool);
  const paAddr = await ethers.resolveAddress(premiumsAccount);
  const rm = await hre.upgrades.deployProxy(
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
    }
  );

  await rm.waitForDeployment();

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
  { etkName, etkSymbol, maxUtilizationRate, poolLoanInterestRate, extraArgs, extraConstructorArgs }
) {
  const EToken = await ethers.getContractFactory("EToken");
  extraArgs = extraArgs || [];
  extraConstructorArgs = extraConstructorArgs || [];
  const poolAddr = await ethers.resolveAddress(pool);
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
      constructorArgs: [poolAddr, ...extraConstructorArgs],
    }
  );

  await etk.waitForDeployment();
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
  const PolicyPool = await ethers.getContractFactory("PolicyPool");
  const AccessManager = await ethers.getContractFactory("AccessManager");

  let accessManager;

  if (options.access === undefined) {
    // Deploy AccessManager
    accessManager = await hre.upgrades.deployProxy(AccessManager, [], { kind: "uups" });
    await accessManager.waitForDeployment();
  } else {
    accessManager = await ethers.getContractAt("AccessManager", options.access);
  }

  const currencyAddr = await ethers.resolveAddress(options.currency);
  const amAddr = await ethers.resolveAddress(accessManager);
  const policyPool = await hre.upgrades.deployProxy(
    PolicyPool,
    [
      options.nftName === undefined ? "Policy NFT" : options.nftName,
      options.nftSymbol === undefined ? "EPOL" : options.nftSymbol,
      options.treasuryAddress || randomAddress,
    ],
    {
      constructorArgs: [amAddr, currencyAddr],
      kind: "uups",
    }
  );

  await policyPool.waitForDeployment();

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
  const PremiumsAccount = await ethers.getContractFactory("PremiumsAccount");
  const poolAddr = await ethers.resolveAddress(pool);
  const jrEtkAddr = options.jrEtk ? await ethers.resolveAddress(options.jrEtk) : ZeroAddress;
  const srEtkAddr = options.srEtk ? await ethers.resolveAddress(options.srEtk) : ZeroAddress;
  const premiumsAccount = await hre.upgrades.deployProxy(PremiumsAccount, [], {
    constructorArgs: [poolAddr, jrEtkAddr, srEtkAddr],
    kind: "uups",
    unsafeAllow: ["delegatecall"], // This holds, because EToken is a reserve and uses delegatecall
  });

  await premiumsAccount.waitForDeployment();

  if (addToPool) await pool.addComponent(premiumsAccount, 3);

  return premiumsAccount;
}

async function makePolicy(pool, rm, cust, payout, premium, lossProb, expiration, internalId, method = "newPolicy") {
  let tx = await rm.connect(cust)[method](payout, premium, lossProb, expiration, cust, internalId);
  let receipt = await tx.wait();
  const newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");

  return newPolicyEvt;
}

/**
 * Resets hardhat network to fork on the specified block and url
 */
async function setupChain(block, alchemyUrlEnv = "ALCHEMY_URL") {
  const alchemyUrl = process.env[alchemyUrlEnv];
  if (alchemyUrl === undefined) throw new Error(`Define envvar ${alchemyUrlEnv} for this test`);

  if (block === undefined) throw new Error("Block can't be undefined use null for the current block");
  if (block === null) block = undefined;
  return hre.network.provider.request({
    method: "hardhat_reset",
    params: [
      {
        forking: {
          jsonRpcUrl: alchemyUrl,
          blockNumber: block,
        },
      },
    ],
  });
}

const skipForkTests = process.env.SKIP_FORK_TESTS === "true";

/**
 * Chai test case wrapper for tests that require forking a live chain.
 *
 * It validates that the chain node URL is set, forks the chain at the specified block and adds the
 * block number to the test name.
 */
const fork = {
  it: (name, blockNumber, test, alchemyUrlEnv = "ALCHEMY_URL") => {
    const fullName = `[FORK ${blockNumber}] ${name}`;

    // eslint-disable-next-line func-style
    const wrapped = async (...args) => {
      await setupChain(blockNumber, alchemyUrlEnv);

      return test(...args);
    };

    return (skipForkTests ? it.skip : it)(fullName, wrapped);
  },
};

if (process.env.ENABLE_HH_WARNINGS !== "yes" && hre.upgrades !== undefined) hre.upgrades.silenceWarnings();

module.exports = {
  addEToken,
  addRiskModule,
  createEToken,
  createRiskModule,
  deployPool,
  deployPremiumsAccount,
  fork,
  initCurrency,
  initForkCurrency,
  makePolicy,
  setupChain,
  skipForkTests,
};
