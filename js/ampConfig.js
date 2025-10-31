const ampConfig = {
  PolicyPool: {
    skipViewsAndPure: true,
    skipMethods: [
      "newPolicy",
      "resolvePolicy",
      "replacePolicy",
      "expirePolicy", // To guarantee that all policies expire
    ],
  },
  RiskModule: {
    skipViewsAndPure: true,
    skipMethods: [],
  },
  PremiumsAccount: {
    skipViewsAndPure: true,
    skipMethods: ["policyCreated", "policyExpired", "policyReplaced", "policyResolvedWithPayout"],
  },
  EToken: {
    // TO DO: too many methods skipped... It's better to define the ones that will be called more frequently
    // and make the rest public with the AccessManager configuration
    skipViewsAndPure: true,
    skipMethods: [
      // Methods with onlyPolicyPool
      // "addBorrower",  - Low frequency, better to keep AC
      // "removeBorrower", - Low frequency, better to keep AC
      "deposit",
      "withdraw",
      // Methods with onlyBorrower
      "lockScr",
      "unlockScr",
      // internalLoan, - Moderate frequency, high risk, better to keep AC to enable pause or other security
      // repayLoan, - Moderate frequency, high risk, better to keep AC to enable pause or other security
    ],
  },
  LPManualWhitelist: {
    skipViewsAndPure: true,
    skipMethods: [],
  },
  Cooler: {
    skipViewsAndPure: true,
    skipMethods: [],
  },
};

module.exports = {
  ampConfig,
};
