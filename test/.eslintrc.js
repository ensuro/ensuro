module.exports = {
  rules: {
    "no-unused-expressions": "off", // not friendly with mocha/chai
  },
  globals: {
    hre: "readonly",
  },
};
