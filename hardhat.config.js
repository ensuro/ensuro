require("@nomiclabs/hardhat-waffle");
require("hardhat-gas-reporter");
require("solidity-coverage");
require("hardhat-contract-sizer");
require('@openzeppelin/hardhat-upgrades');
require("@nomiclabs/hardhat-etherscan");

const deploy = require("./tasks/deploy");

// const { mnemonic } = require('./secrets.json');

// This is a sample Hardhat task. To learn how to create your own go to
// https://hardhat.org/guides/create-task.html
task("accounts", "Prints the list of accounts", async () => {
  const accounts = await ethers.getSigners();

  for (const account of accounts) {
    console.log(account.address);
  }
});


deploy.add_task();

function readEnvAccounts(network) {
  network = network.toUpperCase();
  let accounts = [];
  let index = 1;
  while (process.env[network + "_ACCOUNTPK_" + index]) {
    accounts.push(process.env[network + "_ACCOUNTPK_" + index]);
    index++;
  }
  return accounts;
}

// You need to export an object to set up your config
// Go to https://hardhat.org/config/ to learn more

/**
 * @type import('hardhat/config').HardhatUserConfig
 */
module.exports = {
  solidity: {
    version: "0.8.6",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200
      }
    }
  },
  contractSizer: {
    alphaSort: true,
    runOnCompile: false,
    disambiguatePaths: false,
  },
  defaultNetwork: "hardhat",
  networks: {
    localhost: {
      url: "http://127.0.0.1:8545"
    },
    ganache: {
      url: "http://ganache-cli:8545"
    },
    hardhat: {
    },
    bsctestnet: {
      url: "https://data-seed-prebsc-1-s3.binance.org:8545/",
      chainId: 97,
      gasPrice: 20000000000,
    },
    rinkeby: {
      url: "https://rinkeby.infura.io/v3/" + process.env.WEB3_INFURA_PROJECT_ID,
      accounts: readEnvAccounts("rinkeby"),
    },
    polygon: {
      url: "https://polygon-mainnet.infura.io/v3/" + process.env.WEB3_INFURA_PROJECT_ID,
      chainId: 137,
      accounts: readEnvAccounts("polygon"),
      gasPrice: 8000000000,  // default is 'auto' which breaks chains without the london hardfork
    },
    polytest: {
      url: "https://polygon-mumbai.infura.io/v3/" + process.env.WEB3_INFURA_PROJECT_ID,
      chainId: 80001,
      accounts: readEnvAccounts("polytest"),
      gasPrice: 8000000000,  // default is 'auto' which breaks chains without the london hardfork
    },
    mainnet: {
      url: "https://mainnet.infura.io/v3/" + process.env.WEB3_INFURA_PROJECT_ID,
      accounts: readEnvAccounts("mainnet"),
    }
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_TOKEN,
  },
  gasReporter: {
    currency: 'USD',
    coinmarketcap: "1b0c87b0-c123-48d1-86f9-1544ef487220",
    enabled: (process.env.REPORT_GAS) ? true : false
  }
};

