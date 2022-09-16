const { expect } = require("chai");
const { BigNumber } = require("ethers");
const { LogDescription } = require("ethers/lib/utils");
exports.WEEK = 3600 * 24 * 7;
exports.DAY = 3600 * 24;

exports.initCurrency = async function (options, initial_targets, initial_balances) {
  const Currency = await ethers.getContractFactory("TestCurrency");
  let currency = await Currency.deploy(
    options.name || "Test Currency",
    options.symbol || "TEST",
    options.initial_supply,
    options.decimals || 18
  );
  initial_targets = initial_targets || [];
  await Promise.all(
    initial_targets.map(async function (user, index) {
      await currency.transfer(user.address, initial_balances[index]);
    })
  );
  return currency;
};

exports.approve_multiple = async function (currency, spender, sources, amounts) {
  return Promise.all(
    sources.map(async function (source, index) {
      await currency.connect(source).approve(spender.address, amounts[index]);
    })
  );
};

exports.check_balances = async function (currency, users, amounts) {
  return Promise.all(
    users.map(async function (user, index) {
      expect(await currency.balanceOf(user.address)).to.equal(amounts[index]);
    })
  );
};

exports.now = function () {
  return Math.floor(new Date().getTime() / 1000);
};

exports.addRiskModule = async function (
  pool,
  premiumsAccount,
  contractFactory,
  {
    rmName,
    scrPercentage,
    scrInterestRate,
    ensuroFee,
    maxScrPerPolicy,
    scrLimit,
    moc,
    wallet,
    extraArgs,
    extraConstructorArgs,
  }
) {
  extraArgs = extraArgs || [];
  extraConstructorArgs = extraConstructorArgs || [];
  const _A = pool._A || _W;
  const rm = await hre.upgrades.deployProxy(
    contractFactory,
    [
      rmName || "RiskModule",
      _W(scrPercentage) || _W(1),
      _W(ensuroFee) || _W(0),
      _W(scrInterestRate) || _W(0.1),
      _A(maxScrPerPolicy) || _A(1000),
      _A(scrLimit) || _A(1000000),
      wallet || "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", // Random address
      ...extraArgs,
    ],
    {
      kind: "uups",
      unsafeAllow: ["delegatecall"],
      constructorArgs: [pool.address, premiumsAccount.address, ...extraConstructorArgs],
    }
  );

  await rm.deployed();

  if (moc !== undefined && moc != 1.0) {
    moc = _W(moc);
    await rm.setParam(0, moc);
  }
  await pool.addRiskModule(rm.address);
  return rm;
};

exports.addEToken = async function (
  pool,
  { etkName, etkSymbol, maxUtilizationRate, poolLoanInterestRate, extraArgs, extraConstructorArgs }
) {
  const EToken = await ethers.getContractFactory("EToken");
  extraArgs = extraArgs || [];
  extraConstructorArgs = extraConstructorArgs || [];
  const etk = await hre.upgrades.deployProxy(
    EToken,
    [
      etkName || "EToken",
      etkSymbol || "eUSD1YEAR",
      _W(maxUtilizationRate) || _W(1),
      _W(poolLoanInterestRate) || _W("0.05"),
      ...extraArgs,
    ],
    {
      kind: "uups",
      unsafeAllow: ["delegatecall"],
      constructorArgs: [pool.address, ...extraConstructorArgs],
    }
  );

  await etk.deployed();
  await pool.addEToken(etk.address);
  return etk;
};

exports.expected_change = async function (protocol_attribute, initial, change) {
  change = BigNumber.from(change);
  let actual_value = await protocol_attribute();
  expect(actual_value.sub(initial)).to.equal(change);
  return actual_value;
};

exports.impersonate = async function (address, setBalanceTo) {
  const ok = await hre.network.provider.request({ method: "hardhat_impersonateAccount", params: [address] });
  if (!ok) throw "Error impersonatting " + address;

  if (setBalanceTo !== undefined)
    await hre.network.provider.request({ method: "hardhat_setBalance", params: [address, setBalanceTo.toHexString()] });

  return await ethers.getSigner(address);
};

/**
 * Finds an event in the receipt
 * @param {Interface} interface The interface of the contract that contains the requested event
 * @param {TransactionReceipt} receipt Transaction receipt containing the events in the logs
 * @param {String} eventName The name of the event we are interested in
 * @returns {LogDescription}
 */
const getTransactionEvent = function (interface, receipt, eventName) {
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
  return null; // not found
};

exports.getTransactionEvent = getTransactionEvent;

