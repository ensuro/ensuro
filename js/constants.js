const HOUR = 3600;
const WEEK = HOUR * 24 * 7;
const DAY = HOUR * 24;

// From https://eips.ethereum.org/EIPS/eip-1967
const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

module.exports = {
  WEEK,
  DAY,
  HOUR,
  IMPLEMENTATION_SLOT,
};
