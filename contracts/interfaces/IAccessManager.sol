// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {IAccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";

/**
 * @title IAccessManager - Interface for the contract that handles roles for the PolicyPool and components
 * @dev Interface for the contract that handles roles for the PolicyPool and components
 * @author Ensuro
 */
interface IAccessManager is IAccessControlUpgradeable {
  /**
   * @dev Enum with the different governance actions supported in the protocol.
   *      It's good to keep actions of the same component consecutive, parts of the code relay on that,
   *      so we put some fillers in case new actions are added.
   */
  enum GovernanceActions {
    none,
    setTreasury, // Changes PolicyPool treasury address
    setAssetManager, // Change in the asset manager strategy of a reserve
    setAssetManagerForced, // Change in the asset manager strategy of a reserve, forced (deinvest failed)
    ppFiller1, // Reserve space for future PolicyPool or AccessManager actions
    ppFiller2, // Reserve space for future PolicyPool or AccessManager actions
    ppFiller3, // Reserve space for future PolicyPool or AccessManager actions
    ppFiller4, // Reserve space for future PolicyPool or AccessManager actions
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
    setLPWhitelist, // Changes EToken Liquidity Providers Whitelist
    setLiquidityRequirement,
    setMinUtilizationRate,
    setMaxUtilizationRate,
    setInternalLoanInterestRate,
    etkFiller1, // Reserve space for future EToken actions
    etkFiller2, // Reserve space for future EToken actions
    etkFiller3, // Reserve space for future EToken actions
    etkFiller4, // Reserve space for future EToken actions
    // PremiumsAccount Governance Actions
    setDeficitRatio,
    setDeficitRatioWithAdjustment,
    paFiller1,
    paFiller2,
    paFiller3,
    paFiller4,
    // AssetManager Governance Actions
    setLiquidityMin,
    setLiquidityMiddle,
    setLiquidityMax,
    amFiller1, // Reserve space for future Asset Manager actions
    amFiller2, // Reserve space for future Asset Manager actions
    amFiller3, // Reserve space for future Asset Manager actions
    amFiller4, // Reserve space for future Asset Manager actions
    last
  }

  /**
   * @dev Gets a role identifier mixing the hash of the global role and the address of the component
   *
   * @param component The component where this role will apply
   * @param role A role such as `keccak256("LEVEL1_ROLE")` that's global
   * @return A new role, mixing (XOR) the component address and the role.
   */
  function getComponentRole(address component, bytes32 role) external view returns (bytes32);

  /**
   * @dev Tells if a user has been granted a given role for a component
   *
   * @param component The component where this role will apply
   * @param role A role such as `keccak256("LEVEL1_ROLE")` that's global
   * @param account The user address for who we want to verify the permission
   * @param alsoGlobal If true, it will return if the users has either the component role, or the role itself.
   *                   If false, only the component role is accepted
   * @return Whether the user has or not any of the roles
   */
  function hasComponentRole(
    address component,
    bytes32 role,
    address account,
    bool alsoGlobal
  ) external view returns (bool);

  /**
   * @dev Checks if a user has been granted a given role and reverts if it doesn't
   *
   * @param role A role such as `keccak256("LEVEL1_ROLE")` that's global
   * @param account The user address for who we want to verify the permission
   */
  function checkRole(bytes32 role, address account) external view;

  /**
   * @dev Checks if a user has been granted any of the two roles specified and reverts if it doesn't
   *
   * @param role1 A role such as `keccak256("LEVEL1_ROLE")` that's global
   * @param role2 Another role such as `keccak256("GUARDIAN_ROLE")` that's global
   * @param account The user address for who we want to verify the permission
   */
  function checkRole2(
    bytes32 role1,
    bytes32 role2,
    address account
  ) external view;

  /**
   * @dev Checks if a user has been granted a given component role and reverts if it doesn't
   *
   * @param role A role such as `keccak256("LEVEL1_ROLE")` that's global
   * @param account The user address for who we want to verify the permission
   * @param alsoGlobal If true, it will accept not only the component role, but also the (global) `role` itself.
   *                   If false, only the component role is accepted
   */
  function checkComponentRole(
    address component,
    bytes32 role,
    address account,
    bool alsoGlobal
  ) external view;

  /**
   * @dev Checks if a user has been granted any of the two component roles specified and reverts if it doesn't
   *
   * @param role1 A role such as `keccak256("LEVEL1_ROLE")` that's global
   * @param role2 Another role such as `keccak256("GUARDIAN_ROLE")` that's global
   * @param account The user address for who we want to verify the permission
   * @param alsoGlobal If true, it will accept not only the component roles, but also the global ones.
   *                   If false, only the component roles are accepted
   */
  function checkComponentRole2(
    address component,
    bytes32 role1,
    bytes32 role2,
    address account,
    bool alsoGlobal
  ) external view;
}
