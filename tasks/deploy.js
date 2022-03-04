const upgrades_core = require('@openzeppelin/upgrades-core');

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

async function grantRoleTask({contractAddress, role, account}, hre) {
  const contract = await hre.ethers.getContractAt("PolicyPoolConfig", contractAddress);
  await grantRole(hre, contract, role, account);
}

async function deployTestCurrency({verify, currName, currSymbol, initialSupply}, hre) {
  const TestCurrency = await hre.ethers.getContractFactory("TestCurrency");
  const currency = await TestCurrency.deploy(
    currName, currSymbol, _A(initialSupply), amountDecimals()
  );
  await currency.deployed();
  await logContractCreated(hre, "TestCurrency", currency.address);
  console.log(`TestCurrency created with ${amountDecimals()} decimals`);
  if (verify)
    await verifyContract(hre, currency, false, [
      currName, currSymbol, _A(initialSupply), amountDecimals()
    ]);
  return currency.address;
}

async function deployPolicyNFT({verify, nftName, nftSymbol, policyPoolDetAddress}, hre) {
  const PolicyNFT = await hre.ethers.getContractFactory("PolicyNFT");
  const policyNFT = await hre.upgrades.deployProxy(
    PolicyNFT,
    [nftName, nftSymbol, policyPoolDetAddress || ethers.constants.AddressZero],
    {kind: 'uups'}
  );
  await policyNFT.deployed();
  await logContractCreated(hre, "PolicyNFT", policyNFT.address);
  if (verify)
    await verifyContract(hre, policyNFT, true);
  return policyNFT.address;
}

async function deployPolicyPoolConfig({verify, treasuryAddress, policyPoolDetAddress}, hre) {
  const PolicyPoolConfig = await hre.ethers.getContractFactory("PolicyPoolConfig");
  const policyPoolConfig = await hre.upgrades.deployProxy(PolicyPoolConfig, [
    policyPoolDetAddress || ethers.constants.AddressZero,
    treasuryAddress,
  ], {kind: 'uups'});

  await policyPoolConfig.deployed();
  await logContractCreated(hre, "PolicyPoolConfig", policyPoolConfig.address);
  if (verify)
    await verifyContract(hre, policyPoolConfig, true);
  return policyPoolConfig.address;
}

async function _getDefaultSigner(hre) {
  const signers = await hre.ethers.getSigners();
  return signers[0];
}

async function deployPolicyPool({verify, configAddress, nftAddress, currencyAddress}, hre) {
  const PolicyPool = await hre.ethers.getContractFactory("PolicyPool");
  const policyPool = await hre.upgrades.deployProxy(PolicyPool, [], {
    constructorArgs: [configAddress, nftAddress, currencyAddress],
    kind: 'uups',
    unsafeAllow: ["delegatecall"],
  });

  await policyPool.deployed();
  await logContractCreated(hre, "PolicyPool", policyPool.address);

  if (verify)
    await verifyContract(hre, policyPool, true, [configAddress, nftAddress, currencyAddress]);

  const policyPoolConfig = await hre.ethers.getContractAt("PolicyPoolConfig", await policyPool.config());
  await grantRole(hre, policyPoolConfig, "LEVEL1_ROLE");
  await grantRole(hre, policyPoolConfig, "LEVEL2_ROLE");
  await grantRole(hre, policyPoolConfig, "LEVEL3_ROLE");
  return policyPool.address;
}

async function deployEToken({
      verify, poolAddress, etkName, etkSymbol, expirationPeriod, liquidityRequirement,
      maxUtilizationRate, poolLoanInterestRate
  }, hre) {
  const EToken = await hre.ethers.getContractFactory("EToken");
  const etoken = await hre.upgrades.deployProxy(EToken, [
    etkName,
    etkSymbol,
    expirationPeriod * 24 * 3600,
    _R(liquidityRequirement),
    _R(maxUtilizationRate),
    _R(poolLoanInterestRate),
  ], {
    kind: 'uups',
    constructorArgs: [poolAddress],
  });

  await etoken.deployed();
  await logContractCreated(hre, `EToken ${etkName}`, etoken.address);
  if (verify)
    await verifyContract(hre, etoken, true, [poolAddress]);
  const policyPool = await hre.ethers.getContractAt("PolicyPool", poolAddress);
  await policyPool.addEToken(etoken.address);
  return etoken.address;
}

