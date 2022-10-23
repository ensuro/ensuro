const hre = require("hardhat");
const { artifacts } = require("hardhat");
const { findAll } = require("solidity-ast/utils");

/**
 * Script to print a contracts storage layout as a table.
 *
 * Example usage: node scripts/storageLayout.js EToken
 */

//

async function getStorageLayout(contractSrc, contractName) {
  const buildInfo = await artifacts.getBuildInfo(`${contractSrc}:${contractName}`);
  const solcOutput = buildInfo.output;

  const contracts = {};
  const storageLayouts = {};

  for (const def of findAll("ContractDefinition", solcOutput.sources[contractSrc].ast)) {
    contracts[def.name] = def;
    storageLayouts[def.name] = solcOutput.contracts[contractSrc][def.name].storageLayout;
  }

  return storageLayouts[contractName].storage;
}

async function main(contractSrc, contractName) {
  await hre.run("compile");
  const layout = await getStorageLayout(contractSrc, contractName);

  const summary = layout.map((item) => ({
    slot: item.slot,
    label: item.label,
    type: item.type,
  }));
  console.table(summary);
}

function getContractSourceName(name) {
  return [`contracts/${name}.sol`, name];
}

const [contractSrc, contractName] = getContractSourceName(process.argv[2]);

console.log(`# Storage layout for ${contractSrc}:${contractName}`);
console.log("```");
main(contractSrc, contractName).then(() => {
  console.log("```");
  process.exit(0);
});
