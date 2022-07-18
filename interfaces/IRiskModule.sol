// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {IPremiumsAccount} from "./IPremiumsAccount.sol";

/**
 * @title IRiskModule interface
 * @dev Interface for RiskModule smart contracts. Gives access to RiskModule configuration parameters
 * @author Ensuro
 */
interface IRiskModule {
  function name() external view returns (string memory);

  function collRatio() external view returns (uint256);

  function moc() external view returns (uint256);

  function ensuroPpFee() external view returns (uint256);

  function ensuroCocFee() external view returns (uint256);

  function roc() external view returns (uint256);

  function maxPayoutPerPolicy() external view returns (uint256);

  function exposureLimit() external view returns (uint256);

  function activeExposure() external view returns (uint256);

  function wallet() external view returns (address);

  function releaseExposure(uint256 payout) external;

  function premiumsAccount() external view returns (IPremiumsAccount);
}
