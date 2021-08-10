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
  } catch (error) {
    console.log("Error verifying contract", error);
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

async function deployPolicyNFT({verify, nftName, nftSymbol}, hre) {
  const PolicyNFT = await hre.ethers.getContractFactory("PolicyNFT");
  const policyNFT = await hre.upgrades.deployProxy(PolicyNFT, [nftName, nftSymbol], {kind: 'uups'});
  await policyNFT.deployed();
  console.log("PolicyNFT deployed to:", policyNFT.address);
  if (verify)
    await verifyContract(hre, policyNFT, true);
  return policyNFT.address;
}

async function deployPolicyPool({verify, nftAddress, currencyAddress, treasuryAddress}, hre) {
  const PolicyPool = await hre.ethers.getContractFactory("PolicyPool");
  const policyPool = await hre.upgrades.deployProxy(PolicyPool, [
    nftAddress,
    currencyAddress,
    treasuryAddress,
    hre.ethers.constants.AddressZero,
  ], {kind: 'uups'});

  await policyPool.deployed();
  console.log("PolicyPool deployed to:", policyPool.address);
  if (verify)
    await verifyContract(hre, policyPool, true);
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
  const PolicyPool = await hre.ethers.getContractFactory("PolicyPool");
  const policyPool = PolicyPool.attach(poolAddress);
  await policyPool.addEToken(etoken.address);
  return etoken.address;
}

async function deployRiskModule({
      verify, rmClass, rmName, poolAddress, scrPercentage, premiumShare, ensuroShare, maxScrPerPolicy,
      scrLimit, wallet, sharedCoverageMinPercentage
  }, hre) {
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
  ], {kind: 'uups'});

  await rm.deployed();
  console.log("RiskModule ", rmClass, rmName, " deployed to:", rm.address);
  if (verify)
    await verifyContract(hre, rm, true);
  const PolicyPool = await hre.ethers.getContractFactory("PolicyPool");
  const policyPool = PolicyPool.attach(poolAddress);
  await policyPool.addRiskModule(rm.address);
  return rm.address;
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
    .addOptionalParam("treasuryAddress", "Treasury Address", ethers.constants.AddressZero, types.address)
    .setAction(async function(taskArgs, hre) {
      if (taskArgs.currencyAddress === undefined) {
        taskArgs.currencyAddress = await deployTestCurrency(taskArgs, hre);
      }
      if (taskArgs.nftAddress === undefined) {
        taskArgs.nftAddress = await deployPolicyNFT(taskArgs, hre);
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

  task("deploy:pool", "Deploys the PolicyPool")
    .addOptionalParam("verify", "Verify contract in Etherscan", false, types.boolean)
    .addParam("nftAddress", "NFT Address", types.address)
    .addParam("currencyAddress", "Currency Address", types.address)
    .addOptionalParam("treasuryAddress", "Treasury Address", ethers.constants.AddressZero, types.address)
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
}

module.exports = {add_task};
