const fs = require("fs");
const ethers = require("ethers");
const { task, types } = require("hardhat/config");
const { WhitelistStatus } = require("../js/enums");
const { ampConfig } = require("../js/ampConfig");
const {
  amountFunction,
  _W,
  getDefaultSigner,
  setupAMRole,
  getAccessManagerRole,
  getAddress,
} = require("@ensuro/utils/js/utils");

const { ZeroAddress } = ethers;

function amountDecimals() {
  let decimals = Number.parseInt(process.env.DEPLOY_AMOUNT_DECIMALS);
  console.assert(decimals >= 6);
  return decimals;
}

const GWei = amountFunction(9);
const _A = amountFunction(amountDecimals());

/**
 * Transaction overrides using env variables because hardhat-ethers ignores hardhat config
 * See: https://hardhat.org/hardhat-runner/plugins/nomiclabs-hardhat-ethers#gas-transaction-parameters-in--hardhat.config--are-not-used
 */
function txOverrides() {
  const ret = {};
  if (process.env.OVERRIDE_GAS_PRICE !== undefined) {
    ret.gasPrice = GWei(parseFloat(process.env.OVERRIDE_GAS_PRICE));
  }

  if (process.env.OVERRIDE_GAS_LIMIT !== undefined) {
    ret.gasLimit = parseInt(process.env.OVERRIDE_GAS_LIMIT);
  }
  return ret || undefined;
}

function saveAddress(name, address) {
  if (name === undefined) {
    throw "Didn't specified an address to save. If you don't want to save the address send null";
  }
  if (!name || name === "") return;
  let addresses;
  let addressesFilename;
  if (process.env.ADDRESSES_FILENAME) {
    addressesFilename = process.env.ADDRESSES_FILENAME;
  } else {
    if (process.env.NETWORK) {
      addressesFilename = `.addresses-${process.env.NETWORK}.json`;
    } else {
      addressesFilename = ".addresses-localhost.json";
    }
  }
  try {
    addresses = JSON.parse(fs.readFileSync(addressesFilename));
  } catch (err) {
    console.log("Error reading .addresses.json", err);
    addresses = {};
  }
  addresses[name] = address;
  fs.writeFileSync(addressesFilename, JSON.stringify(addresses, null, 4));
}

function etherscanUrl() {
  return process.env.ETHERSCAN_URL;
}

async function logContractCreated(hre, contractName, address) {
  const browserUrl = etherscanUrl();
  if (browserUrl) {
    console.log(`${contractName} deployed to: ${browserUrl}/address/${address}`);
  } else {
    console.log(`${contractName} deployed to: ${address}`);
  }
}

async function verifyContract(hre, contract, isProxy, constructorArguments) {
  constructorArguments = constructorArguments || [];
  const address = await ethers.resolveAddress(contract);
  try {
    await hre.run("verify:verify", {
      address,
      constructorArguments,
    });
  } catch (error) {
    console.log("Error verifying contract implementation: ", error);
    console.log("You can retry with:");
    console.log(
      `    npx hardhat verify --network '${hre.network.name}' '${address}' ${constructorArguments
        .map((a) => `'${a.toString()}'`)
        .join(" ")}`
    );
  }
}

async function deployContract({ saveAddr, verify, contractClass, constructorArgs }, hre) {
  const ContractFactory = await hre.ethers.getContractFactory(contractClass);
  const contract = await ContractFactory.deploy(...constructorArgs, txOverrides());
  const contractAddr = await ethers.resolveAddress(contract);
  if (verify) {
    await contract.deploymentTransaction().wait(6);
  } else {
    await contract.waitForDeployment();
  }
  await logContractCreated(hre, contractClass, contractAddr);
  saveAddress(saveAddr, contractAddr);
  if (verify) await verifyContract(hre, contract, false, constructorArgs);
  return { ContractFactory, contract };
}

