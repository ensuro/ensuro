const ethers = require("ethers");
const helpers = require("@nomicfoundation/hardhat-network-helpers");
const { DAY } = require("@ensuro/utils/js/constants");
const { amountFunction, getAddress, _W } = require("@ensuro/utils/js/utils");

/**
 * Create a policy id by combining the riskmodule address and the internal id.
 *
 * Mimics the PolicyPool.newPolicy method of building the policy id.
 */
function makePolicyId(rm, internalId) {
  const rmAddress = getAddress(rm);
  const bigRmAddress = BigInt(rmAddress);
  // eslint-disable-next-line no-bitwise
  const shiftedValue = (bigRmAddress << BigInt(96)) + BigInt(internalId);
  return shiftedValue;
}

/**
 * Create a packed quote message for later signing or hashing.
 *
 * Mimics the behaviour of the SignedQuoteRiskModule._newSignedPolicy method.
 */
function makeQuoteMessage({ rmAddress, payout, premium, lossProb, expiration, policyData, validUntil }) {
  return ethers.solidityPacked(
    ["address", "uint256", "uint256", "uint256", "uint40", "bytes32", "uint40"],
    [rmAddress, payout, premium, lossProb, expiration, policyData, validUntil]
  );
}

function paramsAsUint256(params) {
  /* eslint no-bitwise: "off" */
  return (
    (params.moc << 240n) |
    (params.jrCollRatio << 224n) |
    (params.collRatio << 208n) |
    (params.ensuroPpFee << 192n) |
    (params.ensuroCocFee << 176n) |
    (params.jrRoc << 160n) |
    (params.srRoc << 144n)
  );
}

/**
 * Create a packed quote message for later signing or hashing.
 *
 * Mimics the behaviour of the FullSignedBucketRiskModule._checkFullSignature method.
 */
function makeFullQuoteMessage({ rmAddress, payout, premium, lossProb, expiration, policyData, params, validUntil }) {
  return ethers.solidityPacked(
    ["address", "uint256", "uint256", "uint256", "uint40", "bytes32", "uint256", "uint40"],
    [rmAddress, payout, premium, lossProb, expiration, policyData, paramsAsUint256(params), validUntil]
  );
}

/**
 * Create a packed quote message for later signing or hashing.
 *
 * Mimics the behaviour of the SignedBucketRiskModule._newSignedPolicy method.
 */
function makeBucketQuoteMessage({
  rmAddress,
  payout,
  premium,
  lossProb,
  expiration,
  policyData,
  bucketId,
  validUntil,
}) {
  return ethers.solidityPacked(
    ["address", "uint256", "uint256", "uint256", "uint40", "bytes32", "uint256", "uint40"],
    [rmAddress, payout, premium, lossProb, expiration, policyData, bucketId, validUntil]
  );
}

/**
 * Creates and signs a quote message from its policy parameters.
 *
 * Mimics the behaviour of policy-quote-api.
 */
async function makeSignedQuote(signer, policyParams, makeQuoteMessageFn = makeQuoteMessage) {
  const quoteMessage = makeQuoteMessageFn(policyParams);
  return ethers.Signature.from(await signer.signMessage(ethers.getBytes(quoteMessage)));
}

/**
 * Recover address from signed quote
 */
function recoverAddress(policyParams, signature, makeQuoteMessageFn = makeQuoteMessage) {
  const quoteMessage = makeQuoteMessageFn(policyParams);
  const msg = ethers.getBytes(quoteMessage);
  return ethers.verifyMessage(msg, signature);
}

/**
 * Build a default policy parameters object.
 */
async function defaultPolicyParams(
  { rm, payout, premium, lossProb, expiration, policyData, validUntil },
  _A = amountFunction(6)
) {
  const now = await helpers.time.latest();
  const rmAddress = rm ? getAddress(rm) : null;
  return {
    rmAddress,
    payout: payout || _A(1000),
    premium: premium || ethers.MaxUint256,
    lossProb: lossProb || _W(0.1),
    expiration: expiration || now + DAY * 30,
    policyData: policyData || ethers.hexlify(ethers.randomBytes(32)),
    validUntil: validUntil || now + DAY * 30,
  };
}

