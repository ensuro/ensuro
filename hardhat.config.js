/* global task, ethers */
require("@nomicfoundation/hardhat-chai-matchers");
require("@openzeppelin/hardhat-upgrades");
require("hardhat-contract-sizer");
require("hardhat-dependency-compiler");
require("hardhat-ignore-warnings");
require("hardhat-gas-reporter");
require("hardhat-tracer");
require("solidity-coverage");
require("solidity-docgen");

require("./instrumented/plugin/hardhat.plugin");

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
  while (process.env[`${network}_ACCOUNTPK_${index}`]) {
    accounts.push(process.env[`${network}_ACCOUNTPK_${index}`]);
    index += 1;
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
    version: "0.8.30",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      evmVersion: "cancun",
    },
  },
  contractSizer: {
    alphaSort: true,
    runOnCompile: false,
    disambiguatePaths: false,
  },
  defaultNetwork: "hardhat",
  networks: {
    localhost: {
      url: "http://127.0.0.1:8545",
    },
    ganache: {
      url: "http://ganache-cli:8545",
    },
    hardhat: {
      hardfork: "cancun",
      // base fee of 0 allows use of 0 gas price when testing
      initialBaseFeePerGas: 0,
    },
    bsctestnet: {
      url: "https://data-seed-prebsc-1-s3.binance.org:8545/",
      chainId: 97,
      gasPrice: 20000000000,
    },
    rinkeby: {
      url: `https://rinkeby.infura.io/v3/${process.env.WEB3_INFURA_PROJECT_ID}`,
      accounts: readEnvAccounts("rinkeby"),
    },
    polygon: {
      url: `https://polygon-mainnet.infura.io/v3/${process.env.WEB3_INFURA_PROJECT_ID}`,
      chainId: 137,
      accounts: readEnvAccounts("polygon"),
      gasPrice: "auto",
      gasMultiplier: 1.3,
    },
    polytest: {
      url: `https://polygon-mumbai.infura.io/v3/${process.env.WEB3_INFURA_PROJECT_ID}`,
      chainId: 80001,
      accounts: readEnvAccounts("polytest"),
      gasPrice: "auto",
    },
    mainnet: {
      url: `https://mainnet.infura.io/v3/${process.env.WEB3_INFURA_PROJECT_ID}`,
      accounts: readEnvAccounts("mainnet"),
    },
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_TOKEN,
  },
  gasReporter: {
    currency: "USD",
    coinmarketcap: "1b0c87b0-c123-48d1-86f9-1544ef487220",
    enabled: Boolean(process.env.REPORT_GAS),
  },
  mocha: {
    timeout: 120000,
  },
  docgen: {
    pages: "files",
    outputDir: "docs",
    templates: "./docgen-templates",
    exclude: ["mocks", "dependencies", "upgraded"],
  },
  dependencyCompiler: {
    paths: [
      "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol",
      "@openzeppelin/contracts/access/manager/AccessManager.sol",
      "@ensuro/utils/contracts/TestERC4626.sol",
      "@ensuro/utils/contracts/TestCurrency.sol",
      "@ensuro/utils/contracts/TestCurrencyPermit.sol",
      "@ensuro/access-managed-proxy/contracts/AccessManagedProxy.sol",
    ],
  },
  warnings: {
    "@ensuro/access-managed-proxy/contracts/AccessManagedProxy.sol": {
      "missing-receive": "off",
      "unused-param": "off",
    },
    "@ensuro/access-managed-proxy/contracts/amps/AccessManagedProxyS*.sol": {
      "missing-receive": "off",
      "unused-param": "off",
    },
    "contracts/mocks/PolicyPoolMock.sol": {
      "missing-receive": "off",
    },
    "contracts/mocks/ForwardProxy.sol": {
      "missing-receive": "off",
    },
  },
};
