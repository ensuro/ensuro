require("mocha");
const { expect } = require("chai");

const { getStorageLayout } = require("../js/utils");

describe("Storage Gaps", () => {
  const contracts = [
    "EToken",
    "AccessManager",
    "LPManualWhitelist",
    "PolicyPool",
    "PolicyPoolComponent",
    "PremiumsAccount",
    "Reserve",
    "RiskModule",
    "SignedQuoteRiskModule",
    "TrustfulRiskModule",
  ];

  for (const contract of contracts) {
    it(`${contract} has a proper storage gap`, async () => {
      const { storage, types } = await getStorageLayout(hre, `contracts/${contract}.sol`, contract);

      const gap = storage[storage.length - 1];

      // Check the storage ends with a gap
      expect(gap.label).to.equal("__gap");

      // Check the storage aligns to 50 slots (+1 because of https://github.com/OpenZeppelin/openzeppelin-contracts-upgradeable/issues/182)
      const finalSlot = parseInt(gap.slot) + Math.floor(parseInt(types[gap.type].numberOfBytes) / 32);
      expect(finalSlot % 50).to.equal(1);
    });
  }
});
