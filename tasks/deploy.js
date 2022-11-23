const upgrades_core = require("@openzeppelin/upgrades-core");
const fs = require("fs");

const ethers = require("ethers");

const _BN = ethers.BigNumber.from;
const WAD = _BN(1e10).mul(_BN(1e8)); // 1e10*1e8=1e18
const RAY = WAD.mul(_BN(1e9)); // 1e18*1e9=1e27

function _W(value) {
  if (!Number.isInteger(value)) return _BN(value * 1e10).mul(_BN(1e8));
  return _BN(value).mul(WAD);
}

function _R(value) {
  if (!Number.isInteger(value)) return _BN(Math.round(value * 1e9)).mul(WAD);
  return _BN(value).mul(RAY);
}

function amountDecimals() {
  let decimals = Number.parseInt(process.env.DEPLOY_AMOUNT_DECIMALS);
  console.assert(decimals >= 6);
  return decimals;
}

function _A(value) {
  // Decimals must be at least 6
  if (typeof value === "string" || value instanceof String) {
    return _BN(value).mul(_BN(Math.pow(10, amountDecimals())));
  } else {
    return _BN(Math.round(value * 1e6)).mul(_BN(Math.pow(10, amountDecimals() - 6)));
  }
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
  if (isProxy === undefined) isProxy = false;
  if (constructorArguments === undefined) constructorArguments = [];
  let address = contract.address;
  if (isProxy) address = await upgrades_core.getImplementationAddress(hre.network.provider, address);
  try {
    await hre.run("verify:verify", {
      address: address,
      constructorArguments: constructorArguments,
    });
    if (isProxy) {
      console.log(
        "Contract successfully verified, you should verify the proxy at " +
          `${etherscanUrl()}/proxyContractChecker?a=${contract.address}`
      );
    }
  } catch (error) {
    console.log("Error verifying contract", error);
  }
}

async function deployContract({ saveAddr, verify, contractClass, constructorArgs }, hre) {
  const ContractFactory = await hre.ethers.getContractFactory(contractClass);
  const contract = await ContractFactory.deploy(...constructorArgs);
  if (verify) {
    // From https://ethereum.stackexchange.com/a/119622/79726
    await contract.deployTransaction.wait(6);
  } else {
    await contract.deployed();
  }
  await logContractCreated(hre, contractClass, contract.address);
  saveAddress(saveAddr, contract.address);
  if (verify) await verifyContract(hre, contract, false, constructorArgs);
  return { ContractFactory, contract };
}

async function deployProxyContract({ saveAddr, verify, contractClass, constructorArgs, initializeArgs }, hre) {
  const ContractFactory = await hre.ethers.getContractFactory(contractClass);
  const contract = await hre.upgrades.deployProxy(ContractFactory, initializeArgs || [], {
    constructorArgs: constructorArgs,
    kind: "uups",
    unsafeAllow: ["delegatecall"],
  });
  if (verify) {
    // From https://ethereum.stackexchange.com/a/119622/79726
    await contract.deployTransaction.wait(6);
  } else {
    await contract.deployed();
  }
  await logContractCreated(hre, contractClass, contract.address);
  saveAddress(saveAddr, contract.address);
  if (verify) await verifyContract(hre, contract, true, constructorArgs);
  return { ContractFactory, contract };
}

function parseRole(role) {
  if (role.startsWith("0x"))
    return role;
  if (role === "DEFAULT_ADMIN_ROLE")
    return ethers.constants.AddressZero;
  return ethers.utils.keccak256(ethers.utils.toUtf8Bytes(role));
}

async function grantComponentRole(hre, contract, component, role, user) {
  let userAddress;
  if (user === undefined) {
    user = await _getDefaultSigner(hre);
    userAddress = user.address;
  } else {
    userAddress = user;
  }
  const roleHex = parseRole(role);
  const componentAddress = component.address || component;
  const componentRole = await contract.getComponentRole(componentAddress, roleHex);
  if (!(await contract.hasRole(componentRole, userAddress))) {
    await contract.grantComponentRole(componentAddress, roleHex, userAddress);
    console.log(`Role ${role} (${roleHex}) Component ${componentAddress} granted to ${userAddress}`);
  } else {
    console.log(`Role ${role} (${roleHex}) Component ${componentAddress} already granted to ${userAddress}`);
  }
}

