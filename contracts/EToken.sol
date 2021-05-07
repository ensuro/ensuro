// SPDX-License-Identifier: agpl-3.0
pragma solidity ^0.8.0;

import {Context} from "@openzeppelin/contracts/utils/Context.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import {IEToken} from '../interfaces/IEToken.sol';
import {Errors} from './Errors.sol';
import {WadRayMath} from './WadRayMath.sol';
import {SafeMath} from '@openzeppelin/contracts/utils/math/SafeMath.sol';

/**
 * @title Ensuro ERC20 EToken
 * @dev Implementation of the interest/earnings bearing token for the Ensuro protocol
 * @author Ensuro
 */
contract EToken is Context, IERC20, IEToken {
  using SafeMath for uint256;
  using WadRayMath for uint256;
  using SafeERC20 for IERC20;

  uint256 internal constant SECONDS_PER_YEAR = 365 days;

  // Attributes taken from ERC20
  mapping (address => uint256) private _balances;
  mapping (address => mapping (address => uint256)) private _allowances;
  uint256 private _totalSupply;

  string private _name;
  string private _symbol;

  address internal _ensuro;  // TODO: later define IEnsuroProtocol

  uint40 internal _expirationPeriod;
  uint256 internal _currentIndex;  // in Ray
  uint40 internal _lastIndexUpdate;

  uint256 internal _mcr;  // in Wad
  uint256 internal _mcrInterestRate;  // in Ray
  uint256 internal _tokenInterestRate;  // in Ray
  uint256 internal _liquidityRequirement;  // in Ray

  uint256 internal _minQueuedWithdraw;  // in Wad
  // TODO: withdrawQueue
  // TODO: withdrawers
  uint256 internal _toWithdrawAmount;  // in Wad

  uint256 internal _protocolLoan;  // in Wad
  uint256 internal _protocolLoanInterestRate;  // in Ray
  uint256 internal _protocolLoanIndex;  // in Ray
  uint40 internal _protocolLoanLastIndexUpdate;

  modifier onlyEnsuro {
    require(_msgSender() == address(_ensuro), Errors.CT_CALLER_MUST_BE_ENSURO);
    _;
  }

  modifier onlyAssetManager {
    // TODO
    // require(_msgSender() == _ensuro.getAssetManager(), Errors.CT_CALLER_MUST_BE_ENSURO);
    require(_msgSender() == address(_ensuro), Errors.CT_CALLER_MUST_BE_ENSURO);
    _;
  }

  /**
   * @dev Initializes the aToken
   * @param ensuro The address of the Ensuro Protocol where this eToken will be used
   * @param expirationPeriod Maximum expirationPeriod (from block.timestamp) of policies to be accepted
   * @param liquidityRequirement Liquidity requirement to allow withdrawal (in Ray - default=1 Ray)
   * @param minQueuedWithdraw Minimum amount to do queued withdraws
   * @param protocolLoanInterestRate Rate of loans given to the protocol (in Ray)
   * @param name_ Name of the eToken
   * @param symbol_ Symbol of the eToken
   */
  constructor(
    string memory name_,
    string memory symbol_,
    address ensuro,  // TODO: IEnsuroProtocol
    uint40 expirationPeriod,
    uint256 liquidityRequirement,
    uint256 minQueuedWithdraw,
    uint256 protocolLoanInterestRate
  ) {
    _name = name_;
    _symbol = symbol_;
    _ensuro = ensuro;
    _expirationPeriod = expirationPeriod;
    _currentIndex = WadRayMath.ray();
    _lastIndexUpdate = uint40(block.timestamp);
    _mcr = 0;
    _mcrInterestRate = 0;
    _tokenInterestRate = 0;
    _liquidityRequirement = liquidityRequirement;

    _minQueuedWithdraw = minQueuedWithdraw;
    // TODO: _withdrawers
    _toWithdrawAmount = 0;

    _protocolLoan = 0;
    _protocolLoanInterestRate = protocolLoanInterestRate;
    _protocolLoanIndex = WadRayMath.ray();
    _protocolLoanLastIndexUpdate = uint40(block.timestamp);

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
   * @dev See {IERC20-totalSupply}.
   */
  function totalSupply() public view virtual override returns (uint256) {
    return _totalSupply.wadToRay().rayMul(_calculateCurrentIndex()).rayToWad();
  }


  /**
   * @dev See {IERC20-balanceOf}.
   */
  function balanceOf(address account) public view virtual override returns (uint256) {
    uint256 principal_balance = _balances[account];
    if (principal_balance == 0)
      return 0;
    return principal_balance.wadToRay().rayMul(_calculateCurrentIndex()).rayToWad();
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
    require(currentAllowance >= amount, "ERC20: transfer amount exceeds allowance");
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
    require(currentAllowance >= subtractedValue, "ERC20: decreased allowance below zero");
    _approve(_msgSender(), spender, currentAllowance - subtractedValue);

    return true;
  }

  function _scale_amount(uint256 amount) internal view returns (uint256) {
    return amount.wadToRay().rayDiv(_calculateCurrentIndex()).rayToWad();
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
    require(sender != address(0), "ERC20: transfer from the zero address");
    require(recipient != address(0), "ERC20: transfer to the zero address");

    _beforeTokenTransfer(sender, recipient, amount);
    uint256 scaled_amount = _scale_amount(amount);

    uint256 senderBalance = _balances[sender];
    require(senderBalance >= scaled_amount, "ERC20: transfer amount exceeds balance");
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
    require(account != address(0), "ERC20: mint to the zero address");

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
    require(account != address(0), "ERC20: burn from the zero address");
    _beforeTokenTransfer(account, address(0), amount);

    uint256 scaled_amount = _scale_amount(amount);
    uint256 accountBalance = _balances[account];
    require(accountBalance >= scaled_amount, "ERC20: burn amount exceeds balance");
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
    require(owner != address(0), "ERC20: approve from the zero address");
    require(spender != address(0), "ERC20: approve to the zero address");

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


  function _updateCurrentIndex() internal {
    _currentIndex = _calculateCurrentIndex();
    _lastIndexUpdate = uint40(block.timestamp);
  }

  function _updateTokenInterestRate() internal {
    uint256 totalSupply_ = this.totalSupply().wadToRay();
    if (totalSupply_ == 0)
      _tokenInterestRate = 0;
    else
      _tokenInterestRate = _mcrInterestRate.rayMul(_mcr.wadToRay()).rayDiv(totalSupply_);
  }

  function _calculateCurrentIndex() internal view returns (uint256) {
    if (uint40(block.timestamp) <= _lastIndexUpdate)
      return _currentIndex;
    uint256 timeDifference = block.timestamp - _lastIndexUpdate;
    return _currentIndex.rayMul((
      _tokenInterestRate.mul(timeDifference) / SECONDS_PER_YEAR
    ).add(WadRayMath.ray()));
  }

  function currentIndex(bool updated) public view returns (uint256) {
    if (updated)
      return _calculateCurrentIndex();
    else
      return _currentIndex;
  }

  function ocean() public view returns (uint256) {
    uint256 totalSupply_ = this.totalSupply();
    uint256 locked = _mcr + _toWithdrawAmount;
    if (totalSupply_ > locked)
      return totalSupply_.sub(locked);
    else
      return 0;
  }

  function mcr() public view returns (uint256) {
    return _mcr;
  }

  function mcrInterestRate() public view returns (uint256) {
    return _mcrInterestRate;
  }

  function tokenInterestRate() public view returns (uint256) {
    return _tokenInterestRate;
  }

  function lockMcr(uint256 policy_interest_rate, uint256 mcr_amount) onlyEnsuro external {
    require(mcr_amount <= this.ocean(), "Not enought OCEAN to cover the MCR");
    if (_mcr == 0) {
      _mcr = mcr_amount;
      _mcrInterestRate = policy_interest_rate;
    } else {
      uint256 orig_mcr = _mcr.wadToRay();
      _mcr = _mcr.add(mcr_amount);
      _mcrInterestRate = _mcrInterestRate.rayMul(orig_mcr).add(
        policy_interest_rate.rayMul(mcr_amount.wadToRay())
      ).rayDiv(_mcr.wadToRay());
    }
    _updateTokenInterestRate();
  }

  function unlockMcr(uint256 policy_interest_rate, uint256 mcr_amount) onlyEnsuro external {
    require(mcr_amount <= _mcr);  // Can be removed? Will fail later anyway
    _updateCurrentIndex();

    if (_mcr == mcr_amount) {
      _mcr = 0;
      _mcrInterestRate = 0;
    } else {
      uint256 orig_mcr = _mcr.wadToRay();
      _mcr = _mcr.sub(mcr_amount);
      _mcrInterestRate = _mcrInterestRate.rayMul(orig_mcr).sub(
        policy_interest_rate.rayMul(mcr_amount.wadToRay())
      ).rayDiv(_mcr.wadToRay());
    }
    _updateTokenInterestRate();
  }

  function _discreteChange(uint256 amount, bool positive) internal {
    uint256 new_total_supply = positive ? totalSupply().add(amount) : totalSupply().sub(amount);
    _currentIndex = new_total_supply.wadToRay().rayDiv(_totalSupply.wadToRay());
    _updateTokenInterestRate();
  }

  function discreteEarning(uint256 amount, bool positive) onlyEnsuro external {
    assert(_lastIndexUpdate == uint40(block.timestamp));
    _discreteChange(amount, positive);
  }

  function assetEarnings(uint256 amount, bool positive) onlyAssetManager external {
    _updateCurrentIndex();
    _discreteChange(amount, positive);
  }

  function deposit(address provider, uint256 amount) onlyEnsuro external returns (uint256) {
    _updateCurrentIndex();
    _mint(provider, amount);
    _updateTokenInterestRate();
    return balanceOf(provider);
  }

  function totalWithdrawable() public view returns (uint256) {
      uint256 locked = _mcr.wadToRay().rayMul(
        WadRayMath.ray().add(_mcrInterestRate)
      ).rayMul(_liquidityRequirement).rayToWad();
      uint256 totalSupply_ = totalSupply();
      if (totalSupply_ >= locked)
        return totalSupply_.sub(locked);
      else
        return 0;
  }

  function withdraw(address provider, uint256 amount) onlyEnsuro external returns (uint256) {
    _updateCurrentIndex();
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
        /*# If provider in withdraws and remaining balance < to_withdraw, remove from queue
        if provider in self.withdrawers and (balance - amount) < self.withdrawers[provider]:
            self.to_withdraw_amount -= self.withdrawers[provider]
            del self.withdrawers[provider]*/
    return amount;
  }


  /*  @external
    def queue_withdraw(self, provider, amount):
        balance = self.balance_of(provider)
        if amount is None or amount > balance:
            amount = balance

        if provider in self.withdrawers:
            # clean first
            self.to_withdraw_amount -= self.withdrawers[provider]
            del self.withdrawers[provider]

        if amount < self.min_queued_withdraw:
            return _W(0)

        self.withdrawers[provider] = amount
        self.withdraw_queue.append(provider)
        self.to_withdraw_amount += amount
        return amount

    def process_withdrawers(self):
        self._update_current_index()
        withdrawable = self.total_withdrawable()
        transfer_amounts = []
        total_transfer = Wad(0)

        while self.to_withdraw_amount and withdrawable >= self.min_queued_withdraw:
            provider = self.withdraw_queue.pop(0)
            provider_amount = self.withdrawers.get(provider, Wad(0))
            if not provider_amount:
                continue
            if provider_amount < self.min_queued_withdraw:
                # skip provider - amount < min_queued_withdraw must do manual withdraw
                del self.withdrawers[provider]
                self.to_withdraw_amount -= provider_amount
                continue
            provider_amount = min(provider_amount, self.balance_of(provider))
            if provider_amount <= withdrawable:
                full_withdraw = True
            elif (provider_amount - withdrawable) < self.min_queued_withdraw:
                full_withdraw = True
                provider_amount = withdrawable
            else:
                full_withdraw = False
            if full_withdraw:
                self._withdraw(provider, provider_amount)
                transfer_amounts.append((provider, provider_amount))
                total_transfer += provider_amount
                withdrawable -= provider_amount
                del self.withdrawers[provider]
                self.to_withdraw_amount -= provider_amount
            else:  # partial withdraw
                self._withdraw(provider, withdrawable)
                transfer_amounts.append((provider, withdrawable))
                total_transfer += withdrawable
                self.withdrawers[provider] = provider_amount - withdrawable
                self.withdraw_queue.append(provider)  # requeue at the end
                withdrawable = Wad(0)
                self.to_withdraw_amount -= withdrawable

        return total_transfer, transfer_amounts
    */

  function accepts(uint40 policy_expiration) public view returns (bool) {
    return policy_expiration <= (uint40(block.timestamp) + _expirationPeriod);
  }


  function lendToProtocol(uint256 amount) onlyEnsuro external {
    if (_protocolLoan == 0) {
      _protocolLoan = amount;
      _protocolLoanIndex = WadRayMath.ray();
      _protocolLoanLastIndexUpdate = uint40(block.timestamp);
    } else {
      _protocolLoanIndex = _getProtocolLoanIndex();
      _protocolLoanLastIndexUpdate = uint40(block.timestamp);
      _protocolLoan = _protocolLoan.add(amount.wadToRay().rayDiv(_protocolLoanIndex).wadToRay());
    }
    _updateCurrentIndex(); // shouldn't do anything because lendToProtocol is after unlock_mcr but doing
                           // anyway
    _discreteChange(amount, false);
  }

  function repayProtocolLoan(uint256 amount) onlyEnsuro external {
    _protocolLoanIndex = _getProtocolLoanIndex();
    _protocolLoanLastIndexUpdate = uint40(block.timestamp);
    _protocolLoan = getProtocolLoan().sub(amount).wadToRay().rayDiv(_protocolLoanIndex).wadToRay();
    _updateCurrentIndex(); // shouldn't do anything because lendToProtocol is after unlock_mcr but doing
                           // anyway
    _discreteChange(amount, true);
  }

  function _getProtocolLoanIndex() internal view returns (uint256) {
    if (uint40(block.timestamp) <= _protocolLoanLastIndexUpdate)
      return _protocolLoanIndex;
    uint256 timeDifference = block.timestamp - _protocolLoanLastIndexUpdate;
    return _protocolLoanIndex.rayMul((
      _protocolLoanInterestRate.mul(timeDifference) / SECONDS_PER_YEAR
    ).add(WadRayMath.ray()));
  }

  function getProtocolLoan() public view returns (uint256) {
    if (_protocolLoan == 0)
      return 0;
    return _protocolLoan.wadToRay().rayMul(_getProtocolLoanIndex()).rayToWad();
  }

  function getInvestable() public view returns (uint256) {
    return _mcr.add(ocean()).add(getProtocolLoan());
  }
}