async function deployProxyContract(
  { saveAddr, verify, contractClass, constructorArgs, initializeArgs, initializer, deployProxyArgs },
  hre
) {
  const ContractFactory = await hre.ethers.getContractFactory(contractClass);
  const contract = await hre.upgrades.deployProxy(ContractFactory, initializeArgs || [], {
    constructorArgs: constructorArgs,
    kind: "uups",
    initializer: initializer,
    ...deployProxyArgs,
  });
  const contractAddr = await ethers.resolveAddress(contract);
  if (verify) {
    await contract.deploymentTransaction().wait(6);
  } else {
    await contract.waitForDeployment();
  }
  await logContractCreated(hre, contractClass, contractAddr);
  saveAddress(saveAddr, contractAddr);
  if (verify) await verifyContract(hre, contract, true, constructorArgs);
  return { ContractFactory, contract };
}

async function deployAMPProxyContract(
  { saveAddr, verify, contractClass, constructorArgs, initializeArgs, initializer, deployProxyArgs, acMgr },
  hre
) {
  // eslint-disable-next-line global-require
  const { deployAMPProxy } = require("@ensuro/access-managed-proxy/js/deployProxy");
  const ContractFactory = await hre.ethers.getContractFactory(contractClass);
  const contract = await deployAMPProxy(ContractFactory, initializeArgs || [], {
    constructorArgs: constructorArgs,
    initializer: initializer,
    acMgr: acMgr,
    ...ampConfig[contractClass],
    ...deployProxyArgs,
  });
  const contractAddr = await ethers.resolveAddress(contract);
  if (verify) {
    await contract.deploymentTransaction().wait(6);
  } else {
    await contract.waitForDeployment();
  }
  await logContractCreated(hre, contractClass, contractAddr);
  saveAddress(saveAddr, contractAddr);
  if (verify) await verifyContract(hre, contract, true, constructorArgs);
  return { ContractFactory, contract };
}

async function deployTestCurrency({ currName, currSymbol, initialSupply, ...opts }, hre) {
  return (
    await deployContract(
      {
        contractClass: "TestCurrency",
        constructorArgs: [currName, currSymbol, _A(initialSupply), amountDecimals()],
        ...opts,
      },
      hre
    )
  ).contract;
}

async function deployAccessManager(opts, hre) {
  const admin = opts.admin === undefined ? await getDefaultSigner(hre) : opts.admin;
  const { contract } = await deployContract({ contractClass: "AccessManager", constructorArgs: [admin], ...opts }, hre);
  return contract;
}

async function deployPolicyPool(
  { acMgr, currencyAddress, nftName, nftSymbol, treasuryAddress, setupInternalPermissions, ...opts },
  hre
) {
  const { contract } = await deployAMPProxyContract(
    {
      contractClass: "PolicyPool",
      constructorArgs: [currencyAddress],
      initializeArgs: [nftName, nftSymbol, treasuryAddress],
      acMgr,
      ...opts,
    },
    hre
  );
  if (setupInternalPermissions) {
    acMgr = await hre.ethers.getContractAt("AccessManager", acMgr);
    await acMgr.grantRole(getAccessManagerRole("POOL_ROLE"), contract, 0);
  }
  return contract;
}

function borrowerRole(etkAddr) {
  return `BORROWER_FOR_ETK_${etkAddr.slice(0, 8)}_ROLE`;
}

async function deployEToken(
  { poolAddress, acMgr, etkName, etkSymbol, maxUtilizationRate, poolLoanInterestRate, runAs, ...opts },
  hre
) {
  const { contract } = await deployAMPProxyContract(
    {
      contractClass: "EToken",
      constructorArgs: [poolAddress],
      initializeArgs: [etkName, etkSymbol, _W(maxUtilizationRate), _W(poolLoanInterestRate)],
      acMgr,
      ...opts,
    },
    hre
  );
  if (opts.addComponent) {
    let policyPool = await hre.ethers.getContractAt("PolicyPool", poolAddress);
    if (runAs) policyPool = policyPool.connect(runAs);
    await policyPool.addComponent(contract, 1);
  }
  if (opts.setupInternalPermissions) {
    acMgr = await hre.ethers.getContractAt("AccessManager", acMgr);
    await setupAMRole(acMgr, contract, undefined, "POOL_ROLE", [
      "deposit",
      "withdraw",
      "addBorrower",
      "removeBorrower",
    ]);
    await setupAMRole(acMgr, contract, undefined, borrowerRole(getAddress(contract)), [
      "repayLoan",
      "internalLoan",
      "lockScr",
      "unlockScr",
    ]);
  }
  return contract;
}

