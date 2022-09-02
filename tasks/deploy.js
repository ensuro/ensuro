const upgrades_core = require('@openzeppelin/upgrades-core');
const fs = require('fs');

const ethers = require("ethers");

const _BN = ethers.BigNumber.from;
const WAD = _BN(1e10).mul(_BN(1e8));  // 1e10*1e8=1e18
const RAY = WAD.mul(_BN(1e9));  // 1e18*1e9=1e27


function _W(value) {
  if (!Number.isInteger(value))
    return _BN(value * 1e10).mul(_BN(1e8));
  return _BN(value).mul(WAD);
}

function _R(value) {
  if (!Number.isInteger(value))
    return _BN(Math.round(value * 1e9)).mul(WAD);
  return _BN(value).mul(RAY);
}

function amountDecimals() {
  let decimals = Number.parseInt(process.env.DEPLOY_AMOUNT_DECIMALS);
  console.assert(decimals >= 6);
  return decimals;
}

function _A(value) {
  // Decimals must be at least 6
  if (typeof value === 'string' || value instanceof String) {
    return _BN(value).mul(_BN(Math.pow(10, amountDecimals())));
  } else {
    return _BN(Math.round(value * 1e6)).mul(_BN(Math.pow(10, amountDecimals() - 6)));
  }
}

function saveAddress(name, address) {
  if (!name || name === "") return;
  let addresses;
  try {
    addresses = JSON.parse(fs.readFileSync(".addresses.json"));
  } catch (err){
    console.log("Error reading .addresses.json", err);
    addresses = {};
  }
  addresses[name] = address;
  fs.writeFileSync(".addresses.json", JSON.stringify(addresses));
}

async function etherscanEndpoints(hre) {
  try{
    return await hre.run("verify:get-etherscan-endpoint", {
      provider: hre.network.provider, networkName: hre.network.name
    });
  } catch (error) {
    return {};
  }
}

async function logContractCreated(hre, contractName, address) {
  const browserUrl = (await etherscanEndpoints(hre)).browserURL;
  if (browserUrl) {
    console.log(`${contractName} deployed to: ${browserUrl}/address/${address}`);
  } else {
    console.log(`${contractName} deployed to: ${address}`);
  }
}

async function verifyContract(hre, contract, isProxy, constructorArguments) {
  if (isProxy === undefined)
    isProxy = false;
  if (constructorArguments === undefined)
    constructorArguments = [];
  let address = contract.address;
  if (isProxy)
    address = await upgrades_core.getImplementationAddress(hre.network.provider, address);
  try{
    await hre.run("verify:verify", {
      address: address,
      constructorArguments: constructorArguments,
    });
    const etherscanURL = (await etherscanEndpoints(hre)).browserURL;
    if (isProxy && etherscanURL) {
      console.log(
        "Contract successfully verified, you should verify the proxy at " +
        `${etherscanURL}/proxyContractChecker?a=${contract.address}`
      );
    }
  } catch (error) {
    console.log("Error verifying contract", error);
  }
}

async function grantComponentRole(hre, contract, component, role, user) {
  let userAddress;
  if (user === undefined) {
    user = await _getDefaultSigner(hre);
    userAddress = user.address;
  } else {
    userAddress = user;
  }
  const roleHex = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(role));
  const componentRole = await contract.getComponentRole(component.address, roleHex);
  if (!await contract.hasRole(componentRole, userAddress)) {
    await contract.grantComponentRole(component.address, roleHex, userAddress);
    console.log(`Role ${role} (${roleHex}) Component ${component.address} granted to ${userAddress}`);
  } else {
    console.log(
      `Role ${role} (${roleHex}) Component ${component.address} already granted to ${userAddress}`
    );
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
  const roleHex = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(role));
  if (!await contract.hasRole(roleHex, userAddress)) {
    await contract.grantRole(roleHex, userAddress);
    console.log(`Role ${role} (${roleHex}) granted to ${userAddress}`);
  } else {
    console.log(`Role ${role} (${roleHex}) already granted to ${userAddress}`);
  }
}

async function grantRoleTask({contractAddress, role, account, component}, hre) {
  const contract = await hre.ethers.getContractAt("AccessManager", contractAddress);
  if (component === ethers.constants.AddressZero) {
    await grantRole(hre, contract, role, account);
  } else {
    await grantComponentRole(hre, contract, component, role, account);
  }
}

