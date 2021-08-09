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

const DEV_ACCOUNT_PK = process.env.DEV_ACCOUNT_PK;

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
    hardhat: {
    },
    testnet: {
      url: "https://data-seed-prebsc-1-s3.binance.org:8545/",
      chainId: 97,
      gasPrice: 20000000000,
//      accounts: {mnemonic: mnemonic}
    },
    rinkeby: {
      url: "https://rinkeby.infura.io/v3/f6ee6adc6d4746d6ad002098d1649067",
      accounts: [DEV_ACCOUNT_PK],
    },
    polygon: {
      url: "https://polygon-mainnet.infura.io/v3/f6ee6adc6d4746d6ad002098d1649067",
      chainId: 137,
    },
    polytest: {
      url: "https://polygon-mumbai.infura.io/v3/f6ee6adc6d4746d6ad002098d1649067",
      chainId: 80001,
      accounts: [DEV_ACCOUNT_PK],
    },
    mainnet: {
      url: "https://bsc-dataseed.binance.org/",
      chainId: 56,
      gasPrice: 20000000000,
//      accounts: {mnemonic: mnemonic}
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