async function grantRole(hre, contract, role, user) {
  let userAddress;
  if (user === undefined) {
    user = await _getDefaultSigner(hre);
    userAddress = user.address;
  } else {
    userAddress = user;
  }
  const roleHex = parseRole(role);
  if (!(await contract.hasRole(roleHex, userAddress))) {
    await contract.grantRole(roleHex, userAddress);
    console.log(`Role ${role} (${roleHex}) granted to ${userAddress}`);
  } else {
    console.log(`Role ${role} (${roleHex}) already granted to ${userAddress}`);
  }
}

async function grantRoleTask({ contractAddress, role, account, component }, hre) {
  const contract = await hre.ethers.getContractAt("AccessManager", contractAddress);
  if (component === ethers.constants.AddressZero) {
    await grantRole(hre, contract, role, account);
  } else {
    await grantComponentRole(hre, contract, component, role, account);
  }
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
  ).contract.address;
}

async function deployAccessManager(opts, hre) {
  return (await deployProxyContract({ contractClass: "AccessManager", ...opts }, hre)).contract.address;
}

async function _getDefaultSigner(hre) {
  const signers = await hre.ethers.getSigners();
  return signers[0];
}

async function deployPolicyPool({ accessAddress, currencyAddress, nftName, nftSymbol, treasuryAddress, ...opts }, hre) {
  return (
    await deployProxyContract(
      {
        contractClass: "PolicyPool",
        constructorArgs: [accessAddress, currencyAddress],
        initializeArgs: [nftName, nftSymbol, treasuryAddress],
        ...opts,
      },
      hre
    )
  ).contract.address;
}

async function deployEToken(
  { poolAddress, etkName, etkSymbol, maxUtilizationRate, poolLoanInterestRate, ...opts },
  hre
) {
  const { contract } = await deployProxyContract(
    {
      contractClass: "EToken",
      constructorArgs: [poolAddress],
      initializeArgs: [etkName, etkSymbol, _W(maxUtilizationRate), _W(poolLoanInterestRate)],
      ...opts,
    },
    hre
  );
  const policyPool = await hre.ethers.getContractAt("PolicyPool", poolAddress);
  if (opts.addComponent)
    await policyPool.addComponent(contract.address, 1);
  return contract.address;
}

async function deployPremiumsAccount({ poolAddress, juniorEtk, seniorEtk, ...opts }, hre) {
  const { contract } = await deployProxyContract(
    {
      contractClass: "PremiumsAccount",
      constructorArgs: [poolAddress, juniorEtk, seniorEtk],
      initializeArgs: [],
      ...opts,
    },
    hre
  );
  const policyPool = await hre.ethers.getContractAt("PolicyPool", poolAddress);
  if (opts.addComponent)
    await policyPool.addComponent(contract.address, 3);
  return contract.address;
}

async function deployRiskModule(
  {
    rmClass,
    rmName,
    poolAddress,
    paAddress,
    collRatio,
    jrCollRatio,
    roc,
    jrRoc,
    ensuroPpFee,
    ensuroCocFee,
    maxPayoutPerPolicy,
    exposureLimit,
    maxDuration,
    moc,
    wallet,
    extraArgs,
    extraConstructorArgs,
    ...opts
  },
  hre
) {
  extraArgs = extraArgs || [];
  extraConstructorArgs = extraConstructorArgs || [];
  const { contract } = await deployProxyContract(
    {
      contractClass: rmClass,
      constructorArgs: [poolAddress, paAddress, ...extraConstructorArgs],
      initializeArgs: [
        rmName,
        _W(collRatio),
        _W(ensuroPpFee),
        _W(roc),
        _A(maxPayoutPerPolicy),
        _A(exposureLimit),
        wallet,
        ...extraArgs,
      ],
      ...opts,
    },
    hre
  );
  const rm = contract;

  if (moc != 1.0) {
    moc = _W(moc);
    await rm.setParam(0, moc);
  }
  if (jrCollRatio != 0.0) {
    jrCollRatio = _W(jrCollRatio);
    await rm.setParam(1, jrCollRatio);
  }
  if (jrRoc != 0.0) {
    jrRoc = _W(jrRoc);
    await rm.setParam(5, jrRoc);
  }
  if (ensuroCocFee != 0) {
    ensuroCocFee = _W(ensuroCocFee);
    await rm.setParam(4, ensuroCocFee);
  }
  if (maxDuration != 24 * 365) {
    await rm.setParam(9, ensuroCocFee);
  }
  const policyPool = await hre.ethers.getContractAt("PolicyPool", poolAddress);
  if (opts.addComponent)
    await policyPool.addComponent(contract.address, 2);
  return contract.address;
}

