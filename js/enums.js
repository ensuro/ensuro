const WhitelistStatus = {
  notdefined: 0,
  whitelisted: 1,
  blacklisted: 2,
};

const RiskModuleParameter = {
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

const ComponentKind = {
  eToken: 1,
  riskModule: 2,
  premiumsAccount: 3,
};

module.exports = {
  WhitelistStatus,
  RiskModuleParameter,
  ComponentKind,
};
