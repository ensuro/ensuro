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
    return _BN(value * 1e9).mul(WAD);
  return _BN(value).mul(RAY);
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
    if (isProxy) {
      console.log(
        "Contract successfully verified, you should verify the proxy at " +
        `https://mumbai.polygonscan.com/proxyContractChecker?a=${contract.address}`
      );
    }
  } catch (error) {
    console.log("Error verifying contract", error);
  }
}

async function grantRole(hre, contract, role, user) {
  if (user === undefined)
    user = await _getDefaultSigner(hre);
  const roleHex = await contract[role]();
  if (!await contract.hasRole(roleHex, user.address)) {
    await contract.grantRole(roleHex, user.address);
    console.log(`Role ${role} (${roleHex}) granted to ${user.address}`);
  } else {
    console.log(`Role ${role} (${roleHex}) already granted to ${user.address}`);
  }
}

async function deployTestCurrency({verify, currName, currSymbol, initialSupply}, hre) {
  const TestCurrency = await hre.ethers.getContractFactory("TestCurrency");
  const currency = await TestCurrency.deploy(currName, currSymbol, _W(initialSupply));
  await currency.deployed();
  console.log("TestCurrency deployed to:", currency.address);
  if (verify)
    await verifyContract(hre, currency, false, [currName, currSymbol, _W(initialSupply)]);
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
  console.log("PolicyNFT deployed to:", policyNFT.address);
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
  console.log("PolicyPoolConfig deployed to:", policyPoolConfig.address);
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
    kind: 'uups'
  });

  await policyPool.deployed();
  console.log("PolicyPool deployed to:", policyPool.address);
  console.log("PolicyPool's config is:", await policyPool.config());

  if (verify)
    await verifyContract(hre, policyPool, true, [configAddress, nftAddress, currencyAddress]);

  const policyPoolConfig = await hre.ethers.getContractAt("PolicyPoolConfig", await policyPool.config());
  await grantRole(hre, policyPoolConfig, "LEVEL1_ROLE");
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
    poolAddress,
    expirationPeriod * 24 * 3600,
    _R(liquidityRequirement),
    _R(maxUtilizationRate),
    _R(poolLoanInterestRate),
  ], {kind: 'uups'});

  await etoken.deployed();
  console.log("EToken ", etkName, " deployed to:", etoken.address);
  if (verify)
    await verifyContract(hre, etoken, true);
  const policyPool = await hre.ethers.getContractAt("PolicyPool", poolAddress);
  await policyPool.addEToken(etoken.address);
  return etoken.address;
}

async function deployRiskModule({
      verify, rmClass, rmName, poolAddress, scrPercentage, premiumShare, ensuroShare, maxScrPerPolicy,
      scrLimit, wallet, sharedCoverageMinPercentage, extraArgs
  }, hre) {
  extraArgs = extraArgs || [];
  const RiskModule = await hre.ethers.getContractFactory(rmClass);
  const rm = await hre.upgrades.deployProxy(RiskModule, [
    rmName,
    poolAddress,
    _R(scrPercentage),
    _R(premiumShare),
    _R(ensuroShare),
    _W(maxScrPerPolicy),
    _W(scrLimit),
    wallet,
    _R(sharedCoverageMinPercentage),
    ...extraArgs
  ], {kind: 'uups'});

  await rm.deployed();
  console.log("RiskModule ", rmClass, rmName, " deployed to:", rm.address);
  if (verify)
    await verifyContract(hre, rm, true);
  const policyPool = await hre.ethers.getContractAt("PolicyPool", poolAddress);
  const policyPoolConfig = await hre.ethers.getContractAt("PolicyPoolConfig", await policyPool.config());
  await policyPoolConfig.addRiskModule(rm.address);
  return rm.address;
}

async function trustfullPolicy({rmAddress, payout, premium, lossProb, expiration, customer}, hre) {
  const rm = await hre.ethers.getContractAt("TrustfulRiskModule", rmAddress);
  const policyPool = await hre.ethers.getContractAt("PolicyPool", await rm.policyPool());
  const currency = await hre.ethers.getContractAt("IERC20Metadata", await policyPool.currency());
  await grantRole(hre, rm, "PRICER_ROLE");

  customer = customer || await _getDefaultSigner(hre);
  premium = _W(premium);

  await currency.approve(policyPool.address, premium);
  lossProb = _R(lossProb);
  if (expiration === undefined) {
    expiration = 3600;
  }
  if (expiration < 1600000000) {
    expiration = Math.round((new Date()).getTime() / 1000) + expiration;
  }
  payout = _W(payout);

  const tx = await rm.newPolicy(payout, premium, lossProb, expiration, customer.address, {gasLimit: 999999});
  console.log(tx);
}

async function resolvePolicy({rmAddress, payout, fullPayout, policyId}, hre) {
  const rm = await hre.ethers.getContractAt("TrustfulRiskModule", rmAddress);
  await grantRole(hre, rm, "RESOLVER_ROLE");

  let tx;

  if (fullPayout === undefined) {
    payout = _W(payout);
    tx = await rm.resolvePolicy(policyId, payout);
  } else {
    tx = await rm.resolvePolicyFullPayout(policyId, fullPayout);
  }
  console.log(tx);
}

async function flyionPolicy({rmAddress, flight, departure, expectedArrival, tolerance, payout, premium,
                             lossProb, customer}, hre) {
  const flyionRm = await hre.ethers.getContractAt("FlyionRiskModule", rmAddress);
  const policyPool = await hre.ethers.getContractAt("PolicyPool", await flyionRm.policyPool());
  const currency = await hre.ethers.getContractAt("IERC20Metadata", await policyPool.currency());

  await grantRole(hre, flyionRm, "PRICER_ROLE");
  customer = customer || await _getDefaultSigner(hre);
  premium = _W(premium);

  await currency.approve(policyPool.address, premium);
  lossProb = _R(lossProb);
  payout = _W(payout);

  const tx = await flyionRm.newPolicy(
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
  amount = _W(amount);
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
      console.log("Deploy task called ", taskArgs, " policyPool", policyPoolAddress);
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
    .addOptionalParam("premiumShare", "Share of the premium for RM", 0, types.float)
    .addOptionalParam("ensuroShare", "Ensuro Share", 0.02, types.float)
    .addOptionalParam("maxScrPerPolicy", "Max SCR Per policy", 10000, types.float)
    .addOptionalParam("scrLimit", "Total SCR for the RM", 1e6, types.float)
    .addParam("wallet", "RM address", types.address)
    .addOptionalParam("sharedCoverageMinPercentage", "Shared coverage minimum percentage", 0.0, types.float)
    .setAction(deployRiskModule);

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

  task("ens:flyionPolicy", "Creates a Flyion Policy")
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
    .setAction(flyionPolicy);

  task("ens:listETokens", "Lists eTokens")
    .addParam("poolAddress", "PolicyPool Address", types.address)
    .setAction(listETokens);

  task("ens:deposit", "Deposits in a given eToken")
    .addParam("etkAddress", "EToken address", types.address)
    .addParam("amount", "Amount to Deposit", undefined, types.int)
    .setAction(deposit);
}

module.exports = {add_task};
