// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title IEToken interface
 * @dev Interface for EToken smart contracts, these are the capital pools.
 * @author Ensuro
 */
interface IEToken is IERC20 {
  event SCRLocked(uint256 interestRate, uint256 value);
  event SCRUnlocked(uint256 interestRate, uint256 value);

  function scr() external view returns (uint256);

  function lockScr(uint256 scrAmount, uint256 policyInterestRate) external;

  function unlockScr(
    uint256 scrAmount,
    uint256 policyInterestRate,
    int256 adjustment
  ) external;

  function deposit(address provider, uint256 amount) external returns (uint256);

  function totalWithdrawable() external view returns (uint256);

  function withdraw(address provider, uint256 amount) external returns (uint256);

  function addBorrower(address borrower) external;

  function lendToPool(
    uint256 amount,
    address receiver,
    bool fromAvailable
  ) external returns (uint256);

  function repayPoolLoan(uint256 amount, address onBehalfOf) external;

  function getPoolLoan(address borrower) external view returns (uint256);

  function tokenInterestRate() external view returns (uint256);

  function scrInterestRate() external view returns (uint256);
}
