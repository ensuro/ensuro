// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {IPremiumsAccount} from "./IPremiumsAccount.sol";

/**
 * @title IRiskModule interface
 * @dev Interface for RiskModule smart contracts. Gives access to RiskModule configuration parameters
 * @author Ensuro
 */
interface IRiskModule {
  enum Parameter {
    moc,
    jrCollRatio,
    collRatio,
    ensuroPpFee,
    ensuroCocFee,
    jrRoc,
    srRoc
  }

  struct Params {
    uint256 moc;
    uint256 jrCollRatio;
    uint256 collRatio;
    uint256 ensuroPpFee;
    uint256 ensuroCocFee;
    uint256 jrRoc;
    uint256 srRoc;
  }

  function name() external view returns (string memory);

  function params() external view returns (Params memory);

  function maxPayoutPerPolicy() external view returns (uint256);

  function exposureLimit() external view returns (uint256);

  function activeExposure() external view returns (uint256);

  function wallet() external view returns (address);

  function releaseExposure(uint256 payout) external;

  function premiumsAccount() external view returns (IPremiumsAccount);
}
