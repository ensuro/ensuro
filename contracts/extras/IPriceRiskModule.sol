// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {IRiskModule} from "../../interfaces/IRiskModule.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/**
 * @title IPriceRiskModule interface
 * @dev Interface for price risk module
 * @author Ensuro
 */
interface IPriceRiskModule is IRiskModule {
  /**
   * @dev Returns the premium and lossProb of the policy
   * @param triggerPrice Price of the asset_ that will trigger the policy (expressed in _currency)
   * @param lower If true -> triggers if the price is lower, If false -> triggers if the price is higher
   * @param payout Expressed in policyPool.currency()
   * @param expiration Expiration of the policy
   * @return premium Premium that needs to be paid
   * @return lossProb Probability of paying the maximum payout
   */
  function pricePolicy(
    uint256 triggerPrice,
    bool lower,
    uint256 payout,
    uint40 expiration
  ) external view returns (uint256 premium, uint256 lossProb);

  function newPolicy(
    uint256 triggerPrice,
    bool lower,
    uint256 payout,
    uint40 expiration
  ) external returns (uint256);

  function triggerPolicy(uint256 policyId) external;

  function referenceCurrency() external view returns (IERC20Metadata);

  function asset() external view returns (IERC20Metadata);
}