async function defaultPolicyParamsWithBucket(opts, _A = amountFunction(6)) {
  const ret = await defaultPolicyParams(opts, _A);
  return { bucketId: opts.bucketId || 0, ...ret };
}

async function defaultPolicyParamsWithParams(opts, _A = amountFunction(6)) {
  const ret = await defaultPolicyParams(opts, _A);
  // struct PackedParams {
  //   uint16 moc; // Margin Of Conservativism - factor that multiplies lossProb - 4 decimals
  //   uint16 jrCollRatio; // Collateralization Ratio to compute Junior solvency as % of payout - 4 decimals
  //   uint16 collRatio; // Collateralization Ratio to compute solvency requirement as % of payout - 4 decimals
  //   uint16 ensuroPpFee; // % of pure premium that will go for Ensuro treasury - 4 decimals
  //   uint16 ensuroCocFee; // % of CoC that will go for Ensuro treasury - 4 decimals
  //   uint16 jrRoc; // Return on Capital paid to Junior LPs - Annualized Percentage - 4 decimals
  //   uint16 srRoc; // Return on Capital paid to Senior LPs - Annualized Percentage - 4 decimals
  //   uint32 maxPayoutPerPolicy; // Max Payout per Policy - 2 decimals
  //   uint32 exposureLimit; // Max exposure (sum of payouts) to be allocated to this module - 0 decimals
  //   uint16 maxDuration; // Max policy duration (in hours)
  // }
  const optsParams = opts.params || {};
  const wadTo4Decimals = 10n ** 14n;
  const params = {
    moc: (optsParams.moc || _W(1)) / wadTo4Decimals,
    jrCollRatio: (optsParams.jrCollRatio || 0n) / wadTo4Decimals,
    collRatio: (optsParams.collRatio || _W(1)) / wadTo4Decimals,
    ensuroPpFee: (optsParams.ensuroPpFee || 0n) / wadTo4Decimals,
    ensuroCocFee: (optsParams.ensuroCocFee || 0n) / wadTo4Decimals,
    jrRoc: (optsParams.jrRoc || 0n) / wadTo4Decimals,
    srRoc: (optsParams.srRoc || _W("0.1")) / wadTo4Decimals, // 10%
    maxPayoutPerPolicy: 0n, // Not used
    exposureLimit: 0n, // Not used
    maxDuration: 0n, // Not used
  };
  return { params, ...ret };
}

function defaultBucketParams({ moc, jrCollRatio, collRatio, ensuroPpFee, ensuroCocFee, jrRoc, srRoc }) {
  return {
    moc: moc !== undefined ? moc : _W("1.1"),
    jrCollRatio: jrCollRatio !== undefined ? jrCollRatio : _W("0.1"),
    collRatio: collRatio !== undefined ? collRatio : _W("0.2"),
    ensuroPpFee: ensuroPpFee !== undefined ? ensuroPpFee : _W("0.05"),
    ensuroCocFee: ensuroCocFee !== undefined ? ensuroCocFee : _W("0.2"),
    jrRoc: jrRoc !== undefined ? jrRoc : _W("0.1"),
    srRoc: srRoc !== undefined ? srRoc : _W("0.2"),
    asParams: function () {
      return [this.moc, this.jrCollRatio, this.collRatio, this.ensuroPpFee, this.ensuroCocFee, this.jrRoc, this.srRoc];
    },
  };
}

module.exports = {
  defaultPolicyParams,
  defaultPolicyParamsWithBucket,
  defaultPolicyParamsWithParams,
  defaultBucketParams,
  makeBucketQuoteMessage,
  makeFullQuoteMessage,
  paramsAsUint256,
  makePolicyId,
  makeQuoteMessage,
  makeSignedQuote,
  recoverAddress,
};