async function deployPremiumsAccount({ poolAddress, acMgr, juniorEtk, seniorEtk, runAs, ...opts }, hre) {
  const { contract } = await deployAMPProxyContract(
    {
      contractClass: "PremiumsAccount",
      constructorArgs: [poolAddress, juniorEtk, seniorEtk],
      initializeArgs: [],
      acMgr,
      ...opts,
    },
    hre
  );
  if (opts.addComponent) {
    let policyPool = await hre.ethers.getContractAt("PolicyPool", poolAddress);
    if (runAs) policyPool = policyPool.connect(runAs);
    await policyPool.addComponent(contract, 3);
  }
  if (opts.setupInternalPermissions) {
    acMgr = await hre.ethers.getContractAt("AccessManager", acMgr);
    if (juniorEtk !== ZeroAddress) {
      await acMgr.grantRole(getAccessManagerRole(borrowerRole(juniorEtk)), contract, 0);
    }
    if (seniorEtk !== ZeroAddress) {
      await acMgr.grantRole(getAccessManagerRole(borrowerRole(seniorEtk)), contract, 0);
    }
  }
  return contract;
}

async function deployRiskModule(
  { rmClass, poolAddress, acMgr, paAddress, underwriter, wallet, extraArgs, extraConstructorArgs, runAs, ...opts },
  hre
) {
  extraArgs = typeof extraArgs === "string" ? JSON.parse(extraArgs) : extraArgs || [];

  extraConstructorArgs =
    typeof extraConstructorArgs === "string" ? JSON.parse(extraConstructorArgs) : extraConstructorArgs || [];

  if (underwriter === undefined) {
    const FullTrustedUW = await hre.ethers.getContractFactory("FullTrustedUW");
    underwriter = await FullTrustedUW.deploy();
  }

  const { contract } = await deployAMPProxyContract(
    {
      contractClass: rmClass,
      constructorArgs: [poolAddress, paAddress, ...extraConstructorArgs],
      initializeArgs: [await ethers.resolveAddress(underwriter), wallet, ...extraArgs],
      acMgr,
      ...opts,
    },
    hre
  );
  if (opts.addComponent) {
    let policyPool = await hre.ethers.getContractAt("PolicyPool", poolAddress);
    if (runAs) policyPool = policyPool.connect(runAs);
    await policyPool.addComponent(contract, 2);
  }
  return contract;
}

async function setAssetManager({ reserve, amAddress, liquidityMin, liquidityMiddle, liquidityMax }, hre) {
  const reserveContract = await hre.ethers.getContractAt("Reserve", reserve);
  const tx = await reserveContract.setAssetManager(amAddress, false);
  console.log(`Asset Manager ${amAddress} set to reserve ${reserve}`);
  if (liquidityMin !== undefined || liquidityMiddle !== undefined || liquidityMax !== undefined) {
    liquidityMin = liquidityMin === undefined ? ethers.MaxUint256 : _A(liquidityMin);
    liquidityMiddle = liquidityMiddle === undefined ? ethers.MaxUint256 : _A(liquidityMiddle);
    liquidityMax = liquidityMax === undefined ? ethers.MaxUint256 : _A(liquidityMax);
    const amContract = await hre.ethers.getContractAt(
      "ERC4626AssetManager", // Not relevant if it's ERC4626AssetManager, only need setLiquidityThresholds
      amAddress
    );

    // To make sure the setAssetManager was executed - wait 2 confirmations
    await tx.wait(process.env.NETWORK !== "localhost" ? 2 : undefined);
    await reserveContract.forwardToAssetManager(
      amContract.interface.encodeFunctionData("setLiquidityThresholds", [liquidityMin, liquidityMiddle, liquidityMax])
    );
    console.log(`setLiquidityThresholds(${liquidityMin}, ${liquidityMiddle}, ${liquidityMax}`);
  }
}

async function deployERC4626AssetManager({ asset, vault, amClass, ...opts }, hre) {
  return (
    await deployContract(
      {
        contractClass: amClass,
        constructorArgs: [asset, vault],
        ...opts,
      },
      hre
    )
  ).contract;
}

