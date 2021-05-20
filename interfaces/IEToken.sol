pragma solidity ^0.8.0;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IEToken is IERC20 {
  event SCRLocked(uint256 interest_rate, uint256 value);
  event SCRUnlocked(uint256 interest_rate, uint256 value);

  function getCurrentIndex(bool updated) external view returns (uint256);

  function ocean() external view returns (uint256);

  function scr() external view returns (uint256);

  function scrInterestRate() external view returns (uint256);

  function tokenInterestRate() external view returns (uint256);

  function lockScr(uint256 policy_interest_rate, uint256 scr_amount) external;

  function unlockScr(uint256 policy_interest_rate, uint256 scr_amount) external ;
  function discreteEarning(uint256 amount, bool positive) external;

  function assetEarnings(uint256 amount, bool positive) external;

  function deposit(address provider, uint256 amount) external returns (uint256);

  function totalWithdrawable() external view returns (uint256);

  function withdraw(address provider, uint256 amount) external returns (uint256);

  function accepts(uint40 policy_expiration) external view returns (bool);

  function lendToPool(uint256 amount) external;

  function repayPoolLoan(uint256 amount) external;

  function getPoolLoan() external view returns (uint256);

  function poolLoanInterestRate() external view returns (uint256);

  function setPoolLoanInterestRate(uint256 new_interest_rate) external;

  function setLiquidityRequirement(uint256 new_liq_req) external;

  function getInvestable() external view returns (uint256);
}
