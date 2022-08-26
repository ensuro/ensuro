// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {IAccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {ILPWhitelist} from "./ILPWhitelist.sol";
import {IRiskModule} from "./IRiskModule.sol";
import {IExchange} from "./IExchange.sol";

/**
 * @title IPolicyPoolAccess - Interface for the contract that handles roles for the PolicyPool and components
 * @dev Interface for the contract that handles roles for the PolicyPool and components
 * @author Ensuro
 */
interface IPolicyPoolConfig is IAccessControlUpgradeable {
  enum GovernanceActions {
    none,
    setTreasury, // Changes PolicyPool treasury address
    setAssetManager, // Changes PolicyPool AssetManager
    setInsolvencyHook, // Changes PolicyPool InsolvencyHook
    setLPWhitelist, // Changes PolicyPool Liquidity Providers Whitelist
    addRiskModule,
    removeRiskModule,
    cfgFiller1, // Reserve space for future PolicyPoolConfig actions
    cfgFiller2, // Reserve space for future PolicyPoolConfig actions
    cfgFiller3, // Reserve space for future PolicyPoolConfig actions
    cfgFiller4, // Reserve space for future PolicyPoolConfig actions
    // RiskModule Governance Actions
    setMoc,
    setJrCollRatio,
    setCollRatio,
    setEnsuroPpFee,
    setEnsuroCocFee,
    setJrRoc,
    setSrRoc,
    setMaxPayoutPerPolicy,
    setExposureLimit,
    setMaxDuration,
    setWallet,
    rmFiller1, // Reserve space for future RM actions
    rmFiller2, // Reserve space for future RM actions
    rmFiller3, // Reserve space for future RM actions
    rmFiller4, // Reserve space for future RM actions
    // EToken Governance Actions
    setLiquidityRequirement,
    setMinUtilizationRate,
    setMaxUtilizationRate,
    setInternalLoanInterestRate,
    etkFiller1, // Reserve space for future EToken actions
    etkFiller2, // Reserve space for future EToken actions
    etkFiller3, // Reserve space for future EToken actions
    etkFiller4, // Reserve space for future EToken actions
    // AssetManager Governance Actions
    setLiquidityMin,
    setLiquidityMiddle,
    setLiquidityMax,
    // AaveAssetManager Governance Actions
    setClaimRewardsMin,
    setReinvestRewardsMin,
    setMaxSlippage,
    setExchange, // Changes exchange helper contract
    setPriceOracle, // Changes exchange's PriceOracle
    setSwapRouter, // Changes exchange's SwapRouter
    last
  }

  enum RiskModuleStatus {
    inactive, // newPolicy and resolvePolicy rejected
    active, // newPolicy and resolvePolicy accepted
    deprecated, // newPolicy rejected, resolvePolicy accepted
    suspended // newPolicy and resolvePolicy rejected (temporarily)
  }

  event RiskModuleStatusChanged(IRiskModule indexed riskModule, RiskModuleStatus newStatus);

  function checkRole(bytes32 role, address account) external view;

  function checkComponentRole(
    address component,
    bytes32 role,
    address account
  ) external view;

  function checkRole2(
    bytes32 role1,
    bytes32 role2,
    address account
  ) external view;

  function connect() external;

  function lpWhitelist() external view returns (ILPWhitelist);

  function exchange() external view returns (IExchange);

  function treasury() external view returns (address);

  function checkAcceptsNewPolicy(IRiskModule riskModule) external view;

  function checkAcceptsResolvePolicy(IRiskModule riskModule) external view;
}
