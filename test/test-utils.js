const { expect } = require("chai");
const { BigNumber } = require("ethers");
const {LogDescription} = require("ethers/lib/utils");
exports.WEEK = 3600 * 24 * 7;
exports.DAY = 3600 * 24;

exports.initCurrency = async function(options, initial_targets, initial_balances) {
  const Currency = await ethers.getContractFactory("TestCurrency");
  currency = await Currency.deploy(
    options.name || "Test Currency",
    options.symbol || "TEST",
    options.initial_supply,
    options.decimals || 18,
  );
  initial_targets = initial_targets || [];
  await Promise.all(initial_targets.map(async function (user, index) {
    await currency.transfer(user.address, initial_balances[index]);
  }));
  return currency;
}

exports.approve_multiple = async function(currency, spender, sources, amounts) {
  return Promise.all(sources.map(async function (source, index) {
    await currency.connect(source).approve(spender.address, amounts[index]);
  }));
}

exports.check_balances = async function(currency, users, amounts) {
  return Promise.all(users.map(async function (user, index) {
    expect(await currency.balanceOf(user.address)).to.equal(amounts[index]);
  }));
}

exports.now = function() {
  return Math.floor(new Date().getTime() / 1000);
}

exports.addRiskModule = async function(pool, contractFactory, {
      rmName, scrPercentage, scrInterestRate, ensuroFee, maxScrPerPolicy,
      scrLimit, moc, wallet, extraArgs, extraConstructorArgs
      }) {
  extraArgs = extraArgs || [];
  extraConstructorArgs = extraConstructorArgs || [];
  const _A = pool._A || _W;
  const rm = await hre.upgrades.deployProxy(contractFactory, [
    rmName || "RiskModule",
    _R(scrPercentage) || _R(1),
    _R(ensuroFee) || _R(0),
    _R(scrInterestRate) || _R(0.1),
    _A(maxScrPerPolicy) || _A(1000),
    _A(scrLimit) || _A(1000000),
    wallet || "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",  // Random address
    ...extraArgs
  ], {
    kind: 'uups',
    unsafeAllow: ["delegatecall"],
    constructorArgs: [pool.address, ...extraConstructorArgs]
  });

  await rm.deployed();

  if (moc !== undefined && moc != 1.0) {
    moc = _R(moc);
    await rm.setMoc(moc);
  }
  const policyPoolConfig = await hre.ethers.getContractAt("PolicyPoolConfig", await pool.config());
  await policyPoolConfig.addRiskModule(rm.address);
  return rm;
}

exports.addEToken = async function(pool, {
      etkName, etkSymbol, expirationPeriod, liquidityRequirement, maxUtilizationRate,
      poolLoanInterestRate, extraArgs, extraConstructorArgs
      }) {
  const EToken = await ethers.getContractFactory("EToken");
  extraArgs = extraArgs || [];
  extraConstructorArgs = extraConstructorArgs || [];
  const etk = await hre.upgrades.deployProxy(EToken, [
    etkName || "EToken",
    etkSymbol || "eUSD1YEAR",
    expirationPeriod || (3600 * 24 * 365),
    _R(liquidityRequirement) || _R(1),
    _R(maxUtilizationRate) || _R(1),
    _R(poolLoanInterestRate) || _R("0.05"),
    ...extraArgs
  ], {
    kind: 'uups',
    unsafeAllow: ["delegatecall"],
    constructorArgs: [pool.address, ...extraConstructorArgs]
  });

  await etk.deployed();
  await pool.addEToken(etk.address);
  return etk;
}

exports.expected_change = async function(protocol_attribute, initial, change) {
  change = BigNumber.from(change);
  let actual_value = await protocol_attribute();
  expect(actual_value.sub(initial)).to.equal(change);
  return actual_value;
}

exports.impersonate = async function(address, setBalanceTo) {
  const ok = await hre.network.provider.request(
    {method: "hardhat_impersonateAccount", params: [address]}
  );
  if (!ok)
    throw "Error impersonatting " + address;

  if (setBalanceTo !== undefined)
    await hre.network.provider.request(
      {method: "hardhat_setBalance", params: [address, setBalanceTo.toHexString()]}
    );

  return await ethers.getSigner(address);
}