async function deployRiskModule({
      verify, rmClass, rmName, poolAddress, scrPercentage, scrInterestRate, ensuroFee, maxScrPerPolicy,
      scrLimit, moc, wallet, extraArgs
  }, hre) {
  extraArgs = extraArgs || [];
  const RiskModule = await hre.ethers.getContractFactory(rmClass);
  const rm = await hre.upgrades.deployProxy(RiskModule, [
    rmName,
    _R(scrPercentage),
    _R(ensuroFee),
    _R(scrInterestRate),
    _A(maxScrPerPolicy),
    _A(scrLimit),
    wallet,
    ...extraArgs
  ], {
    kind: 'uups',
    constructorArgs: [poolAddress]
  });

  await rm.deployed();
  await logContractCreated(hre, `${rmClass} ${rmName}`, rm.address);
  if (verify)
    await verifyContract(hre, rm, true, [poolAddress]);

  if (moc != 1.0) {
    moc = _R(moc);
    await rm.setMoc(moc);
  }
  const policyPool = await hre.ethers.getContractAt("PolicyPool", poolAddress);
  const policyPoolConfig = await hre.ethers.getContractAt("PolicyPoolConfig", await policyPool.config());
  await policyPoolConfig.addRiskModule(rm.address);
  return rm.address;
}

async function deployFlightDelayRM(opts, hre) {
  opts.extraArgs = [
    opts.linkToken,
    [opts.oracle, opts.delayTime, _W(opts.oracleFee), opts.dataJobId, opts.sleepJobId]
  ];
  return deployRiskModule(opts, hre);
}

async function deployAssetManager({
      verify, amClass, poolAddress, liquidityMin, liquidityMiddle, liquidityMax,
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
  if (verify)
    await verifyContract(hre, am, true, [poolAddress, ...extraConstructorArgs]);
  const policyPool = await hre.ethers.getContractAt("PolicyPool", poolAddress);
  const policyPoolConfig = await hre.ethers.getContractAt("PolicyPoolConfig", await policyPool.config());
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
    _W(opts.maxSlippage),
  ];
  opts.extraConstructorArgs = [
    opts.aaveAddrProv,
    opts.swapRouter,
  ]
  return deployAssetManager(opts, hre);
}

async function deployWhitelist({verify, wlClass, poolAddress, extraConstructorArgs, extraArgs}, hre) {
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
  if (verify)
    await verifyContract(hre, wl, true, [poolAddress, ...extraConstructorArgs]);
  const policyPool = await hre.ethers.getContractAt("PolicyPool", poolAddress);
  const policyPoolConfig = await hre.ethers.getContractAt("PolicyPoolConfig", await policyPool.config());
  await policyPoolConfig.setLPWhitelist(wl.address);
  return wl.address;
}