async function deployFlightDelayRM(opts, hre) {
  opts.extraArgs = [opts.linkToken, [opts.oracle, opts.delayTime, _W(opts.oracleFee), opts.dataJobId, opts.sleepJobId]];
  return deployRiskModule(opts, hre);
}

async function deployPriceRM(opts, hre) {
  opts.extraConstructorArgs = [opts.assetOracle, opts.referenceOracle, _W(opts.slotSize)];
  opts.extraArgs = [opts.oracleTolerance];
  const rm = await deployRiskModule(opts, hre);
  if (opts.minDuration != 3600) {
    // TODO: we will need ORACLE_ADMIN_ROLE
    await rm.setMinDuration(opts.minDuration);
  }
}

async function deploySignedQuoteRM(opts, hre) {
  opts.extraConstructorArgs = [opts.creationIsOpen];
  return deployRiskModule(opts, hre);
}

async function setAssetManager({ reserve, amAddress, liquidityMin, liquidityMiddle, liquidityMax }, hre) {
  const reserveContract = await hre.ethers.getContractAt("Reserve", reserve);
  const tx = await reserveContract.setAssetManager(amAddress, false);
  console.log(`Asset Manager ${amAddress} set to reserve ${reserve}`);
  if (liquidityMin !== undefined || liquidityMiddle !== undefined || liquidityMax !== undefined) {
    liquidityMin = liquidityMin === undefined ? ethers.constants.MaxUint256 : _A(liquidityMin);
    liquidityMiddle = liquidityMiddle === undefined ? ethers.constants.MaxUint256 : _A(liquidityMiddle);
    liquidityMax = liquidityMax === undefined ? ethers.constants.MaxUint256 : _A(liquidityMax);
    const amContract = await hre.ethers.getContractAt(
      "ERC4626AssetManager", // Not relevant if it's ERC4626AssetManager, only need setLiquidityThresholds
      amAddress
    );
    await tx.wait(2); // To make sure the setAssetManager was executed - wait 2 confirmations
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
  ).contract.address;
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
  ).contract.address;
}

async function deployWhitelist(
  { wlClass, poolAddress, extraConstructorArgs, extraArgs, eToken, eToken2, eToken3, ...opts },
  hre
) {
  extraArgs = extraArgs || [];
  extraConstructorArgs = extraConstructorArgs || [];
  const { contract } = await deployProxyContract(
    {
      contractClass: wlClass,
      constructorArgs: [poolAddress, ...extraConstructorArgs],
      initializeArgs: [...extraArgs],
      ...opts,
    },
    hre
  );
  if (eToken !== undefined) {
    const etk = await hre.ethers.getContractAt("EToken", eToken);
    await etk.setWhitelist(contract.address);
  }
  if (eToken2 !== undefined) {
    const etk = await hre.ethers.getContractAt("EToken", eToken2);
    await etk.setWhitelist(contract.address);
  }
  if (eToken3 !== undefined) {
    const etk = await hre.ethers.getContractAt("EToken", eToken3);
    await etk.setWhitelist(contract.address);
  }
  return contract.address;
}