async function deployAaveAssetManager({ asset, aave, amClass, ...opts }, hre) {
  return (
    await deployContract(
      {
        contractClass: amClass,
        constructorArgs: [asset, aave],
        ...opts,
      },
      hre
    )
  ).contract;
}

async function deployWhitelist(
  { wlClass, poolAddress, acMgr, extraConstructorArgs, extraArgs, eToken, eToken2, eToken3, defaultStatus, ...opts },
  hre
) {
  extraArgs = extraArgs || [];
  if (defaultStatus !== "") {
    defaultStatus = defaultStatus
      .split("")
      .map((WB) => (WB == "W" ? WhitelistStatus.whitelisted : WhitelistStatus.blacklisted));
    extraArgs.splice(0, 0, defaultStatus);
  }
  extraConstructorArgs = extraConstructorArgs || [];
  const { contract } = await deployProxyContract(
    {
      contractClass: wlClass,
      constructorArgs: [poolAddress, ...extraConstructorArgs],
      initializeArgs: [...extraArgs],
      initializer: opts.initializer,
      acMgr,
      ...opts,
    },
    hre
  );
  if (eToken !== undefined) {
    const etk = await hre.ethers.getContractAt("EToken", eToken);
    await etk.setWhitelist(contract);
  }
  if (eToken2 !== undefined) {
    const etk = await hre.ethers.getContractAt("EToken", eToken2);
    await etk.setWhitelist(contract);
  }
  if (eToken3 !== undefined) {
    const etk = await hre.ethers.getContractAt("EToken", eToken3);
    await etk.setWhitelist(contract);
  }
  return contract;
}

async function listETokens({ poolAddress }, hre) {
  const policyPool = await hre.ethers.getContractAt("PolicyPool", poolAddress);
  const etkCount = await policyPool.getETokenCount();

  console.log(`Pool has ${etkCount} tokens`);

  for (let i = 0; i < etkCount; i++) {
    const etk = await hre.ethers.getContractAt("EToken", await policyPool.getETokenAt(i));
    const etkName = await etk.name();
    console.log(`eToken at ${etk.target}: ${etkName}`);
  }
}

async function deposit({ etkAddress, amount }, hre) {
  const etk = await hre.ethers.getContractAt("EToken", etkAddress);
  const policyPool = await hre.ethers.getContractAt("PolicyPool", await etk.policyPool());
  const currency = await hre.ethers.getContractAt("IERC20Metadata", await policyPool.currency());
  amount = _A(amount);
  await currency.approve(policyPool, amount);
  const tx = await policyPool.deposit(etk, amount, { gasLimit: 999999 });
  console.log(tx);
}

