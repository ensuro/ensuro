// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IEToken} from "./interfaces/IEToken.sol";

/**
 * @title WEToken - Non-rebasing wrapper for Ensuro EToken
 * @notice Wraps the rebasing EToken into a non-rebasing ERC20 token with static balances.
 *         1 WEToken = 1 unit of scaled balance in the underlying EToken.
 *         As the EToken accrues yield, each WEToken becomes redeemable for more eTokens.
 * @dev The conversion between eTokens and WETokens uses {IEToken-getCurrentScale}:
 *        wetkAmount = etkAmount * WAD / scale
 *        etkAmount  = wetkAmount * scale / WAD
 *      If the underlying eToken has a whitelist, this contract's address must be whitelisted.
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
contract WEToken is ERC20, ERC20Permit {
  using SafeERC20 for IERC20;

  uint256 internal constant WAD = 1e18;

  /// @notice Thrown when wrapping or unwrapping a zero amount
  error ZeroAmount();

  /// @notice The underlying rebasing EToken
  IEToken public immutable eToken;

  /**
   * @param eToken_ The underlying rebasing EToken to wrap
   * @param name_ Name for the wrapped token
   * @param symbol_ Symbol for the wrapped token
   */
  constructor(
    IEToken eToken_,
    string memory name_,
    string memory symbol_
  ) ERC20(name_, symbol_) ERC20Permit(name_) {
    eToken = eToken_;
  }

  /// @inheritdoc ERC20
  function decimals() public pure override returns (uint8) {
    return 18;
  }

  /**
   * @notice Exchanges eTokens for WETokens
   * @param etkAmount Amount of eTokens to wrap (in eToken units)
   * @return wetkAmount Amount of WETokens minted
   */
  function wrap(uint256 etkAmount) external returns (uint256 wetkAmount) {
    require(etkAmount != 0, ZeroAmount());
    wetkAmount = getWETokenByEToken(etkAmount);
    IERC20(address(eToken)).safeTransferFrom(msg.sender, address(this), etkAmount);
    _mint(msg.sender, wetkAmount);
    return wetkAmount;
  }

  /**
   * @notice Exchanges WETokens back for eTokens
   * @param wetkAmount Amount of WETokens to unwrap
   * @return etkAmount Amount of eTokens returned
   */
  function unwrap(uint256 wetkAmount) external returns (uint256 etkAmount) {
    require(wetkAmount != 0, ZeroAmount());
    etkAmount = getETokenByWEToken(wetkAmount);
    _burn(msg.sender, wetkAmount);
    IERC20(address(eToken)).safeTransfer(msg.sender, etkAmount);
    return etkAmount;
  }

  /**
   * @notice Returns the amount of WETokens for a given amount of eTokens
   * @param etkAmount Amount of eTokens (in eToken units)
   * @return Amount of WETokens
   */
  function getWETokenByEToken(uint256 etkAmount) public view returns (uint256) {
    return Math.mulDiv(etkAmount, WAD, eToken.getCurrentScale(true));
  }

  /**
   * @notice Returns the amount of eTokens for a given amount of WETokens
   * @param wetkAmount Amount of WETokens
   * @return Amount of eTokens (in eToken units)
   */
  function getETokenByWEToken(uint256 wetkAmount) public view returns (uint256) {
    return Math.mulDiv(wetkAmount, eToken.getCurrentScale(true), WAD);
  }

  /**
   * @notice Returns the amount of eTokens for 1 WEToken (i.e. 1e18 WEToken units)
   * @return The current scale from the underlying eToken, in WAD
   */
  function eTokenPerWEToken() external view returns (uint256) {
    return eToken.getCurrentScale(true);
  }

  /**
   * @notice Returns the amount of WETokens for 1e18 eToken units
   * @return Amount of WETokens per WAD of eTokens
   */
  function weTokenPerEToken() external view returns (uint256) {
    return Math.mulDiv(WAD, WAD, eToken.getCurrentScale(true));
  }
}