async function trustfullPolicy({ rmAddress, payout, premium, lossProb, expiration, customer }, hre) {
  const rm = await hre.ethers.getContractAt("TrustfulRiskModule", rmAddress);
  const policyPool = await hre.ethers.getContractAt("PolicyPool", await rm.policyPool());
  const access = await hre.ethers.getContractAt("AccessManager", await policyPool.access());
  const currency = await hre.ethers.getContractAt("IERC20Metadata", await policyPool.currency());
  await grantComponentRole(hre, access, rm, "PRICER_ROLE");

  customer = customer || (await _getDefaultSigner(hre));
  premium = _A(premium);

  await currency.approve(policyPool.address, premium);
  lossProb = _W(lossProb);
  if (expiration === undefined) {
    expiration = 3600;
  }
  if (expiration < 1600000000) {
    expiration = Math.round(new Date().getTime() / 1000) + expiration;
  }
  payout = _A(payout);

  const tx = await rm.newPolicy(payout, premium, lossProb, expiration, customer.address, { gasLimit: 999999 });
  console.log(tx);
}

async function resolvePolicy({ rmAddress, payout, fullPayout, policyId }, hre) {
  const rm = await hre.ethers.getContractAt("TrustfulRiskModule", rmAddress);
  const policyPool = await hre.ethers.getContractAt("PolicyPool", await rm.policyPool());
  const access = await hre.ethers.getContractAt("AccessManager", await policyPool.access());
  await grantComponentRole(hre, access, rm, "RESOLVER_ROLE");

  let tx;

  if (fullPayout === undefined) {
    payout = _A(payout);
    tx = await rm.resolvePolicy(policyId, payout);
  } else {
    tx = await rm.resolvePolicyFullPayout(policyId, fullPayout);
  }
  console.log(tx);
}

async function flightDelayPolicy(
  { rmAddress, flight, departure, expectedArrival, tolerance, payout, premium, lossProb, customer },
  hre
) {
  const rm = await hre.ethers.getContractAt("FlightDelayRiskModule", rmAddress);
  const policyPool = await hre.ethers.getContractAt("PolicyPool", await rm.policyPool());
  const access = await hre.ethers.getContractAt("AccessManager", await policyPool.access());
  const currency = await hre.ethers.getContractAt("IERC20Metadata", await policyPool.currency());

  await grantComponentRole(hre, access, rm, "PRICER_ROLE");
  customer = customer || (await _getDefaultSigner(hre));
  premium = _A(premium);

  await currency.approve(policyPool.address, premium);
  lossProb = _W(lossProb);
  payout = _A(payout);

  const tx = await rm.newPolicy(
    flight,
    departure,
    expectedArrival,
    tolerance,
    payout,
    premium,
    lossProb,
    customer.address,
    { gasLimit: 999999 }
  );
  console.log(tx);
}

async function listETokens({ poolAddress }, hre) {
  const policyPool = await hre.ethers.getContractAt("PolicyPool", poolAddress);
  const etkCount = await policyPool.getETokenCount();

  console.log(`Pool has ${etkCount} tokens`);

  for (i = 0; i < etkCount; i++) {
    const etk = await hre.ethers.getContractAt("EToken", await policyPool.getETokenAt(i));
    const etkName = await etk.name();
    console.log(`eToken at ${etk.address}: ${etkName}`);
  }
}