async function deployTestCurrency({saveAddr, verify, currName, currSymbol, initialSupply}, hre) {
  const TestCurrency = await hre.ethers.getContractFactory("TestCurrency");
  const currency = await TestCurrency.deploy(
    currName, currSymbol, _A(initialSupply), amountDecimals()
  );
  await currency.deployed();
  await logContractCreated(hre, "TestCurrency", currency.address);
  saveAddress(saveAddr, currency.address);
  console.log(`TestCurrency created with ${amountDecimals()} decimals`);
  if (verify)
    await verifyContract(hre, currency, false, [
      currName, currSymbol, _A(initialSupply), amountDecimals()
    ]);
  return currency.address;
}

async function deployPolicyNFT({saveAddr, verify, nftName, nftSymbol, policyPoolDetAddress}, hre) {
  const PolicyNFT = await hre.ethers.getContractFactory("PolicyNFT");
  const policyNFT = await hre.upgrades.deployProxy(
    PolicyNFT,
    [nftName, nftSymbol, policyPoolDetAddress || ethers.constants.AddressZero],
    {kind: 'uups'}
  );
  await policyNFT.deployed();
  await logContractCreated(hre, "PolicyNFT", policyNFT.address);
  saveAddress(saveAddr, policyNFT.address);
  if (verify)
    await verifyContract(hre, policyNFT, true);
  return policyNFT.address;
}

async function deployAccessManager({saveAddr, verify}, hre) {
  const AccessManager = await hre.ethers.getContractFactory("AccessManager");
  const policyPoolConfig = await hre.upgrades.deployProxy(AccessManager, [], {kind: 'uups'});

  await policyPoolConfig.deployed();
  await logContractCreated(hre, "AccessManager", policyPoolConfig.address);
  saveAddress(saveAddr, policyPoolConfig.address);
  if (verify)
    await verifyContract(hre, policyPoolConfig, true);
  return policyPoolConfig.address;
}

async function _getDefaultSigner(hre) {
  const signers = await hre.ethers.getSigners();
  return signers[0];
}

async function deployPolicyPool({saveAddr, verify, accessAddress, nftAddress,
                                 currencyAddress, treasuryAddress}, hre) {
  const PolicyPool = await hre.ethers.getContractFactory("PolicyPool");
  const policyPool = await hre.upgrades.deployProxy(PolicyPool, [treasuryAddress], {
    constructorArgs: [accessAddress, nftAddress, currencyAddress],
    kind: 'uups',
    unsafeAllow: ["delegatecall"],
  });

  await policyPool.deployed();
  await logContractCreated(hre, "PolicyPool", policyPool.address);
  saveAddress(saveAddr, policyPool.address);

  if (verify)
    await verifyContract(hre, policyPool, true, [accessAddress, nftAddress, currencyAddress]);

  const policyPoolConfig = await hre.ethers.getContractAt("AccessManager", await policyPool.access());
  await grantRole(hre, policyPoolConfig, "LEVEL1_ROLE");
  await grantRole(hre, policyPoolConfig, "LEVEL2_ROLE");
  await grantRole(hre, policyPoolConfig, "LEVEL3_ROLE");
  return policyPool.address;
}

async function deployEToken({
      saveAddr, verify, poolAddress, etkName, etkSymbol,
      maxUtilizationRate, poolLoanInterestRate
  }, hre) {
  const EToken = await hre.ethers.getContractFactory("EToken");
  const etoken = await hre.upgrades.deployProxy(EToken, [
    etkName,
    etkSymbol,
    _W(maxUtilizationRate),
    _W(poolLoanInterestRate),
  ], {
    kind: 'uups',
    constructorArgs: [poolAddress],
    unsafeAllow: ["delegatecall"],
  });

  await etoken.deployed();
  await logContractCreated(hre, `EToken ${etkName}`, etoken.address);
  saveAddress(saveAddr, etoken.address);
  if (verify)
    await verifyContract(hre, etoken, true, [poolAddress]);
  const policyPool = await hre.ethers.getContractAt("PolicyPool", poolAddress);
  await policyPool.addEToken(etoken.address);
  return etoken.address;
}