async function trustfullPolicy({rmAddress, payout, premium, lossProb, expiration, customer}, hre) {
  const rm = await hre.ethers.getContractAt("TrustfulRiskModule", rmAddress);
  const policyPool = await hre.ethers.getContractAt("PolicyPool", await rm.policyPool());
  const currency = await hre.ethers.getContractAt("IERC20Metadata", await policyPool.currency());
  await grantRole(hre, rm, "PRICER_ROLE");

  customer = customer || await _getDefaultSigner(hre);
  premium = _A(premium);

  await currency.approve(policyPool.address, premium);
  lossProb = _R(lossProb);
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
  await grantRole(hre, rm, "RESOLVER_ROLE");

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
  const currency = await hre.ethers.getContractAt("IERC20Metadata", await policyPool.currency());

  await grantRole(hre, rm, "PRICER_ROLE");
  customer = customer || await _getDefaultSigner(hre);
  premium = _A(premium);

  await currency.approve(policyPool.address, premium);
  lossProb = _R(lossProb);
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
    .addOptionalParam("configAddress", "PolicyPoolConfig Address", undefined, types.address)
    .addOptionalParam("treasuryAddress", "Treasury Address", ethers.constants.AddressZero, types.address)
    .setAction(async function(taskArgs, hre) {
      if (taskArgs.currencyAddress === undefined) {
        taskArgs.currencyAddress = await deployTestCurrency(taskArgs, hre);
      }
      if (taskArgs.nftAddress === undefined) {
        taskArgs.nftAddress = await deployPolicyNFT(taskArgs, hre);
      }
      if (taskArgs.configAddress === undefined) {
        taskArgs.configAddress = await deployPolicyPoolConfig(taskArgs, hre);
      }
      let policyPoolAddress = await deployPolicyPool(taskArgs, hre);
    });

  task("deploy:testCurrency", "Deploys the Test Currency")
    .addOptionalParam("verify", "Verify contract in Etherscan", false, types.boolean)
    .addOptionalParam("currName", "Name of Test Currency", "Ensuro Test USD", types.str)
    .addOptionalParam("currSymbol", "Symbol of Test Currency", "EUSD", types.str)
    .addOptionalParam("initialSupply", "Initial supply in the test currency", 2000, types.int)
    .setAction(deployTestCurrency);

  task("deploy:policyNFT", "Deploys the Policies NFT")
    .addOptionalParam("verify", "Verify contract in Etherscan", false, types.boolean)
    .addOptionalParam("nftName", "Name of Policies NFT Token", "Ensuro Policies NFT", types.str)
    .addOptionalParam("nftSymbol", "Symbol of Policies NFT Token", "EPOL", types.str)
    .setAction(deployPolicyNFT);

  task("deploy:poolConfig", "Deploys the PolicyPoolConfig")
    .addOptionalParam("verify", "Verify contract in Etherscan", false, types.boolean)
    .addOptionalParam("treasuryAddress", "Treasury Address", ethers.constants.AddressZero, types.address)
    .setAction(deployPolicyPoolConfig);

  task("deploy:pool", "Deploys the PolicyPool")
    .addOptionalParam("verify", "Verify contract in Etherscan", false, types.boolean)
    .addParam("nftAddress", "NFT Address", types.address)
    .addParam("currencyAddress", "Currency Address", types.address)
    .addParam("configAddress", "PolicyPoolConfig Address", types.address)
    .setAction(deployPolicyPool);

  task("deploy:eToken", "Deploy an EToken and adds it to the pool")
    .addOptionalParam("verify", "Verify contract in Etherscan", false, types.boolean)
    .addParam("poolAddress", "PolicyPool Address", types.address)
    .addOptionalParam("etkName", "Name of EToken", "eUSD1WEEK", types.str)
    .addOptionalParam("etkSymbol", "Symbol of EToken", "eUSD1W", types.str)
    .addOptionalParam("expirationPeriod", "Expiration period (in days)", 7, types.int)
    .addOptionalParam("liquidityRequirement", "Liquidity Requirement (to allow withdraws)",
                      1.0, types.float)
    .addOptionalParam("maxUtilizationRate", "Max Utilization Rate", 1.0, types.float)
    .addOptionalParam("poolLoanInterestRate", "Interest rate when pool takes money from eToken",
                      .05, types.float)
    .setAction(deployEToken);

  task("deploy:riskModule", "Deploys a RiskModule and adds it to the pool")
    .addOptionalParam("verify", "Verify contract in Etherscan", false, types.boolean)
    .addParam("poolAddress", "PolicyPool Address", types.address)
    .addOptionalParam("rmClass", "RiskModule contract", "TrustfulRiskModule", types.str)
    .addOptionalParam("rmName", "Name of the RM", "Test RM", types.str)
    .addOptionalParam("scrPercentage", "SCR Percentage", 1.0, types.float)
    .addOptionalParam("ensuroFee", "Ensuro Fee", 0.02, types.float)
    .addOptionalParam("scrInterestRate", "Interest Rate for RM", 0.05, types.float)
    .addOptionalParam("maxScrPerPolicy", "Max SCR Per policy", 10000, types.float)
    .addOptionalParam("scrLimit", "Total SCR for the RM", 1e6, types.float)
    .addOptionalParam("moc", "Margin of Conservativism", 1.0, types.float)
    .addParam("wallet", "RM address", types.address)
    .setAction(deployRiskModule);

  task("deploy:fdRiskModule", "Deploys and injects a Flight Delay RiskModule")
    .addOptionalParam("verify", "Verify contract in Etherscan", false, types.boolean)
    .addParam("poolAddress", "PolicyPool Address", types.address)
    .addOptionalParam("rmClass", "RiskModule contract", "FlightDelayRiskModule", types.str)
    .addOptionalParam("rmName", "Name of the RM", "Flight Delay Risk Module", types.str)
    .addOptionalParam("scrPercentage", "SCR Percentage", 1.0, types.float)
    .addOptionalParam("ensuroFee", "Ensuro Fee", 0.02, types.float)
    .addOptionalParam("scrInterestRate", "Interest Rate for RM", 0.05, types.float)
    .addOptionalParam("maxScrPerPolicy", "Max SCR Per policy", 10000, types.float)
    .addOptionalParam("scrLimit", "Total SCR for the RM", 1e6, types.float)
    .addOptionalParam("moc", "Margin of Conservativism", 1.0, types.float)
    .addParam("wallet", "RM address", types.address)
    .addParam("linkToken", "LINK address", types.address)
    .addParam("oracle", "Oracle address", types.address)
    .addOptionalParam("oracleFee", "Oracle Fee", 0.1, types.float)
    .addOptionalParam("delayTime", "Delay time", 120, types.int)
    .addOptionalParam("dataJobId", "Data JobId", "2fb0c3a36f924e4ab43040291e14e0b7", types.str)
    .addOptionalParam("sleepJobId", "Sleep JobId", "4241bd0288324bf8a2c683833d0b824f", types.str)
    .setAction(deployFlightDelayRM);

  task("deploy:assetManager", "Deploys a AssetManager and assigns it to the pool")
    .addOptionalParam("verify", "Verify contract in Etherscan", false, types.boolean)
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
    .addOptionalParam("maxSlippage", "maxSlippage", 0.02, types.float)
    .addOptionalParam("aaveAddrProv", "AAVE Address Provider",
                      "0xd05e3E715d945B59290df0ae8eF85c1BdB684744", types.address)
    .addOptionalParam("swapRouter", "Uniswap Router Address",
                      "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506", types.address)
    .setAction(deployAaveAssetManager);

  task("deploy:whitelist", "Deploys a Whitelisting contract")
    .addOptionalParam("verify", "Verify contract in Etherscan", false, types.boolean)
    .addOptionalParam("wlClass", "Whitelisting contract", "LPManualWhitelist", types.str)
    .addParam("poolAddress", "PolicyPool Address", types.address)
    .setAction(deployWhitelist);

  task("ens:trustfullPolicy", "Creates a TrustfulRiskModule Policy")
    .addParam("rmAddress", "RiskModule address", types.address)
    .addParam("payout", "Payout for customer in case policy is triggered", undefined, types.int)
    .addParam("premium", "Premium the customer pays", undefined, types.int)
    .addParam("lossProb", "Probability of policy being triggered", undefined, types.float)
    .addOptionalParam("expiration", "Probability of policy being triggered", undefined, types.float)
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
    .setAction(grantRoleTask);
}

module.exports = {add_task};
