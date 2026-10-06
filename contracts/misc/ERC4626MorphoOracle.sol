// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

/// @title IOracle
/// @author Morpho Labs
/// @custom:contact security@morpho.org
/// @notice Interface that oracles used by Morpho must implement.
/// @dev It is the user's responsibility to select markets with safe oracles.
///      Source: https://github.com/morpho-org/morpho-blue/blob/main/src/interfaces/IOracle.sol
interface IOracle {
  /// @notice Returns the price of 1 asset of collateral token quoted in 1 asset of loan token, scaled by 1e36.
  /// @dev It corresponds to the price of 10**(collateral token decimals) assets of collateral token quoted in
  /// 10**(loan token decimals) assets of loan token with `36 + loan token decimals - collateral token decimals`
  /// decimals of precision.
  function price() external view returns (uint256);
}

/**
 * @title ERC4626 Morpho Oracle
 * @notice Morpho {IOracle} implementation that returns the price of one full ERC-4626 vault share (the
 *         collateral token, e.g. WEToken) quoted in the vault's underlying asset (the loan token, e.g. EToken/USDC).
 * @dev The price is computed as `vault.convertToAssets(10**decimals) * 10**(36 - decimals)`, i.e. the amount of
 *      underlying assets received for one full share, scaled to Morpho's 1e36 convention. `convertToAssets` rounds
 *      down, which is the conservative (safe) direction for collateral valuation.
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
contract ERC4626MorphoOracle is IOracle {
  /// @notice The ERC-4626 vault (collateral token) whose share price is reported.
  IERC4626 public immutable vault;

  /// @notice One full share (10 ** vault decimals) whose underlying value is reported.
  uint256 private immutable _oneShare;

  /// @notice Scaling factor applied to the underlying amount to match Morpho's 1e36 price convention.
  uint256 private immutable _priceScale; // 10 ** (36 - vault decimals)

  /**
   * @param vault_ The ERC-4626 vault (collateral token) whose share price is reported.
   */
  constructor(IERC4626 vault_) {
    vault = vault_;
    _oneShare = 10 ** vault_.decimals();
    _priceScale = 10 ** (36 - vault_.decimals());
  }

  /// @inheritdoc IOracle
  function price() external view override returns (uint256) {
    return vault.convertToAssets(_oneShare) * _priceScale;
  }
}