async function deployPremiumsAccount({saveAddr, verify, poolAddress, juniorEtk, seniorEtk}, hre) {
  const PremiumsAccount = await hre.ethers.getContractFactory("PremiumsAccount");
  const pa = await hre.upgrades.deployProxy(PremiumsAccount, [], {
    kind: 'uups',
    unsafeAllow: ["delegatecall"],
    constructorArgs: [poolAddress, juniorEtk, seniorEtk],
  });

  await pa.deployed();
  await logContractCreated(hre, `PremiumsAccount`, pa.address);
  saveAddress(saveAddr, pa.address);
  if (verify)
    await verifyContract(hre, pa, true, [poolAddress]);
  return pa.address;
}

async function deployRiskModule({
      saveAddr, verify, rmClass, rmName, poolAddress, paAddress, collRatio, roc,
      ensuroPpFee, ensuroCocFee,
      maxPayoutPerPolicy,
      exposureLimit, moc, wallet, extraArgs, extraConstructorArgs
  }, hre) {
  extraArgs = extraArgs || [];
  extraConstructorArgs = extraConstructorArgs || [];
  const RiskModule = await hre.ethers.getContractFactory(rmClass);
  const rm = await hre.upgrades.deployProxy(RiskModule, [
    rmName,
    _W(collRatio),
    _W(ensuroPpFee),
    _W(roc),
    _A(maxPayoutPerPolicy),
    _A(exposureLimit),
    wallet,
    ...extraArgs
  ], {
    kind: 'uups',
    unsafeAllow: ["delegatecall"],
    constructorArgs: [poolAddress, paAddress, ...extraConstructorArgs]
  });

  await rm.deployed();
  await logContractCreated(hre, `${rmClass} ${rmName}`, rm.address);
  saveAddress(saveAddr, rm.address);
  if (verify)
    await verifyContract(hre, rm, true, [poolAddress, ...extraConstructorArgs]);

  if (moc != 1.0) {
    moc = _W(moc);
    await rm.setParam(0, moc);
  }
  if (ensuroCocFee != 0) {
    ensuroCocFee = _W(ensuroCocFee);
    await rm.setParam(4, ensuroCocFee);
  }
  const policyPool = await hre.ethers.getContractAt("PolicyPool", poolAddress);
  await policyPool.addRiskModule(rm.address);
  return rm.address;
}

async function deployFlightDelayRM(opts, hre) {
  opts.extraArgs = [
    opts.linkToken,
    [opts.oracle, opts.delayTime, _W(opts.oracleFee), opts.dataJobId, opts.sleepJobId]
  ];
  return deployRiskModule(opts, hre);
}

async function deployPriceRM(opts, hre) {
  opts.extraConstructorArgs = [
    opts.asset, opts.referenceCurrency, _W(opts.slotSize)
  ];
  return deployRiskModule(opts, hre);
}

async function deployAssetManager({
      saveAddr, verify, amClass, poolAddress, liquidityMin, liquidityMiddle, liquidityMax,
      extraConstructorArgs, extraArgs}, hre) {
  extraArgs = extraArgs || [];
  extraConstructorArgs = extraConstructorArgs || [];
  const AssetManager = await hre.ethers.getContractFactory(amClass);
  const am = await hre.upgrades.deployProxy(AssetManager, [
    _A(liquidityMin),
    _A(liquidityMiddle),
    _A(liquidityMax),
    ...extraArgs
  ], {
    kind: 'uups',
    unsafeAllow: ["delegatecall"],
    constructorArgs: [poolAddress, ...extraConstructorArgs]
  });

  await am.deployed();
  await logContractCreated(hre, `${amClass}`, am.address);
  saveAddress(saveAddr, am.address);
  if (verify)
    await verifyContract(hre, am, true, [poolAddress, ...extraConstructorArgs]);
  const policyPool = await hre.ethers.getContractAt("PolicyPool", poolAddress);
  const policyPoolConfig = await hre.ethers.getContractAt("AccessManager", await policyPool.access());
  await policyPoolConfig.setAssetManager(am.address);
  return am.address;
}

async function deployFixedIntestRateAssetManager(opts, hre) {
  opts.extraArgs = [
    _R(opts.interestRate)
  ];
  return deployAssetManager(opts, hre);
}

async function deployAaveAssetManager(opts, hre) {
  opts.extraArgs = [
    _W(opts.claimRewardsMin),
    _W(opts.reinvestRewardsMin),
  ];
  opts.extraConstructorArgs = [
    opts.aaveAddrProv,
  ]
  return deployAssetManager(opts, hre);
}

