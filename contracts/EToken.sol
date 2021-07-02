// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/security/Pausable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import {IPolicyPool} from '../interfaces/IPolicyPool.sol';
import {IPolicyPoolComponent} from '../interfaces/IPolicyPoolComponent.sol';
import {IEToken} from '../interfaces/IEToken.sol';
import {WadRayMath} from './WadRayMath.sol';

/**
 * @title Ensuro ERC20 EToken
 * @dev Implementation of the interest/earnings bearing token for the Ensuro protocol
 * @author Ensuro
 */
contract EToken is AccessControl, Pausable, IERC20, IEToken, IPolicyPoolComponent {
  bytes32 public constant SET_LOAN_RATE_ROLE = keccak256("SET_LOAN_RATE_ROLE");
  bytes32 public constant SET_LIQ_PARAMS_ROLE = keccak256("SET_LIQ_PARAMS_ROLE");
  bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

  using WadRayMath for uint256;
  using SafeERC20 for IERC20;

  uint256 internal constant SECONDS_PER_YEAR = 365 days;

  // Attributes taken from ERC20
  mapping (address => uint256) private _balances;
  mapping (address => mapping (address => uint256)) private _allowances;
  uint256 private _totalSupply;

  string private _name;
  string private _symbol;

  IPolicyPool internal _policyPool;

  uint40 internal _expirationPeriod;
  uint256 internal _scaleFactor;  // in Ray
  uint40 internal _lastScaleUpdate;

  uint256 internal _scr;  // in Wad
  uint256 internal _scrInterestRate;  // in Ray
  uint256 internal _tokenInterestRate;  // in Ray
  uint256 internal _liquidityRequirement;  // in Ray - Liquidity requirement to lock more than SCR
  uint256 internal _maxUtilizationRate;  // in Ray - Maximum SCR/totalSupply rate for backup up new policies

  uint256 internal _poolLoan;  // in Wad
  uint256 internal _poolLoanInterestRate;  // in Ray
  uint256 internal _poolLoanScale;  // in Ray
  uint40 internal _poolLoanLastUpdate;

  modifier onlyPolicyPool {
    require(_msgSender() == address(_policyPool), "The caller must be the PolicyPool");
    _;
  }

  modifier onlyAssetManager {
    require(_msgSender() == _policyPool.assetManager(), "The caller must be the PolicyPool's AssetManager");
    _;
  }

  /**
   * @dev Initializes the eToken
   * @param policyPool_ The address of the Ensuro PolicyPool where this eToken will be used
   * @param expirationPeriod Maximum expirationPeriod (from block.timestamp) of policies to be accepted
   * @param liquidityRequirement_ Liquidity requirement to allow withdrawal (in Ray - default=1 Ray)
   * @param maxUtilizationRate_ Max utilization rate (scr/totalSupply) (in Ray - default=1 Ray)
   * @param poolLoanInterestRate_ Rate of loans givencrto the policy pool (in Ray)
   * @param name_ Name of the eToken
   * @param symbol_ Symbol of the eToken
   */
  constructor(
    string memory name_,
    string memory symbol_,
    IPolicyPool policyPool_,
    uint40 expirationPeriod,
    uint256 liquidityRequirement_,
    uint256 maxUtilizationRate_,
    uint256 poolLoanInterestRate_
  ) {
    _name = name_;
    _symbol = symbol_;
    _policyPool = policyPool_;
    _expirationPeriod = expirationPeriod;
    _scaleFactor = WadRayMath.ray();
    _lastScaleUpdate = uint40(block.timestamp);
    _scr = 0;
    _scrInterestRate = 0;
    _tokenInterestRate = 0;
    _liquidityRequirement = liquidityRequirement_;
    _maxUtilizationRate = maxUtilizationRate_;

    _poolLoan = 0;
    _poolLoanInterestRate = poolLoanInterestRate_;
    _poolLoanScale = WadRayMath.ray();
    _poolLoanLastUpdate = uint40(block.timestamp);
    _setupRole(DEFAULT_ADMIN_ROLE, _msgSender());
  }

  /*** BEGIN ERC20 methods - mainly copied from OpenZeppelin but changes in events and scaled_amount */

  /**
   * @dev Returns the name of the token.
   */
  function name() public view virtual returns (string memory) {
      return _name;
  }

  /**
   * @dev Returns the symbol of the token, usually a shorter version of the
   * name.
   */
  function symbol() public view virtual returns (string memory) {
      return _symbol;
  }

  /**
   * @dev Returns the number of decimals used to get its user representation.
   * For example, if `decimals` equals `2`, a balance of `505` tokens should
   * be displayed to a user as `5,05` (`505 / 10 ** 2`).
   *
   * Tokens usually opt for a value of 18, imitating the relationship between
   * Ether and Wei. This is the value {ERC20} uses, unless this function is
   * overloaded;
   *
   * NOTE: This information is only used for _display_ purposes: it in
   * no way affects any of the arithmetic of the contract, including
   * {IERC20-balanceOf} and {IERC20-transfer}.
   */
  function decimals() public view virtual returns (uint8) {
      return 18;
  }

  /**
   * @dev Pauses all token transfers.
   *
   * See {ERC20Pausable} and {Pausable-_pause}.
   *
   * Requirements:
   *
   * - the caller must have the `PAUSER_ROLE`.
   */
  function pause() public virtual {
    require(hasRole(PAUSER_ROLE, _msgSender()), "EToken: must have pauser role to pause");
    _pause();
  }

  /**
   * @dev Unpauses all token transfers.
   *
   * See {ERC20Pausable} and {Pausable-_unpause}.
   *
   * Requirements:
   *
   * - the caller must have the `PAUSER_ROLE`.
   */
  function unpause() public virtual {
    require(hasRole(PAUSER_ROLE, _msgSender()), "EToken: must have pauser role to unpause");
    _unpause();
  }

  /**
   * @dev See {IERC20-totalSupply}.
   */
  function totalSupply() public view virtual override returns (uint256) {
    return _totalSupply.wadToRay().rayMul(_calculateCurrentScale()).rayToWad();
  }


  /**
   * @dev See {IERC20-balanceOf}.
   */
  function balanceOf(address account) public view virtual override returns (uint256) {
    uint256 principal_balance = _balances[account];
    if (principal_balance == 0)
      return 0;
    return principal_balance.wadToRay().rayMul(_calculateCurrentScale()).rayToWad();
  }


  /**
   * @dev See {IERC20-transfer}.
   *
   * Requirements:
   *
   * - `recipient` cannot be the zero address.
   * - the caller must have a balance of at least `amount`.
   */
  function transfer(address recipient, uint256 amount) public virtual override returns (bool) {
    _transfer(_msgSender(), recipient, amount);
    return true;
  }

  /**
   * @dev See {IERC20-allowance}.
   */
  function allowance(address owner, address spender) public view virtual override returns (uint256) {
    return _allowances[owner][spender];
  }

  /**
   * @dev See {IERC20-approve}.
   *
   * Requirements:
   *
   * - `spender` cannot be the zero address.
   */
  function approve(address spender, uint256 amount) public virtual override returns (bool) {
    _approve(_msgSender(), spender, amount);
    return true;
  }

  /**
   * @dev See {IERC20-transferFrom}.
   *
   * Emits an {Approval} event indicating the updated allowance. This is not
   * required by the EIP. See the note at the beginning of {ERC20}.
   *
   * Requirements:
   *
   * - `sender` and `recipient` cannot be the zero address.
   * - `sender` must have a balance of at least `amount`.
   * - the caller must have allowance for ``sender``'s tokens of at least
   * `amount`.
   */
  function transferFrom(address sender, address recipient, uint256 amount) public virtual override returns (bool) {
    _transfer(sender, recipient, amount);

    uint256 currentAllowance = _allowances[sender][_msgSender()];
    require(currentAllowance >= amount, "EToken: transfer amount exceeds allowance");
    _approve(sender, _msgSender(), currentAllowance - amount);

    return true;
  }

  /**
   * @dev Atomically increases the allowance granted to `spender` by the caller.
   *
   * This is an alternative to {approve} that can be used as a mitigation for
   * problems described in {IERC20-approve}.
   *
   * Emits an {Approval} event indicating the updated allowance.
   *
   * Requirements:
   *
   * - `spender` cannot be the zero address.
   */
  function increaseAllowance(address spender, uint256 addedValue) public virtual returns (bool) {
    _approve(_msgSender(), spender, _allowances[_msgSender()][spender] + addedValue);
    return true;
  }

  /**
   * @dev Atomically decreases the allowance granted to `spender` by the caller.
   *
   * This is an alternative to {approve} that can be used as a mitigation for
   * problems described in {IERC20-approve}.
   *
   * Emits an {Approval} event indicating the updated allowance.
   *
   * Requirements:
   *
   * - `spender` cannot be the zero address.
   * - `spender` must have allowance for the caller of at least
   * `subtractedValue`.
   */
  function decreaseAllowance(address spender, uint256 subtractedValue) public virtual returns (bool) {
    uint256 currentAllowance = _allowances[_msgSender()][spender];
    require(currentAllowance >= subtractedValue, "EToken: decreased allowance below zero");
    _approve(_msgSender(), spender, currentAllowance - subtractedValue);

    return true;
  }

  function _scale_amount(uint256 amount) internal view returns (uint256) {
    return amount.wadToRay().rayDiv(_calculateCurrentScale()).rayToWad();
  }

  /**
   * @dev Moves tokens `amount` from `sender` to `recipient`.
   *
   * This is internal function is equivalent to {transfer}, and can be used to
   * e.g. implement automatic token fees, slashing mechanisms, etc.
   *
   * Emits a {Transfer} event.
   *
   * Requirements:
   *
   * - `sender` cannot be the zero address.
   * - `recipient` cannot be the zero address.
   * - `sender` must have a balance of at least `amount`.
   */
  function _transfer(address sender, address recipient, uint256 amount) internal virtual {
    require(sender != address(0), "EToken: transfer from the zero address");
    require(recipient != address(0), "EToken: transfer to the zero address");

    _beforeTokenTransfer(sender, recipient, amount);
    uint256 scaled_amount = _scale_amount(amount);

    uint256 senderBalance = _balances[sender];
    require(senderBalance >= scaled_amount, "EToken: transfer amount exceeds balance");
    _balances[sender] = senderBalance - scaled_amount;
    _balances[recipient] += scaled_amount;

    emit Transfer(sender, recipient, amount);
  }

  /** @dev Creates `amount` tokens and assigns them to `account`, increasing
   * the total supply.
   *
   * Emits a {Transfer} event with `from` set to the zero address.
   *
   * Requirements:
   *
   * - `to` cannot be the zero address.
   */
  function _mint(address account, uint256 amount) internal virtual {
    require(account != address(0), "EToken: mint to the zero address");

    _beforeTokenTransfer(address(0), account, amount);
    uint256 scaled_amount = _scale_amount(amount);

    _totalSupply += scaled_amount;
    _balances[account] += scaled_amount;
    emit Transfer(address(0), account, amount);
  }

  /**
   * @dev Destroys `amount` tokens from `account`, reducing the
   * total supply.
   *
   * Emits a {Transfer} event with `to` set to the zero address.
   *
   * Requirements:
   *
   * - `account` cannot be the zero address.
   * - `account` must have at least `amount` tokens.
   */
  function _burn(address account, uint256 amount) internal virtual {
    require(account != address(0), "EToken: burn from the zero address");
    _beforeTokenTransfer(account, address(0), amount);

    uint256 scaled_amount = _scale_amount(amount);
    uint256 accountBalance = _balances[account];
    require(accountBalance >= scaled_amount, "EToken: burn amount exceeds balance");
    _balances[account] = accountBalance - scaled_amount;
    _totalSupply -= scaled_amount;

    emit Transfer(account, address(0), amount);
  }

  /**
   * @dev Sets `amount` as the allowance of `spender` over the `owner` s tokens.
   *
   * This internal function is equivalent to `approve`, and can be used to
   * e.g. set automatic allowances for certain subsystems, etc.
   *
   * Emits an {Approval} event.
   *
   * Requirements:
   *
   * - `owner` cannot be the zero address.
   * - `spender` cannot be the zero address.
   */
  function _approve(address owner, address spender, uint256 amount) internal virtual {
    require(owner != address(0), "EToken: approve from the zero address");
    require(spender != address(0), "EToken: approve to the zero address");

    _allowances[owner][spender] = amount;
    emit Approval(owner, spender, amount);
  }

  /**
   * @dev Hook that is called before any transfer of tokens. This includes
   * minting and burning.
   *
   * Calling conditions:
   *
   * - when `from` and `to` are both non-zero, `amount` of ``from``'s tokens
   * will be to transferred to `to`.
   * - when `from` is zero, `amount` tokens will be minted for `to`.
   * - when `to` is zero, `amount` of ``from``'s tokens will be burned.
   * - `from` and `to` are never both zero.
   *
   * To learn more about hooks, head to xref:ROOT:extending-contracts.adoc#using-hooks[Using Hooks].
   */
  function _beforeTokenTransfer(address from, address to, uint256 amount) internal virtual { }

  /*** END ERC20 methods - mainly copied from OpenZeppelin but changes in events and scaled_amount */


  function _updateCurrentScale() internal {
    if (uint40(block.timestamp) == _lastScaleUpdate)
      return;
    _scaleFactor = _calculateCurrentScale();
    _lastScaleUpdate = uint40(block.timestamp);
  }

  function _updateTokenInterestRate() internal {
    uint256 totalSupply_ = this.totalSupply().wadToRay();
    if (totalSupply_ == 0)
      _tokenInterestRate = 0;
    else
      _tokenInterestRate = _scrInterestRate.rayMul(_scr.wadToRay()).rayDiv(totalSupply_);
  }

  function _calculateCurrentScale() internal view returns (uint256) {
    if (uint40(block.timestamp) <= _lastScaleUpdate)
      return _scaleFactor;
    uint256 timeDifference = block.timestamp - _lastScaleUpdate;
    return _scaleFactor.rayMul((
      _tokenInterestRate * timeDifference / SECONDS_PER_YEAR
    ) + WadRayMath.ray());
  }

  function policyPool() public view override returns (IPolicyPool) {
    return _policyPool;
  }

  function getCurrentScale(bool updated) public view returns (uint256) {
    if (updated)
      return _calculateCurrentScale();
    else
      return _scaleFactor;
  }

  function ocean() public view virtual override returns (uint256) {
    uint256 totalSupply_ = this.totalSupply();
    if (totalSupply_ > _scr)
      return totalSupply_ - _scr;
    else
      return 0;
  }

  function oceanForNewScr() public view virtual override returns (uint256) {
    uint256 totalSupply_ = this.totalSupply();
    if (totalSupply_ > _scr)
      return (totalSupply_ - _scr).wadMul(_maxUtilizationRate.rayToWad());
    else
      return 0;
  }

  function scr() public view virtual override returns (uint256) {
    return _scr;
  }

  function scrInterestRate() public view returns (uint256) {
    return _scrInterestRate;
  }

  function tokenInterestRate() public view returns (uint256) {
    return _tokenInterestRate;
  }

  function liquidityRequirement() public view returns (uint256) {
    return _liquidityRequirement;
  }

  function maxUtilizationRate() public view returns (uint256) {
    return _maxUtilizationRate;
  }

  function lockScr(uint256 policy_interest_rate, uint256 scr_amount) onlyPolicyPool external override {
    require(scr_amount <= this.ocean(), "Not enought OCEAN to cover the SCR");
    _updateCurrentScale();
    if (_scr == 0) {
      _scr = scr_amount;
      _scrInterestRate = policy_interest_rate;
    } else {
      uint256 orig_scr = _scr.wadToRay();
      _scr += scr_amount;
      _scrInterestRate = (
        _scrInterestRate.rayMul(orig_scr) + policy_interest_rate.rayMul(scr_amount.wadToRay())
      ).rayDiv(_scr.wadToRay());
    }
    emit SCRLocked(policy_interest_rate, scr_amount);
    _updateTokenInterestRate();
  }

  function unlockScr(uint256 policy_interest_rate, uint256 scr_amount) onlyPolicyPool external override {
    require(scr_amount <= _scr);  // Can be removed? Will fail later anyway
    _updateCurrentScale();

    if (_scr == scr_amount) {
      _scr = 0;
      _scrInterestRate = 0;
    } else {
      uint256 orig_scr = _scr.wadToRay();
      _scr -= scr_amount;
      _scrInterestRate = (
        _scrInterestRate.rayMul(orig_scr) - policy_interest_rate.rayMul(scr_amount.wadToRay())
      ).rayDiv(_scr.wadToRay());
    }
    emit SCRUnlocked(policy_interest_rate, scr_amount);
    _updateTokenInterestRate();
  }

  function _discreteChange(uint256 amount, bool positive) internal {
    uint256 new_total_supply = positive ? (totalSupply() + amount) : (totalSupply() - amount);
    _scaleFactor = new_total_supply.wadToRay().rayDiv(_totalSupply.wadToRay());
    _updateTokenInterestRate();
  }

  function discreteEarning(uint256 amount, bool positive) onlyPolicyPool external override {
    _updateCurrentScale();
    _discreteChange(amount, positive);
  }

  function assetEarnings(uint256 amount, bool positive) onlyAssetManager external override {
    _updateCurrentScale();
    _discreteChange(amount, positive);
  }

  function deposit(address provider, uint256 amount) onlyPolicyPool external override returns (uint256) {
    _updateCurrentScale();
    _mint(provider, amount);
    _updateTokenInterestRate();
    return balanceOf(provider);
  }

  function totalWithdrawable() public view virtual override returns (uint256) {
      uint256 locked = _scr.wadToRay().rayMul(
        WadRayMath.ray() + _scrInterestRate
      ).rayMul(_liquidityRequirement).rayToWad();
      uint256 totalSupply_ = totalSupply();
      if (totalSupply_ >= locked)
        return totalSupply_ - locked;
      else
        return 0;
  }

  function withdraw(address provider, uint256 amount)
          onlyPolicyPool whenNotPaused external override returns (uint256) {
    _updateCurrentScale();
    uint256 balance = balanceOf(provider);
    if (balance == 0)
      return 0;
    if (amount > balance)
      amount = balance;
    uint256 withdrawable = totalWithdrawable();
    if (amount > withdrawable)
      amount = withdrawable;
    if (amount == 0)
      return 0;
    _burn(provider, amount);
    _updateTokenInterestRate();
    return amount;
  }

  function accepts(uint40 policy_expiration) public view virtual override returns (bool) {
    if (paused())
      return false;
    return policy_expiration < (uint40(block.timestamp) + _expirationPeriod);
  }

  function _updatePoolLoanScale() internal {
    if (uint40(block.timestamp) == _poolLoanLastUpdate)
      return;
    _poolLoanScale = _getPoolLoanScale();
    _poolLoanLastUpdate = uint40(block.timestamp);
  }

  function lendToPool(uint256 amount) onlyPolicyPool external override {
    require(amount <= ocean(), "Not enought capital to lend");
    if (_poolLoan == 0) {
      _poolLoan = amount;
      _poolLoanScale = WadRayMath.ray();
      _poolLoanLastUpdate = uint40(block.timestamp);
    } else {
      _updatePoolLoanScale();
      _poolLoan += amount.wadToRay().rayDiv(_poolLoanScale).rayToWad();
    }
    _updateCurrentScale(); // shouldn't do anything because lendToPool is after unlock_scr but doing
                           // anyway
    _discreteChange(amount, false);
  }

  function repayPoolLoan(uint256 amount) onlyPolicyPool external override {
    _updatePoolLoanScale();
    _poolLoan = (getPoolLoan() - amount).wadToRay().rayDiv(_poolLoanScale).rayToWad();
    _updateCurrentScale(); // shouldn't do anything because lendToPool is after unlock_scr but doing
                           // anyway
    _discreteChange(amount, true);
  }

  function _getPoolLoanScale() internal view returns (uint256) {
    if (uint40(block.timestamp) <= _poolLoanLastUpdate)
      return _poolLoanScale;
    uint256 timeDifference = block.timestamp - _poolLoanLastUpdate;
    return _poolLoanScale.rayMul((
      _poolLoanInterestRate * timeDifference / SECONDS_PER_YEAR
    ) + WadRayMath.ray());
  }

  function getPoolLoan() public view virtual override returns (uint256) {
    if (_poolLoan == 0)
      return 0;
    return _poolLoan.wadToRay().rayMul(_getPoolLoanScale()).rayToWad();
  }

  function poolLoanInterestRate() public view returns (uint256) {
    return _poolLoanInterestRate;
  }

  function setPoolLoanInterestRate(uint256 new_rate) external onlyRole(SET_LOAN_RATE_ROLE) {
    _updatePoolLoanScale();
    _poolLoanInterestRate = new_rate;
  }

  function setLiquidityRequirement(uint256 new_rate) external onlyRole(SET_LIQ_PARAMS_ROLE) {
    _liquidityRequirement = new_rate;
  }

  function setMaxUtilizationRate(uint256 new_rate) external onlyRole(SET_LIQ_PARAMS_ROLE) {
    _maxUtilizationRate = new_rate;
  }

  function getInvestable() public view virtual override returns (uint256) {
    return _scr + ocean() + getPoolLoan();
  }
}
