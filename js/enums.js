const WhitelistStatus = {
  notdefined: 0,
  whitelisted: 1,
  blacklisted: 2,
};

const ComponentKind = {
  unknown: 0,
  eToken: 1,
  riskModule: 2,
  premiumsAccount: 3,
};

const ComponentStatus = {
  inactive: 0,
  active: 1,
  deprecated: 2,
  suspended: 3,
};

const ETokenParameter = {
  // From IEToken.Parameter
  liquidityRequirement: 0,
  minUtilizationRate: 1,
  maxUtilizationRate: 2,
  internalLoanInterestRate: 3,
};

const RiskModuleParameter = {
  // From IRiskModule.Parameter
  moc: 0,
  jrCollRatio: 1,
  collRatio: 2,
  ensuroPpFee: 3,
  ensuroCocFee: 4,
  jrRoc: 5,
  srRoc: 6,
  maxPayoutPerPolicy: 7,
  exposureLimit: 8,
  maxDuration: 9,
};

module.exports = {
  ComponentKind,
  ComponentStatus,
  ETokenParameter,
  RiskModuleParameter,
  WhitelistStatus,
};