exports.deployPool = async function (hre, options) {
  const PolicyPool = await ethers.getContractFactory("PolicyPool");
  const AccessManager = await ethers.getContractFactory("AccessManager");
  const PolicyNFT = await ethers.getContractFactory("PolicyNFT");

  // Deploy PolicyNFT
  const policyNFT = await hre.upgrades.deployProxy(
    PolicyNFT,
    [
      options.nftName || "Policy NFT",
      options.nftSymbol || "EPOL",
      options.policyPoolDetAddress || ethers.constants.AddressZero,
    ],
    { kind: "uups" }
  );
  await policyNFT.deployed();

  // Deploy AccessManager
  const accessManager = await hre.upgrades.deployProxy(AccessManager, [], { kind: "uups" });

  await accessManager.deployed();

  const policyPool = await hre.upgrades.deployProxy(
    PolicyPool,
    [options.treasuryAddress || ethers.constants.AddressZero],
    {
      constructorArgs: [accessManager.address, policyNFT.address, options.currency],
      kind: "uups",
      unsafeAllow: ["delegatecall"],
    }
  );

  await policyPool.deployed();

  for (const role of options.grantRoles || []) {
    await grantRole(hre, accessManager, role);
  }

  await grantRole(hre, accessManager, "LEVEL1_ROLE");
  await grantRole(hre, accessManager, "LEVEL2_ROLE");
  await grantRole(hre, accessManager, "LEVEL3_ROLE");
  return policyPool;
};

exports.deployPremiumsAccount = async function (hre, pool, options) {
  const PremiumsAccount = await ethers.getContractFactory("PremiumsAccount");
  const premiumsAccount = await hre.upgrades.deployProxy(PremiumsAccount, [], {
    constructorArgs: [
      pool.address,
      options.jrEtkAddr || ethers.constants.AddressZero,
      options.srEtkAddr || ethers.constants.AddressZero,
    ],
    kind: "uups",
    unsafeAllow: ["delegatecall"],
  });

  await premiumsAccount.deployed();
  await pool.addPremiumsAccount(premiumsAccount.address);
  return premiumsAccount;
};

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
  if (!(await contract.hasRole(roleHex, userAddress))) {
    await contract.grantRole(roleHex, userAddress);
  }
}

exports.grantRole = grantRole;

async function grantComponentRole(hre, accessManager, component, role, user) {
  let userAddress;
  if (user === undefined) {
    user = await _getDefaultSigner(hre);
    userAddress = user.address;
  } else {
    userAddress = user.address === undefined ? user : user.address;
  }
  const roleHex = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(role));
  const componentRole = await accessManager.getComponentRole(component.address, roleHex);
  console.log("componentRole", componentRole);
  if (!(await accessManager.hasRole(componentRole, userAddress))) {
    console.log("componentRole - sd", componentRole);
    await accessManager.grantComponentRole(component.address, roleHex, userAddress);
  }
}

exports.grantComponentRole = grantComponentRole;

exports._E = ethers.utils.parseEther;

const _BN = ethers.BigNumber.from;
const WAD = _BN(1e10).mul(_BN(1e8)); // 1e10*1e8=1e18
const RAY = WAD.mul(_BN(1e9)); // 1e18*1e9=1e27

exports._BN = _BN;

const _W = function (value) {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value)) return _BN(Math.round(value * 1e9)).mul(_BN(1e9));
  return _BN(value).mul(WAD);
};

exports._W = _W;

const _R = function (value) {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value)) return _BN(Math.round(value * 1e9)).mul(WAD);
  return _BN(value).mul(RAY);
};

exports._R = _R;

exports.amountFunction = function (decimals) {
  // Decimals must be at least 6
  return function (value) {
    if (value === undefined) return undefined;
    if (typeof value === "string" || value instanceof String) {
      return _BN(value).mul(_BN(Math.pow(10, decimals)));
    } else {
      return _BN(Math.round(value * 1e6)).mul(_BN(Math.pow(10, decimals - 6)));
    }
  };
};

/*
Builds the component role identifier

Mimics the behaviour of the PolicyPoolConfig.getComponentRole method

Component roles are roles created doing XOR between the component
address and the original role.

Example:
    getComponentRole("0xc6e7DF5E7b4f2A278906862b61205850344D4e7d", "ORACLE_ADMIN_ROLE")
    // "0x05e01b185238b49f750d03d945e38a7f6c3be8b54de0ee42d481eb7814f0d3a8"
*/
function getComponentRole(componentAddress, roleName) {
  // 32 byte array
  const bytesRole = ethers.utils.arrayify(ethers.utils.keccak256(ethers.utils.toUtf8Bytes(roleName)));

  // 20 byte array
  const bytesAddress = ethers.utils.arrayify(componentAddress);

  // xor each byte, padding bytesAddress with zeros at the end
  return ethers.utils.hexlify(bytesRole.map((elem, idx) => elem ^ (bytesAddress[idx] || 0)));
}

exports.getComponentRole = getComponentRole;

/*
Builds AccessControl error message for comparison in tests
*/
function accessControlMessage(address, component, role) {
  return `AccessControl: account ${address.toLowerCase()} is missing role ${getComponentRole(component, role)}`;
}

exports.accessControlMessage = accessControlMessage;

function makePolicyId(rm, internalId) {
  return ethers.BigNumber.from(rm.address).shl(96).add(internalId);
}

exports.makePolicyId = makePolicyId;

async function makePolicy(pool, rm, cust, payout, premium, lossProb, expiration, internalId) {
  let tx = await rm.connect(cust).newPolicy(payout, premium, lossProb, expiration, cust.address, internalId);
  let receipt = await tx.wait();
  const newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");

  return newPolicyEvt;
}

exports.makePolicy = makePolicy;

async function blockchainNow(owner) {
  return (await owner.provider.getBlock("latest")).timestamp;
}

exports.blockchainNow = blockchainNow;
