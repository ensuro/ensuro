// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {IEToken} from "./IEToken.sol";

/**
 * @title ILPWhitelist - Interface that handles the whitelisting of Liquidity Providers
 * @author Ensuro
 */
interface ILPWhitelist {
  /**
   * @dev Indicates whether or not a liquidity provider can do a deposit in an eToken.
   *
   * @param etoken The eToken (see {EToken}) where the provider wants to deposit money.
   * @param provider The address of the liquidity provider (user) that wants to deposit
   * @param amount The amount of the deposit
   * @return true if `provider` deposit is accepted, false if not
   */
  function acceptsDeposit(IEToken etoken, address provider, uint256 amount) external view returns (bool);

  /**
   * @dev Indicates whether or not the eTokens can be transferred from `providerFrom` to `providerTo`
   *
   * @param etoken The eToken (see {EToken}) that the LPs have the intention to transfer.
   * @param providerFrom The current owner of the tokens
   * @param providerTo The destination of the tokens if the transfer is accepted
   * @param amount The amount of tokens to be transferred
   * @return true if the transfer operation is accepted, false if not.
   */
  function acceptsTransfer(
    IEToken etoken,
    address providerFrom,
    address providerTo,
    uint256 amount
  ) external view returns (bool);

  /**
   * @dev Indicates whether or not a liquidity provider can withdraw an eToken.
   *
   * @param etoken The eToken (see {EToken}) where the provider wants to withdraw money.
   * @param provider The address of the liquidity provider (user) that wants to withdraw
   * @param amount The amount of the withdrawal
   * @return true if `provider` withdraw request is accepted, false if not
   */
  function acceptsWithdrawal(IEToken etoken, address provider, uint256 amount) external view returns (bool);
}