function add_task() {
  task("deploy", "Deploys the PolicyPool and other required contracts")
    .addOptionalParam("verify", "Verify contract in Etherscan", false, types.boolean)
    .addOptionalParam("currName", "Name of Test Currency", "Ensuro Test USD", types.str)
    .addOptionalParam("currSymbol", "Symbol of Test Currency", "EUSD", types.str)
    .addOptionalParam("initialSupply", "Initial supply in the test currency", 2000, types.int)
    .addOptionalParam("nftName", "Name of Policies NFT Token", "Ensuro Policies NFT", types.str)
    .addOptionalParam("nftSymbol", "Symbol of Policies NFT Token", "EPOL", types.str)
    .addOptionalParam("currencyAddress", "Currency Address", undefined, types.address)
    .addOptionalParam("admin", "AccessManager's admin", undefined, types.address)
    .addOptionalParam("acMgr", "AccessManager Address", undefined, types.address)
    .addOptionalParam(
      "setupInternalPermissions",
      "Sets up PolicyPool permissions on ACCESSMANAGER",
      true,
      types.boolean
    )
    .addParam("treasuryAddress", "Treasury Address", types.address)
    .setAction(async function (taskArgs, hre) {
      if (taskArgs.currencyAddress === undefined) {
        taskArgs.saveAddr = "CURRENCY";
        const currency = await deployTestCurrency(taskArgs, hre);
        taskArgs.currencyAddress = await ethers.resolveAddress(currency);
      }
      if (taskArgs.acMgr === undefined) {
        taskArgs.saveAddr = "ACCESSMANAGER";
        const access = await deployAccessManager(taskArgs, hre);
        taskArgs.acMgr = await ethers.resolveAddress(access);
      }
      taskArgs.saveAddr = "POOL";
      await deployPolicyPool(taskArgs, hre);
    });

  task("deploy:testCurrency", "Deploys the Test Currency")
    .addOptionalParam("verify", "Verify contract in Etherscan", false, types.boolean)
    .addOptionalParam("saveAddr", "Save created contract address", "CURRENCY", types.str)
    .addOptionalParam("currName", "Name of Test Currency", "Ensuro Test USD", types.str)
    .addOptionalParam("currSymbol", "Symbol of Test Currency", "EUSD", types.str)
    .addOptionalParam("initialSupply", "Initial supply in the test currency", 2000, types.int)
    .setAction(deployTestCurrency);

  task("deploy:accessManager", "Deploys an OZ 5.x AccessManager")
    .addOptionalParam("verify", "Verify contract in Etherscan", false, types.boolean)
    .addOptionalParam("admin", "Address of the admin of the AM (default: deployer's address)", undefined, types.address)
    .addOptionalParam("saveAddr", "Save created contract address", "ACCESSMANAGER", types.str)
    .setAction(deployAccessManager);

  task("deploy:pool", "Deploys the PolicyPool")
    .addOptionalParam("verify", "Verify contract in Etherscan", false, types.boolean)
    .addOptionalParam("saveAddr", "Save created contract address", "POOL", types.str)
    .addOptionalParam("nftName", "Name of Policies NFT Token", "Ensuro Policies NFT", types.str)
    .addOptionalParam("nftSymbol", "Symbol of Policies NFT Token", "EPOL", types.str)
    .addOptionalParam("treasuryAddress", "Treasury Address", ZeroAddress, types.address)
    .addOptionalParam(
      "setupInternalPermissions",
      "Sets up internal protocol permissions on ACCESSMANAGER",
      true,
      types.boolean
    )
    .addParam("currencyAddress", "Currency Address", types.address)
    .addParam("acMgr", "AccessManager Address", types.address)
    .setAction(deployPolicyPool);

  task("deploy:eToken", "Deploy an EToken and adds it to the pool")
    .addOptionalParam("verify", "Verify contract in Etherscan", false, types.boolean)
    .addOptionalParam("saveAddr", "Save created contract address", "ETOKEN", types.str)
    .addOptionalParam("addComponent", "Adds the new component to the pool", true, types.boolean)
    .addOptionalParam(
      "setupInternalPermissions",
      "Sets up internal protocol permissions on ACCESSMANAGER",
      true,
      types.boolean
    )
    .addParam("poolAddress", "PolicyPool Address", types.address)
    .addParam("acMgr", "AccessManager Address", types.address)
    .addParam("etkName", "Name of EToken", types.str)
    .addParam("etkSymbol", "Symbol of EToken", types.str)
    .addOptionalParam("maxUtilizationRate", "Max Utilization Rate", 1.0, types.float)
    .addOptionalParam("poolLoanInterestRate", "Interest rate when pool takes money from eToken", 0.05, types.float)
    .setAction(deployEToken);

  task("deploy:premiumsAccount", "Deploy a premiums account")
    .addOptionalParam("verify", "Verify contract in Etherscan", false, types.boolean)
    .addOptionalParam("saveAddr", "Save created contract address", "PA", types.str)
    .addOptionalParam("addComponent", "Adds the new component to the pool", true, types.boolean)
    .addOptionalParam(
      "setupInternalPermissions",
      "Sets up internal protocol permissions on ACCESSMANAGER",
      true,
      types.boolean
    )
    .addParam("poolAddress", "PolicyPool Address", types.address)
    .addParam("acMgr", "AccessManager Address", types.address)
    .addParam("juniorEtk", "Junior EToken Address", types.address)
    .addParam("seniorEtk", "Senior EToken Address", types.address)
    .setAction(deployPremiumsAccount);

  task("deploy:riskModule", "Deploys a RiskModule and adds it to the pool")
    .addOptionalParam("verify", "Verify contract in Etherscan", false, types.boolean)
    .addOptionalParam("saveAddr", "Save created contract address", "RM", types.str)
    .addOptionalParam("addComponent", "Adds the new component to the pool", true, types.boolean)
    .addOptionalParam(
      "setupInternalPermissions",
      "Sets up internal protocol permissions on ACCESSMANAGER",
      true,
      types.boolean
    )
    .addParam("poolAddress", "PolicyPool Address", types.address)
    .addParam("acMgr", "AccessManager Address", types.address)
    .addParam("paAddress", "PremiumsAccount Address", types.address)
    .addOptionalParam("rmClass", "RiskModule contract", "RiskModule", types.str)
    .addOptionalParam("underwriter", "Underwriter Address", undefined, types.address)
    .addOptionalParam("extraConstructorArgs", "Additional constructor args", undefined, types.str)
    .addOptionalParam("extraArgs", "Additional initializer args", undefined, types.str)
    .addParam("wallet", "RM address", types.address)
    .setAction(deployRiskModule);

  task("ens:setAssetManager", "Sets an asset manager to a reserve")
    .addParam("reserve", "Reserve Address", types.address)
    .addParam("amAddress", "Address of Asset Manager (reuse one already deployed)", types.address)
    .addOptionalParam("liquidityMin", "liquidityMin", undefined, types.float)
    .addOptionalParam("liquidityMiddle", "liquidityMiddle", undefined, types.float)
    .addOptionalParam("liquidityMax", "liquidityMax", undefined, types.float)
    .setAction(setAssetManager);

  task("deploy:erc4626AssetManager", "Deploys an ERC4626 AssetManager")
    .addOptionalParam("verify", "Verify contract in Etherscan", false, types.boolean)
    .addOptionalParam("saveAddr", "Save created contract address", "ASSETMANAGER", types.str)
    .addParam("asset", "Asset Address", types.address)
    .addParam("vault", "Vault Address", types.address)
    .addOptionalParam("amClass", "AssetManager contract", "ERC4626AssetManager", types.str)
    .setAction(deployERC4626AssetManager);

  task("deploy:aaveAssetManager", "Deploys a AaveAssetManager")
    .addOptionalParam("verify", "Verify contract in Etherscan", false, types.boolean)
    .addOptionalParam("saveAddr", "Save created contract address", "ASSETMANAGER", types.str)
    .addParam("asset", "Asset Address", types.address)
    .addParam("aave", "AAVE LendingPool Address", types.address)
    .addOptionalParam("amClass", "AssetManager contract", "AAVEv3AssetManager", types.str)
    .setAction(deployAaveAssetManager);

  task("deploy:whitelist", "Deploys a Whitelisting contract")
    .addOptionalParam("verify", "Verify contract in Etherscan", false, types.boolean)
    .addOptionalParam("saveAddr", "Save created contract address", "WHITELIST", types.str)
    .addOptionalParam("wlClass", "Whitelisting contract", "LPManualWhitelist", types.str)
    .addOptionalParam("eToken", "Set the Whitelist to a given eToken", undefined, types.address)
    .addOptionalParam("eToken2", "Set the Whitelist to a given eToken", undefined, types.address)
    .addOptionalParam("eToken3", "Set the Whitelist to a given eToken", undefined, types.address)
    .addOptionalParam("defaultStatus", "Default Status Ej: 'BWWB'", "BWWB", types.str)
    .addParam("poolAddress", "PolicyPool Address", types.address)
    .addParam("acMgr", "AccessManager Address", types.address)
    .setAction(deployWhitelist);

  task("ens:listETokens", "Lists eTokens")
    .addParam("poolAddress", "PolicyPool Address", types.address)
    .setAction(listETokens);

  task("ens:deposit", "Deposits in a given eToken")
    .addParam("etkAddress", "EToken address", types.address)
    .addParam("amount", "Amount to Deposit", undefined, types.int)
    .setAction(deposit);
}

module.exports = {
  add_task,
  saveAddress,
  logContractCreated,
  deployContract,
  deployProxyContract,
  deployEToken,
  deployPremiumsAccount,
  deployRiskModule,
  setAssetManager,
  deployWhitelist,
  txOverrides,
  amountFunction,
  _W,
  _A,
};
