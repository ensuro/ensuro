const ethers = require("ethers");

const _BN = ethers.BigNumber.from;
const WAD = _BN(1e10).mul(_BN(1e8));  // 1e10*1e8=1e18
const RAY = WAD.mul(_BN(1e9));  // 1e18*1e9=1e27


function _W(value) {
  return _BN(value).mul(WAD);
}

function _R(value) {
  return _BN(value).mul(RAY);
}


async function deployTestCurrency({currName, currSymbol, initialSupply}, hre) {
  // We get the contract to deploy
  const TestCurrency = await hre.ethers.getContractFactory("TestCurrency");
  const currency = await TestCurrency.deploy(currName, currSymbol, _W(initialSupply));
  await currency.deployed();
  console.log("TestCurrency deployed to:", currency.address);
  return currency.address;
}

async function deployPolicyNFT({nftName, nftSymbol}, hre) {
  const PolicyNFT = await hre.ethers.getContractFactory("PolicyNFT");
  const policyNFT = await hre.upgrades.deployProxy(PolicyNFT, [nftName, nftSymbol]);
  await policyNFT.deployed();
  console.log("PolicyNFT deployed to:", policyNFT.address);
  return policyNFT.address;
}

async function deployPolicyPool({nftAddress, currencyAddress, treasuryAddress}, hre) {
  const PolicyPool = await hre.ethers.getContractFactory("PolicyPool");
  const policyPool = await hre.upgrades.deployProxy(PolicyPool, [
    nftAddress,
    currencyAddress,
    treasuryAddress,
    hre.ethers.constants.AddressZero,
  ]);

  await policyPool.deployed();
  console.log("PolicyPool deployed to:", policyPool.address);
  return policyPool.address;
}

function add_task() {
  task("deploy", "Deploys the contracts")
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
    .addOptionalParam("currName", "Name of Test Currency", "Ensuro Test USD", types.str)
    .addOptionalParam("currSymbol", "Symbol of Test Currency", "EUSD", types.str)
    .addOptionalParam("initialSupply", "Initial supply in the test currency", 2000, types.int)
    .setAction(deployTestCurrency);

  task("deploy:policyNFT", "Deploys the Policies NFT")
    .addOptionalParam("nftName", "Name of Policies NFT Token", "Ensuro Policies NFT", types.str)
    .addOptionalParam("nftSymbol", "Symbol of Policies NFT Token", "EPOL", types.str)
    .setAction(deployPolicyNFT);

  task("deploy:pool", "Deploys the PolicyPool")
    .addParam("nftAddress", "NFT Address", types.address)
    .addParam("currencyAddress", "Currency Address", types.address)
    .addOptionalParam("treasuryAddress", "Treasury Address", ethers.constants.AddressZero, types.address)
    .setAction(deployPolicyPool);
}

module.exports = {add_task};