async function deployExchange({saveAddr, verify, poolAddress, maxSlippage, swapRouter, priceOracle}, hre) {
  const Exchange = await hre.ethers.getContractFactory("Exchange");
  const exchange = await hre.upgrades.deployProxy(Exchange, [
    priceOracle,
    swapRouter,
    _W(maxSlippage)
  ], {
    kind: 'uups',
    unsafeAllow: ["delegatecall"],
    constructorArgs: [poolAddress]
  });

  await exchange.deployed();
  await logContractCreated(hre, "Exchange", exchange.address);
  saveAddress(saveAddr, exchange.address);
  if (verify)
    await verifyContract(hre, exchange, true, [poolAddress]);
  const policyPool = await hre.ethers.getContractAt("PolicyPool", poolAddress);
  const policyPoolConfig = await hre.ethers.getContractAt("AccessManager", await policyPool.access());
  await policyPoolConfig.setExchange(exchange.address);
  return exchange.address;
}

async function deployWhitelist({saveAddr, verify, wlClass, poolAddress, extraConstructorArgs,
                                extraArgs, eToken}, hre) {
  extraArgs = extraArgs || [];
  extraConstructorArgs = extraConstructorArgs || [];
  const Whitelist = await hre.ethers.getContractFactory(wlClass);
  const wl = await hre.upgrades.deployProxy(Whitelist, [
    ...extraArgs
  ], {
    kind: 'uups',
    unsafeAllow: ["delegatecall"],
    constructorArgs: [poolAddress, ...extraConstructorArgs]
  });

  await wl.deployed();
  await logContractCreated(hre, `${wlClass}`, wl.address);
  saveAddress(saveAddr, wl.address);
  if (verify)
    await verifyContract(hre, wl, true, [poolAddress, ...extraConstructorArgs]);
  if (eToken !== undefined) {
    const etk = await hre.ethers.getContractAt("EToken", eToken);
    await etk.setWhitelist(wl.address);
  }
  return wl.address;
}

async function trustfullPolicy({rmAddress, payout, premium, lossProb, expiration, customer}, hre) {
  const rm = await hre.ethers.getContractAt("TrustfulRiskModule", rmAddress);
  const policyPool = await hre.ethers.getContractAt("PolicyPool", await rm.policyPool());
  const access = await hre.ethers.getContractAt("AccessManager", await policyPool.access());
  const currency = await hre.ethers.getContractAt("IERC20Metadata", await policyPool.currency());
  await grantComponentRole(hre, access, rm, "PRICER_ROLE");

  customer = customer || await _getDefaultSigner(hre);
  premium = _A(premium);

  await currency.approve(policyPool.address, premium);
  lossProb = _W(lossProb);
  if (expiration === undefined) {
    expiration = 3600;
  }
  if (expiration < 1600000000) {
    expiration = Math.round((new Date()).getTime() / 1000) + expiration;
  }
  payout = _A(payout);

  const tx = await rm.newPolicy(payout, premium, lossProb, expiration, customer.address, {gasLimit: 999999});
  console.log(tx);
}