async function deposit({ etkAddress, amount }, hre) {
  const etk = await hre.ethers.getContractAt("EToken", etkAddress);
  const policyPool = await hre.ethers.getContractAt("PolicyPool", await etk.policyPool());
  const currency = await hre.ethers.getContractAt("IERC20Metadata", await policyPool.currency());
  amount = _A(amount);
  await currency.approve(policyPool.address, amount);
  const tx = await policyPool.deposit(etk.address, amount, { gasLimit: 999999 });
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
    .addOptionalParam("accessAddress", "AccessManager Address", undefined, types.address)
    .addParam("treasuryAddress", "Treasury Address", types.address)
    .setAction(async function (taskArgs, hre) {
      if (taskArgs.currencyAddress === undefined) {
        taskArgs.saveAddr = "CURRENCY";
        taskArgs.currencyAddress = await deployTestCurrency(taskArgs, hre);
      }
      if (taskArgs.accessAddress === undefined) {
        taskArgs.saveAddr = "ACCESSMANAGER";
        taskArgs.accessAddress = await deployAccessManager(taskArgs, hre);
      }
      taskArgs.saveAddr = "POOL";
      let policyPoolAddress = await deployPolicyPool(taskArgs, hre);
    });

  task("deploy:testCurrency", "Deploys the Test Currency")
    .addOptionalParam("verify", "Verify contract in Etherscan", false, types.boolean)
    .addOptionalParam("saveAddr", "Save created contract address", "CURRENCY", types.str)
    .addOptionalParam("currName", "Name of Test Currency", "Ensuro Test USD", types.str)
    .addOptionalParam("currSymbol", "Symbol of Test Currency", "EUSD", types.str)
    .addOptionalParam("initialSupply", "Initial supply in the test currency", 2000, types.int)
    .setAction(deployTestCurrency);

  task("deploy:accessManager", "Deploys the AccessManager")
    .addOptionalParam("verify", "Verify contract in Etherscan", false, types.boolean)
    .addOptionalParam("saveAddr", "Save created contract address", "ACCESSMANAGER", types.str)
    .setAction(deployAccessManager);

  task("deploy:pool", "Deploys the PolicyPool")
    .addOptionalParam("verify", "Verify contract in Etherscan", false, types.boolean)
    .addOptionalParam("saveAddr", "Save created contract address", "POOL", types.str)
    .addOptionalParam("nftName", "Name of Policies NFT Token", "Ensuro Policies NFT", types.str)
    .addOptionalParam("nftSymbol", "Symbol of Policies NFT Token", "EPOL", types.str)
    .addOptionalParam("treasuryAddress", "Treasury Address", ethers.constants.AddressZero, types.address)
    .addParam("currencyAddress", "Currency Address", types.address)
    .addParam("accessAddress", "AccessManager Address", types.address)
    .setAction(deployPolicyPool);

  task("deploy:eToken", "Deploy an EToken and adds it to the pool")
    .addOptionalParam("verify", "Verify contract in Etherscan", false, types.boolean)
    .addOptionalParam("saveAddr", "Save created contract address", "ETOKEN", types.str)
    .addOptionalParam("addComponent", "Adds the new component to the pool", true, types.boolean)
    .addParam("poolAddress", "PolicyPool Address", types.address)
    .addParam("etkName", "Name of EToken", types.str)
    .addParam("etkSymbol", "Symbol of EToken", types.str)
    .addOptionalParam("maxUtilizationRate", "Max Utilization Rate", 1.0, types.float)
    .addOptionalParam("poolLoanInterestRate", "Interest rate when pool takes money from eToken", 0.05, types.float)
    .setAction(deployEToken);

  task("deploy:premiumsAccount", "Deploy a premiums account")
    .addOptionalParam("verify", "Verify contract in Etherscan", false, types.boolean)
    .addOptionalParam("saveAddr", "Save created contract address", "PA", types.str)
    .addOptionalParam("addComponent", "Adds the new component to the pool", true, types.boolean)
    .addParam("poolAddress", "PolicyPool Address", types.address)
    .addParam("juniorEtk", "Junior EToken Address", types.address)
    .addParam("seniorEtk", "Senior EToken Address", types.address)
    .setAction(deployPremiumsAccount);

  task("deploy:riskModule", "Deploys a RiskModule and adds it to the pool")
    .addOptionalParam("verify", "Verify contract in Etherscan", false, types.boolean)
    .addOptionalParam("saveAddr", "Save created contract address", "RM", types.str)
    .addOptionalParam("addComponent", "Adds the new component to the pool", true, types.boolean)
    .addParam("poolAddress", "PolicyPool Address", types.address)
    .addParam("paAddress", "PremiumsAccount Address", types.address)
    .addOptionalParam("rmClass", "RiskModule contract", "TrustfulRiskModule", types.str)
    .addOptionalParam("rmName", "Name of the RM", "Test RM", types.str)
    .addOptionalParam("collRatio", "Collateralization ratio", 1.0, types.float)
    .addOptionalParam("jrCollRatio", "Junior Collateralization ratio", 0.0, types.float)
    .addOptionalParam("ensuroPpFee", "Ensuro Pure Premium Fee", 0.02, types.float)
    .addOptionalParam("ensuroCocFee", "Ensuro Coc Fee", 0.1, types.float)
    .addOptionalParam("roc", "Interest rate paid to Senior LPs for solvency capital", 0.05, types.float)
    .addOptionalParam("jrRoc", "Interest rate paid to Junior LPs for solvency capital", 0.0, types.float)
    .addOptionalParam("maxPayoutPerPolicy", "Max Payout Per policy", 10000, types.float)
    .addOptionalParam("exposureLimit", "Exposure (sum of payouts) limit for the RM", 1e6, types.float)
    .addOptionalParam("maxDuration", "Maximum policy duration in hours", 24 * 365, types.int)
    .addOptionalParam("moc", "Margin of Conservativism", 1.0, types.float)
    .addParam("wallet", "RM address", types.address)
    .setAction(deployRiskModule);

  task("deploy:signedQuoteRiskModule", "Deploys a RiskModule and adds it to the pool")
    .addOptionalParam("verify", "Verify contract in Etherscan", false, types.boolean)
    .addOptionalParam("saveAddr", "Save created contract address", "RM", types.str)
    .addOptionalParam("addComponent", "Adds the new component to the pool", true, types.boolean)
    .addParam("poolAddress", "PolicyPool Address", types.address)
    .addParam("paAddress", "PremiumsAccount Address", types.address)
    .addOptionalParam("rmClass", "RiskModule contract", "SignedQuoteRiskModule", types.str)
    .addOptionalParam("rmName", "Name of the RM", "Test RM", types.str)
    .addOptionalParam("collRatio", "Collateralization ratio", 1.0, types.float)
    .addOptionalParam("jrCollRatio", "Junior Collateralization ratio", 0.0, types.float)
    .addOptionalParam("ensuroPpFee", "Ensuro Pure Premium Fee", 0.02, types.float)
    .addOptionalParam("ensuroCocFee", "Ensuro Coc Fee", 0.1, types.float)
    .addOptionalParam("roc", "Interest rate paid to Senior LPs for solvency capital", 0.05, types.float)
    .addOptionalParam("jrRoc", "Interest rate paid to Junior LPs for solvency capital", 0.0, types.float)
    .addOptionalParam("maxPayoutPerPolicy", "Max Payout Per policy", 10000, types.float)
    .addOptionalParam("exposureLimit", "Exposure (sum of payouts) limit for the RM", 1e6, types.float)
    .addOptionalParam("maxDuration", "Maximum policy duration in hours", 24 * 365, types.int)
    .addOptionalParam("moc", "Margin of Conservativism", 1.0, types.float)
    .addOptionalParam("creationIsOpen", "Indicates if anyone can create policies (with a quote)", true, types.boolean)
    .addParam("wallet", "RM address", types.address)
    .setAction(deploySignedQuoteRM);

  task("deploy:priceRiskModule", "Deploys and injects a Price RiskModule")
    .addOptionalParam("verify", "Verify contract in Etherscan", false, types.boolean)
    .addOptionalParam("saveAddr", "Save created contract address", "RM", types.str)
    .addOptionalParam("addComponent", "Adds the new component to the pool", true, types.boolean)
    .addParam("poolAddress", "PolicyPool Address", types.address)
    .addParam("paAddress", "PremiumsAccount Address", types.address)
    .addOptionalParam("rmClass", "RiskModule contract", "PriceRiskModule", types.str)
    .addOptionalParam("rmName", "Name of the RM", "Price Risk Module", types.str)
    .addOptionalParam("collRatio", "Collateralization ratio", 1.0, types.float)
    .addOptionalParam("jrCollRatio", "Junior Collateralization ratio", 0.0, types.float)
    .addOptionalParam("ensuroPpFee", "Ensuro Pure Premium Fee", 0.02, types.float)
    .addOptionalParam("ensuroCocFee", "Ensuro Coc Fee", 0.1, types.float)
    .addOptionalParam("roc", "Interest rate paid to Senior LPs for solvency capital", 0.05, types.float)
    .addOptionalParam("jrRoc", "Interest rate paid to Junior LPs for solvency capital", 0.0, types.float)
    .addOptionalParam("maxPayoutPerPolicy", "Max Payout Per policy", 10000, types.float)
    .addOptionalParam("exposureLimit", "Exposure (sum of payouts) limit for the RM", 1e6, types.float)
    .addOptionalParam("maxDuration", "Maximum policy duration in hours", 24 * 365, types.int)
    .addOptionalParam("moc", "Margin of Conservativism", 1.0, types.float)
    .addParam("wallet", "RM address", types.address)
    .addParam("assetOracle", "Insured asset oracle address", types.address)
    .addOptionalParam("referenceOracle", "Reference currency address", ethers.constants.AddressZero, types.address)
    .addOptionalParam("slotSize", "Slot size", 0.01, types.float)
    .addOptionalParam("oracleTolerance", "Oracle age tolerance", 1800, types.int)
    .addOptionalParam("minDuration", "Minimum time that must elapse before a policy can be triggered", 3600, types.int)
    .setAction(deployPriceRM);

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
    .addParam("poolAddress", "PolicyPool Address", types.address)
    .setAction(deployWhitelist);

  task("ens:trustfullPolicy", "Creates a TrustfulRiskModule Policy")
    .addParam("rmAddress", "RiskModule address", types.address)
    .addParam("payout", "Payout for customer in case policy is triggered", undefined, types.int)
    .addParam("premium", "Premium the customer pays", undefined, types.int)
    .addParam("lossProb", "Probability of policy being triggered", undefined, types.float)
    .addOptionalParam("expiration", "Expiration of the policy (relative or absolute)", undefined, types.int)
    .addOptionalParam("customer", "Customer", undefined, types.address)
    .setAction(trustfullPolicy);

  task("ens:resolvePolicy", "Resolves a TrustfulRiskModule Policy")
    .addParam("rmAddress", "RiskModule address", types.address)
    .addParam("policyId", "Id of the policy", undefined, types.int)
    .addOptionalParam("payout", "Payout for customer in case policy is triggered", undefined, types.int)
    .addOptionalParam("fullPayout", "Full payout or not", undefined, types.boolean)
    .setAction(resolvePolicy);

  task("ens:flightDelayPolicy", "Creates a Flight Delay Policy")
    .addParam("rmAddress", "RiskModule address", types.address)
    .addParam("flight", "Flight Number as String (ex: NAX105)", types.str)
    .addParam("departure", "Departure in epoch seconds (ex: 1631817600)", undefined, types.int)
    .addParam("expectedArrival", "Expected arrival in epoch seconds (ex: 1631824800)", undefined, types.int)
    .addOptionalParam(
      "tolerance",
      "In seconds, the tolerance margin after expectedArrival before trigger the policy",
      12 * 3600,
      types.int
    )
    .addParam("payout", "Payout for customer in case policy is triggered", undefined, types.int)
    .addParam("premium", "Premium the customer pays", undefined, types.int)
    .addParam("lossProb", "Probability of policy being triggered", undefined, types.float)
    .addOptionalParam("customer", "Customer", undefined, types.address)
    .setAction(flightDelayPolicy);

  task("ens:listETokens", "Lists eTokens")
    .addParam("poolAddress", "PolicyPool Address", types.address)
    .setAction(listETokens);

  task("ens:deposit", "Deposits in a given eToken")
    .addParam("etkAddress", "EToken address", types.address)
    .addParam("amount", "Amount to Deposit", undefined, types.int)
    .setAction(deposit);

  task("ens:grantRole", "Grants a given role")
    .addParam("contractAddress", "Contract", undefined, types.address)
    .addParam("role", "Role", types.str)
    .addOptionalParam("account", "Account", undefined, types.address)
    .addOptionalParam(
      "component",
      "Address of the component if it's a component role",
      ethers.constants.AddressZero,
      types.address
    )
    .setAction(grantRoleTask);
}

module.exports = {
  add_task,
  saveAddress,
  logContractCreated,
  deployContract,
  deployProxyContract,
  grantRole,
  grantComponentRole,
  deployRiskModule,
  deploySignedQuoteRM,
  setAssetManager,
  deployWhitelist,
};
