const { findAll } = require("solidity-ast/utils");
const ethers = require("ethers");
const helpers = require("@nomicfoundation/hardhat-network-helpers");
const { DAY, IMPLEMENTATION_SLOT } = require("./constants");

const _E = ethers.utils.parseEther;
const _BN = ethers.BigNumber.from;
const WAD = _BN(10).pow(18); // 1e18
const RAY = _BN(10).pow(27); // 1e27

async function getStorageLayout(hre, contractSrc, contractName) {
  const buildInfo = await hre.artifacts.getBuildInfo(`${contractSrc}:${contractName}`);
  if (buildInfo === undefined) throw new Error(`Contract ${contractSrc}:${contractName} not in artifacts`);

  const solcOutput = buildInfo.output;

  const storageLayouts = {};

  for (const def of findAll("ContractDefinition", solcOutput.sources[contractSrc].ast)) {
    storageLayouts[def.name] = solcOutput.contracts[contractSrc][def.name].storageLayout;
  }

  return storageLayouts[contractName];
}

/**
 * Creates a fixed-point conversion function for the desired number of decimals
 * @param decimals The number of decimals. Must be >= 6.
 * @returns The amount function created. The function can receive strings (recommended),
 *          floats/doubles (not recommended) and integers.
 *
 *          Floats will be rounded to 6 decimal before scaling.
 */
function amountFunction(decimals) {
  return function (value) {
    if (value === undefined) return undefined;

    if (typeof value === "string" || value instanceof String) {
      return ethers.utils.parseUnits(value, decimals);
    }

    if (!Number.isInteger(value)) {
      return _BN(Math.round(value * 1e6)).mul(_BN(Math.pow(10, decimals - 6)));
    }

    return _BN(value).mul(_BN(10).pow(decimals));
  };
}

/** Wad function */
const _W = amountFunction(18);

/** Ray function */
const _R = amountFunction(27);

/**
 * Returns a role identifier by computing the keccak of the role name.
 */
function getRole(role) {
  if (role.startsWith("0x")) return role;
  return role === "DEFAULT_ADMIN_ROLE"
    ? ethers.constants.HashZero
    : ethers.utils.keccak256(ethers.utils.toUtf8Bytes(role));
}

/**
 * Builds the component role identifier
 *
 * Mimics the behaviour of the AccessManager.getComponentRole method
 *
 * Component roles are roles created doing XOR between the component
 * address and the original role.
 *
 * Example:
 *     getComponentRole("0xc6e7DF5E7b4f2A278906862b61205850344D4e7d", "ORACLE_ADMIN_ROLE")
 *     // "0x05e01b185238b49f750d03d945e38a7f6c3be8b54de0ee42d481eb7814f0d3a8"
 */
function getComponentRole(componentAddress, role) {
  if (!role.startsWith("0x")) role = getRole(role);

  // 32 byte array
  const bytesRole = ethers.utils.arrayify(role);

  // 20 byte array
  const bytesAddress = ethers.utils.arrayify(componentAddress);

  // xor each byte, padding bytesAddress with zeros at the end
  // eslint-disable-next-line no-bitwise
  return ethers.utils.hexlify(bytesRole.map((elem, idx) => elem ^ (bytesAddress[idx] || 0)));
}

async function getDefaultSigner(hre) {
  const signers = await hre.ethers.getSigners();
  return signers[0];
}

/**
 * Grant a component role to a user.
 */
// eslint-disable-next-line no-empty-function
async function grantComponentRole(hre, contract, component, role, user, txOverrides = {}, log = () => {}) {
  let userAddress;
  if (user === undefined) {
    user = await getDefaultSigner(hre);
    userAddress = user.address;
  } else {
    userAddress = user.address === undefined ? user : user.address;
  }
  const roleHex = getRole(role);
  const componentAddress = component.address || component;
  const componentRole = await contract.getComponentRole(componentAddress, roleHex);
  if (!(await contract.hasRole(componentRole, userAddress))) {
    await contract.grantComponentRole(componentAddress, roleHex, userAddress, txOverrides);
    log(`Role ${role} (${roleHex}) Component ${componentAddress} granted to ${userAddress}`);
  } else {
    log(`Role ${role} (${roleHex}) Component ${componentAddress} already granted to ${userAddress}`);
  }
}