async function resolvePolicy({rmAddress, payout, fullPayout, policyId}, hre) {
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

async function flightDelayPolicy({rmAddress, flight, departure, expectedArrival, tolerance, payout, premium,
                             lossProb, customer}, hre) {
  const rm = await hre.ethers.getContractAt("FlightDelayRiskModule", rmAddress);
  const policyPool = await hre.ethers.getContractAt("PolicyPool", await rm.policyPool());
  const access = await hre.ethers.getContractAt("AccessManager", await policyPool.access());
  const currency = await hre.ethers.getContractAt("IERC20Metadata", await policyPool.currency());

  await grantComponentRole(hre, access, rm, "PRICER_ROLE");
  customer = customer || await _getDefaultSigner(hre);
  premium = _A(premium);

  await currency.approve(policyPool.address, premium);
  lossProb = _W(lossProb);
  payout = _A(payout);

  const tx = await rm.newPolicy(
    flight, departure, expectedArrival, tolerance, payout,
    premium, lossProb, customer.address,
    {gasLimit: 999999}
  );
  console.log(tx);
}

async function listETokens({poolAddress}, hre) {
  const policyPool = await hre.ethers.getContractAt("PolicyPool", poolAddress);
  const etkCount = await policyPool.getETokenCount();

  console.log(`Pool has ${etkCount} tokens`);

  for (i=0; i < etkCount; i++) {
    const etk = await hre.ethers.getContractAt("EToken", await policyPool.getETokenAt(i));
    const etkName = await etk.name();
    console.log(`eToken at ${etk.address}: ${etkName}`);
  }
}

async function deposit({etkAddress, amount}, hre) {
  const etk = await hre.ethers.getContractAt("EToken", etkAddress);
  const policyPool = await hre.ethers.getContractAt("PolicyPool", await etk.policyPool());
  const currency = await hre.ethers.getContractAt("IERC20Metadata", await policyPool.currency());
  amount = _A(amount);
  await currency.approve(policyPool.address, amount);
  const tx = await policyPool.deposit(etk.address, amount, {gasLimit: 999999});
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
    .addOptionalParam("nftAddress", "NFT Address", undefined, types.address)
    .addOptionalParam("currencyAddress", "Currency Address", undefined, types.address)
    .addOptionalParam("accessAddress", "AccessManager Address", undefined, types.address)
    .addOptionalParam("treasuryAddress", "Treasury Address", ethers.constants.AddressZero, types.address)
    .setAction(async function(taskArgs, hre) {
      if (taskArgs.currencyAddress === undefined) {
        taskArgs.saveAddr = "CURRENCY";
        taskArgs.currencyAddress = await deployTestCurrency(taskArgs, hre);
      }
      if (taskArgs.nftAddress === undefined) {
        taskArgs.saveAddr = "POLICYNFT";
        taskArgs.nftAddress = await deployPolicyNFT(taskArgs, hre);
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

  task("deploy:policyNFT", "Deploys the Policies NFT")
    .addOptionalParam("verify", "Verify contract in Etherscan", false, types.boolean)
    .addOptionalParam("saveAddr", "Save created contract address", "POLICYNFT", types.str)
    .addOptionalParam("nftName", "Name of Policies NFT Token", "Ensuro Policies NFT", types.str)
    .addOptionalParam("nftSymbol", "Symbol of Policies NFT Token", "EPOL", types.str)
    .setAction(deployPolicyNFT);

  task("deploy:accessManager", "Deploys the AccessManager")
    .addOptionalParam("verify", "Verify contract in Etherscan", false, types.boolean)
    .addOptionalParam("saveAddr", "Save created contract address", "ACCESSMANAGER", types.str)
    .setAction(deployAccessManager);

  task("deploy:pool", "Deploys the PolicyPool")
    .addOptionalParam("verify", "Verify contract in Etherscan", false, types.boolean)
    .addOptionalParam("saveAddr", "Save created contract address", "POOL", types.str)
    .addOptionalParam("treasuryAddress", "Treasury Address", ethers.constants.AddressZero, types.address)
    .addParam("nftAddress", "NFT Address", types.address)
    .addParam("currencyAddress", "Currency Address", types.address)
    .addParam("accessAddress", "AccessManager Address", types.address)
    .setAction(deployPolicyPool);

  task("deploy:eToken", "Deploy an EToken and adds it to the pool")
    .addOptionalParam("verify", "Verify contract in Etherscan", false, types.boolean)
    .addOptionalParam("saveAddr", "Save created contract address", "ETOKEN", types.str)
    .addParam("poolAddress", "PolicyPool Address", types.address)
    .addOptionalParam("etkName", "Name of EToken", "eUSD1WEEK", types.str)
    .addOptionalParam("etkSymbol", "Symbol of EToken", "eUSD1W", types.str)
    .addOptionalParam("maxUtilizationRate", "Max Utilization Rate", 1.0, types.float)
    .addOptionalParam("poolLoanInterestRate", "Interest rate when pool takes money from eToken",
                      .05, types.float)
    .setAction(deployEToken);

  task("deploy:premiumsAccount", "Deploy a premiums account")
    .addOptionalParam("verify", "Verify contract in Etherscan", false, types.boolean)
    .addOptionalParam("saveAddr", "Save created contract address", "PA", types.str)
    .addParam("poolAddress", "PolicyPool Address", types.address)
    .addParam("juniorEtk", "Junior EToken Address", types.address)
    .addParam("seniorEtk", "Senior EToken Address", types.address)
    .setAction(deployPremiumsAccount);

  task("deploy:riskModule", "Deploys a RiskModule and adds it to the pool")
    .addOptionalParam("verify", "Verify contract in Etherscan", false, types.boolean)
    .addOptionalParam("saveAddr", "Save created contract address", "RM", types.str)
    .addParam("poolAddress", "PolicyPool Address", types.address)
    .addParam("paAddress", "PremiumsAccount Address", types.address)
    .addOptionalParam("rmClass", "RiskModule contract", "TrustfulRiskModule", types.str)
    .addOptionalParam("rmName", "Name of the RM", "Test RM", types.str)
    .addOptionalParam("collRatio", "Collateralization ratio", 1.0, types.float)
    .addOptionalParam("ensuroPpFee", "Ensuro Pure Premium Fee", 0.02, types.float)
    .addOptionalParam("ensuroCocFee", "Ensuro Coc Fee", 0.1, types.float)
    .addOptionalParam("roc", "Interest rate paid to LPs for solvency capital", 0.05, types.float)
    .addOptionalParam("maxPayoutPerPolicy", "Max Payout Per policy", 10000, types.float)
    .addOptionalParam("exposureLimit", "Exposure (sum of payouts) limit for the RM", 1e6, types.float)
    .addOptionalParam("moc", "Margin of Conservativism", 1.0, types.float)
    .addParam("wallet", "RM address", types.address)
    .setAction(deployRiskModule);

  task("deploy:fdRiskModule", "Deploys and injects a Flight Delay RiskModule")
    .addOptionalParam("verify", "Verify contract in Etherscan", false, types.boolean)
    .addOptionalParam("saveAddr", "Save created contract address", "FDRM", types.str)
    .addParam("poolAddress", "PolicyPool Address", types.address)
    .addParam("paAddress", "PremiumsAccount Address", types.address)
    .addOptionalParam("rmClass", "RiskModule contract", "FlightDelayRiskModule", types.str)
    .addOptionalParam("rmName", "Name of the RM", "Flight Delay Risk Module", types.str)
    .addOptionalParam("collRatio", "Collateralization ratio", 1.0, types.float)
    .addOptionalParam("ensuroPpFee", "Ensuro Pure Premium Fee", 0.02, types.float)
    .addOptionalParam("ensuroCocFee", "Ensuro Coc Fee", 0.1, types.float)
    .addOptionalParam("roc", "Interest rate paid to LPs for solvency capital", 0.05, types.float)
    .addOptionalParam("maxPayoutPerPolicy", "Max Payout Per policy", 10000, types.float)
    .addOptionalParam("exposureLimit", "Exposure (sum of payouts) limit for the RM", 1e6, types.float)
    .addOptionalParam("moc", "Margin of Conservativism", 1.0, types.float)
    .addParam("wallet", "RM address", types.address)
    .addParam("linkToken", "LINK address", types.address)
    .addParam("oracle", "Oracle address", types.address)
    .addOptionalParam("oracleFee", "Oracle Fee", 0.1, types.float)
    .addOptionalParam("delayTime", "Delay time", 120, types.int)
    .addOptionalParam("dataJobId", "Data JobId", "0x2fb0c3a36f924e4ab43040291e14e0b7", types.str)
    .addOptionalParam("sleepJobId", "Sleep JobId", "0x4241bd0288324bf8a2c683833d0b824f", types.str)
    .setAction(deployFlightDelayRM);

  task("deploy:priceRiskModule", "Deploys and injects a Price RiskModule")
    .addOptionalParam("verify", "Verify contract in Etherscan", false, types.boolean)
    .addOptionalParam("saveAddr", "Save created contract address", "PRM", types.str)
    .addParam("poolAddress", "PolicyPool Address", types.address)
    .addParam("paAddress", "PremiumsAccount Address", types.address)
    .addOptionalParam("rmClass", "RiskModule contract", "PriceRiskModule", types.str)
    .addOptionalParam("rmName", "Name of the RM", "Price Risk Module", types.str)
    .addOptionalParam("collRatio", "Collateralization ratio", 1.0, types.float)
    .addOptionalParam("ensuroPpFee", "Ensuro Pure Premium Fee", 0.02, types.float)
    .addOptionalParam("ensuroCocFee", "Ensuro Coc Fee", 0.1, types.float)
    .addOptionalParam("roc", "Interest rate paid to LPs for solvency capital", 0.05, types.float)
    .addOptionalParam("maxPayoutPerPolicy", "Max Payout Per policy", 10000, types.float)
    .addOptionalParam("exposureLimit", "Exposure (sum of payouts) limit for the RM", 1e6, types.float)
    .addOptionalParam("moc", "Margin of Conservativism", 1.0, types.float)
    .addParam("wallet", "RM address", types.address)
    .addParam("asset", "Insured asset address", types.address)
    .addParam("referenceCurrency", "Reference currency address", types.address)
    .addOptionalParam("slotSize", "Slot size", 0.01, types.float)
    .setAction(deployPriceRM);

  task("deploy:assetManager", "Deploys a AssetManager and assigns it to the pool")
    .addOptionalParam("verify", "Verify contract in Etherscan", false, types.boolean)
    .addOptionalParam("saveAddr", "Save created contract address", "ASSETMANAGER", types.str)
    .addParam("poolAddress", "PolicyPool Address", types.address)
    .addOptionalParam("rmClass", "AssetManager contract", "FixedRateAssetManager", types.str)
    .addOptionalParam("liquidityMin", "liquidityMin", 100, types.float)
    .addOptionalParam("liquidityMiddle", "liquidityMiddle", 150, types.float)
    .addOptionalParam("liquidityMax", "liquidityMax", 200, types.float)
    .setAction(deployAssetManager);

  task("deploy:fixedInterestAssetManager", "Deploys a FixedRateAssetManager")
    .addOptionalParam("verify", "Verify contract in Etherscan", false, types.boolean)
    .addParam("poolAddress", "PolicyPool Address", types.address)
    .addOptionalParam("amClass", "AssetManager contract", "FixedRateAssetManager", types.str)
    .addOptionalParam("liquidityMin", "liquidityMin", 100, types.float)
    .addOptionalParam("liquidityMiddle", "liquidityMiddle", 150, types.float)
    .addOptionalParam("liquidityMax", "liquidityMax", 200, types.float)
    .addOptionalParam("interestRate", "interestRate", 0.10, types.float)
    .setAction(deployFixedIntestRateAssetManager);

  task("deploy:aaveAssetManager", "Deploys a AaveAssetManager")
    .addOptionalParam("verify", "Verify contract in Etherscan", false, types.boolean)
    .addParam("poolAddress", "PolicyPool Address", types.address)
    .addOptionalParam("amClass", "AssetManager contract", "AaveAssetManager", types.str)
    .addOptionalParam("liquidityMin", "liquidityMin", 100, types.float)
    .addOptionalParam("liquidityMiddle", "liquidityMiddle", 150, types.float)
    .addOptionalParam("liquidityMax", "liquidityMax", 200, types.float)
    .addOptionalParam("claimRewardsMin", "claimRewardsMin", 10, types.float)
    .addOptionalParam("reinvestRewardsMin", "reinvestRewardsMin", 20, types.float)
    .addOptionalParam("aaveAddrProv", "AAVE Address Provider",
                      "0xd05e3E715d945B59290df0ae8eF85c1BdB684744", types.address)
    .setAction(deployAaveAssetManager);

  task("deploy:exchange", "Deploy the Exchange")
    .addOptionalParam("verify", "Verify contract in Etherscan", false, types.boolean)
    .addOptionalParam("saveAddr", "Save created contract address", "EXCHANGE", types.str)
    .addParam("poolAddress", "PolicyPool Address", types.address)
    .addOptionalParam("maxSlippage", "maxSlippage", 0.02, types.float)
    .addOptionalParam("priceOracle", "Price Oracle",
                      "0x0229f777b0fab107f9591a41d5f02e4e98db6f2d", types.address)
    .addOptionalParam("swapRouter", "Uniswap Router Address",
                      "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506", types.address)
    .setAction(deployExchange);

  task("deploy:whitelist", "Deploys a Whitelisting contract")
    .addOptionalParam("verify", "Verify contract in Etherscan", false, types.boolean)
    .addOptionalParam("saveAddr", "Save created contract address", "WHITELIST", types.str)
    .addOptionalParam("wlClass", "Whitelisting contract", "LPManualWhitelist", types.str)
    .addOptionalParam("eToken", "Set the Whitelist to a given eToken", undefined, types.address)
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
    .addOptionalParam("tolerance",
      "In seconds, the tolerance margin after expectedArrival before trigger the policy", 12 * 3600,
      types.int)
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
    .addParam("account", "Account", undefined, types.address)
    .addOptionalParam("component", "Address of the component if it's a component role",
                      ethers.constants.AddressZero, types.address)
    .setAction(grantRoleTask);
}

module.exports = {add_task};
