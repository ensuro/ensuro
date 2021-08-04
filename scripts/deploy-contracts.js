// We require the Hardhat Runtime Environment explicitly here. This is optional
// but useful for running the script in a standalone fashion through `node <script>`.
//
// When running the script with `hardhat run <script>` you'll find the Hardhat
// Runtime Environment's members available in the global scope.
const hre = require("hardhat");
const _BN = hre.ethers.BigNumber.from;
const WAD = _BN(1e10).mul(_BN(1e8));  // 1e10*1e8=1e18
const RAY = WAD.mul(_BN(1e9));  // 1e18*1e9=1e27


function _W(value) {
  return _BN(value).mul(WAD);
}

function _R(value) {
  return _BN(value).mul(RAY);
}

async function main() {
  // Hardhat always runs the compile task when running scripts with its command
  // line interface.
  //
  // If this script is run directly using `node` you may want to call compile
  // manually to make sure everything is compiled
  // await hre.run('compile');

  // We get the contract to deploy
  const TestCurrency = await hre.ethers.getContractFactory("TestCurrency");
  const currency = await TestCurrency.deploy("Ensuro Test USD", "EUSD", _W(2000));
  await currency.deployed();
  console.log("TestCurrency deployed to:", currency.address);
  process.env["CURRENCY"] = currency.address;

  const PolicyNFT = await hre.ethers.getContractFactory("PolicyNFT");
  const policyNFT = await hre.upgrades.deployProxy(PolicyNFT, ["Ensuro Policies NFT", "EPOL"]);
  await policyNFT.deployed();
  console.log("PolicyNFT deployed to:", policyNFT.address);

  // Deploy Policy library
  /*const Policy = await hre.ethers.getContractFactory("Policy");
  policy = await Policy.deploy();

  const PolicyPool = await hre.ethers.getContractFactory("PolicyPool", {
    libraries: {
      Policy: policy.address
    }
  });*/
  const PolicyPool = await hre.ethers.getContractFactory("PolicyPool");
  const policyPool = await hre.upgrades.deployProxy(PolicyPool, [
    policyNFT.address,
    currency.address,
    hre.ethers.constants.AddressZero,
    hre.ethers.constants.AddressZero,
  ]);

  await policyPool.deployed();
  console.log("PolicyPool deployed to:", policyPool.address);
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
