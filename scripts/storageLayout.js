const hre = require("hardhat");
const { getStorageLayout } = require("../js/utils");

/**
 * Script to print a contracts storage layout as a table.
 *
 * Example usage: node scripts/storageLayout.js EToken
 */

async function main(contractSrc, contractName) {
  await hre.run("compile");
  const layout = await getStorageLayout(hre, contractSrc, contractName);

  const summary = layout.storage.map((item) => ({
    slot: parseInt(item.slot),
    label: item.label,
    type: item.type,
    numberOfBytes: parseInt(layout.types[item.type].numberOfBytes),
    endSlot: parseInt(item.slot) + Math.floor(parseInt(layout.types[item.type].numberOfBytes) / 32),
  }));
  console.table(summary);
}

const [contractSrc, contractName] = [`contracts/${process.argv[2]}.sol`, process.argv[2]];

console.log(`Storage layout for ${contractSrc}:${contractName}`);
main(contractSrc, contractName).then(() => {
  // eslint-disable-next-line no-process-exit
  process.exit(0);
});
