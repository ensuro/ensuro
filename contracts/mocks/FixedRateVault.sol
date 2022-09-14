//SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IMintableERC20} from "./IMintableERC20.sol";
import {TimeScaled} from "../TimeScaled.sol";

contract FixedRateVault is ERC4626 {
  using TimeScaled for TimeScaled.ScaledAmount;

  uint256 internal _interestRate;
  TimeScaled.ScaledAmount internal _totalAssets;
  bool internal _broken;

  constructor(
    string memory name_,
    string memory symbol_,
    IERC20Metadata asset_,
    uint256 interestRate_
  ) ERC20(name_, symbol_) ERC4626(asset_) {
    _interestRate = interestRate_;
    _totalAssets.init();
  }

  /** @dev See {IERC4262-totalAssets}. */
  function totalAssets() public view virtual override returns (uint256) {
    require(!_broken, "Vault is broken");
    return _totalAssets.getScaledAmount(_interestRate);
  }

  /**
   * @dev Deposit/mint common workflow.
   */
  function _deposit(
    address caller,
    address receiver,
    uint256 assets,
    uint256 shares
  ) internal virtual override {
    require(!_broken, "Vault is broken");
    _totalAssets.add(assets, _interestRate);
    super._deposit(caller, receiver, assets, shares);
  }

  /**
   * @dev Withdraw/redeem common workflow.
   */
  function _withdraw(
    address caller,
    address receiver,
    address owner,
    uint256 assets,
    uint256 shares
  ) internal virtual override {
    require(!_broken, "Vault is broken");
    _totalAssets.sub(assets, _interestRate);
    uint256 balance = IERC20Metadata(asset()).balanceOf(address(this));
    if (balance < assets) {
      // Here comes the magic! Free money!
      IMintableERC20(asset()).mint(address(this), assets - balance);
    }
    super._withdraw(caller, receiver, owner, assets, shares);
  }

  /*
   * @dev Adds or remove assets not generated by deposits/withdraw - For testing discrete earnings/losses
   */
  function discreteEarning(int256 assets) external {
    if (assets > 0) {
      _totalAssets.add(uint256(assets), _interestRate);
    } else {
      _totalAssets.sub(uint256(-assets), _interestRate);
    }
  }

  function setBroken(bool broken_) external {
    _broken = broken_;
  }

  function broken() external view returns (bool) {
    return _broken;
  }
}