/**
* Finds an event in the receipt
* @param {Interface} interface The interface of the contract that contains the requested event
* @param {TransactionReceipt} receipt Transaction receipt containing the events in the logs
* @param {String} eventName The name of the event we are interested in
* @returns {LogDescription}
*/
exports.getTransactionEvent = function(interface, receipt, eventName) {
  // for each log in the transaction receipt
  for (const log of receipt.events) {
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
  return null;  // not found
}

exports.deployPool = async function(hre, options) {
  const PolicyPool = await ethers.getContractFactory("PolicyPool");
  const PolicyPoolConfig = await ethers.getContractFactory("PolicyPoolConfig");
  const PolicyNFT = await ethers.getContractFactory("PolicyNFT");

  // Deploy PolicyNFT
  const policyNFT = await hre.upgrades.deployProxy(
    PolicyNFT,
    [
      options.nftName || "Policy NFT",
      options.nftSymbol || "EPOL",
      options.policyPoolDetAddress || ethers.constants.AddressZero
    ],
    {kind: 'uups'}
  );
  await policyNFT.deployed();

  // Deploy PolicyPoolConfig
  const policyPoolConfig = await hre.upgrades.deployProxy(PolicyPoolConfig, [
    options.policyPoolDetAddress || ethers.constants.AddressZero,
    options.treasuryAddress || ethers.constants.AddressZero
  ], {kind: 'uups'});

  await policyPoolConfig.deployed();

  const policyPool = await hre.upgrades.deployProxy(PolicyPool, [], {
    constructorArgs: [policyPoolConfig.address, policyNFT.address, options.currency],
    kind: 'uups',
    unsafeAllow: ["delegatecall"],
  });

  await policyPool.deployed();

  for (const role of (options.grantRoles || [])) {
    await grantRole(hre, policyPoolConfig, role);
  }

  await grantRole(hre, policyPoolConfig, "LEVEL1_ROLE");
  await grantRole(hre, policyPoolConfig, "LEVEL2_ROLE");
  await grantRole(hre, policyPoolConfig, "LEVEL3_ROLE");
  return policyPool;
}

async function _getDefaultSigner(hre) {
  const signers = await hre.ethers.getSigners();
  return signers[0];
}

async function grantRole(hre, contract, role, user) {
  let userAddress;
  if (user === undefined) {
    user = await _getDefaultSigner(hre);
    userAddress = user.address;
  } else {
    userAddress = user;
  }
  const roleHex = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(role));
  if (!await contract.hasRole(roleHex, userAddress)) {
    await contract.grantRole(roleHex, userAddress);
  }
}

exports.grantRole = grantRole;

exports._E = ethers.utils.parseEther;

const _BN = ethers.BigNumber.from;
const WAD = _BN(1e10).mul(_BN(1e8));  // 1e10*1e8=1e18
const RAY = WAD.mul(_BN(1e9));  // 1e18*1e9=1e27

exports._BN = _BN;

const _W = function(value) {
  if (value === undefined)
    return undefined;
  if (!Number.isInteger(value))
    return _BN(Math.round(value * 1e9)).mul(_BN(1e9));
  return _BN(value).mul(WAD);
}

exports._W = _W;

const _R = function(value) {
  if (value === undefined)
    return undefined;
  if (!Number.isInteger(value))
    return _BN(Math.round(value * 1e9)).mul(WAD);
  return _BN(value).mul(RAY);
}

exports._R = _R;

exports.amountFunction = function (decimals) {
  // Decimals must be at least 6
  return function (value) {
    if (value === undefined)
      return undefined;
    if (typeof value === 'string' || value instanceof String) {
      return _BN(value).mul(_BN(Math.pow(10, decimals)));
    } else {
      return _BN(Math.round(value * 1e6)).mul(_BN(Math.pow(10, decimals - 6)));
    }
  }
}