/**
 * Grant a role to a user
 */
// eslint-disable-next-line no-empty-function
async function grantRole(hre, contract, role, user, txOverrides = {}, log = () => {}) {
  let userAddress;
  if (user === undefined) {
    user = await getDefaultSigner(hre);
    userAddress = user.address;
  } else {
    userAddress = user.address === undefined ? user : user.address;
  }
  const roleHex = getRole(role);
  if (!(await contract.hasRole(roleHex, userAddress))) {
    await contract.grantRole(roleHex, userAddress, txOverrides);
    log(`Role ${role} (${roleHex}) granted to ${userAddress}`);
  } else {
    log(`Role ${role} (${roleHex}) already granted to ${userAddress}`);
  }
}

/**
 * Finds an event in the receipt
 * @param {Interface} interface The interface of the contract that contains the requested event
 * @param {TransactionReceipt} receipt Transaction receipt containing the events in the logs
 * @param {String} eventName The name of the event we are interested in
 * @returns {LogDescription}
 */
function getTransactionEvent(interface, receipt, eventName) {
  // for each log in the transaction receipt
  for (const log of receipt.logs) {
    let parsedLog;
    try {
      parsedLog = interface.parseLog(log);
    } catch (error) {
      continue;
    }
    if (parsedLog.name == eventName) {
      return parsedLog;
    }
  }
  return null; // not found
}

/**
 * Builds AccessControl error message for comparison in tests
 */
function accessControlMessage(address, component, role) {
  const roleHash = component !== null ? getComponentRole(component, role) : getRole(role);

  return `AccessControl: account ${address.toLowerCase()} is missing role ${roleHash}`;
}

/**
 * Create a policy id by combining the riskmodule address and the internal id.
 *
 * Mimics the PolicyPool.newPolicy method of building the policy id.
 */
function makePolicyId(rmAddress, internalId) {
  return _BN(rmAddress).shl(96).add(internalId);
}

/**
 * Create a packed quote message for later signing or hashing.
 *
 * Mimics the behaviour of the SignedQuoteRiskModule._newSignedPolicy method.
 */
function makeQuoteMessage({ rmAddress, payout, premium, lossProb, expiration, policyData, validUntil }) {
  return ethers.utils.solidityPack(
    ["address", "uint256", "uint256", "uint256", "uint40", "bytes32", "uint40"],
    [rmAddress, payout, premium, lossProb, expiration, policyData, validUntil]
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
  return ethers.utils.solidityPack(
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
  return ethers.utils.splitSignature(await signer.signMessage(ethers.utils.arrayify(quoteMessage)));
}

/**
 * Build a default policy parameters object.
 */
async function defaultPolicyParams(
  { rmAddress, payout, premium, lossProb, expiration, policyData, validUntil },
  _A = amountFunction(6)
) {
  const now = await helpers.time.latest();
  return {
    rmAddress,
    payout: payout || _A(1000),
    premium: premium || ethers.constants.MaxUint256,
    lossProb: lossProb || _W(0.1),
    expiration: expiration || now + DAY * 30,
    policyData: policyData || ethers.utils.hexlify(ethers.utils.randomBytes(32)),
    validUntil: validUntil || now + DAY * 30,
  };
}

async function readImplementationAddress(contractAddress) {
  const implStorage = await ethers.provider.getStorageAt(contractAddress, IMPLEMENTATION_SLOT);
  return ethers.utils.getAddress(ethers.utils.hexDataSlice(implStorage, 12));
}

module.exports = {
  _BN,
  _E,
  _R,
  _W,
  accessControlMessage,
  amountFunction,
  defaultPolicyParams,
  getComponentRole,
  getDefaultSigner,
  getRole,
  getStorageLayout,
  getTransactionEvent,
  grantComponentRole,
  grantRole,
  makeBucketQuoteMessage,
  makePolicyId,
  makeQuoteMessage,
  makeSignedQuote,
  RAY,
  readImplementationAddress,
  WAD,
};
