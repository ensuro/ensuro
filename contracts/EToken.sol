// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPolicyPool} from "../interfaces/IPolicyPool.sol";
import {PolicyPoolComponent} from "./PolicyPoolComponent.sol";
import {IEToken} from "../interfaces/IEToken.sol";
import {IPolicyPoolConfig} from "../interfaces/IPolicyPoolConfig.sol";
import {IInsolvencyHook} from "../interfaces/IInsolvencyHook.sol";
import {WadRayMath} from "./WadRayMath.sol";

/**
 * @title Ensuro ERC20 EToken
 * @dev Implementation of the interest/earnings bearing token for the Ensuro protocol
 * @author Ensuro
 */
contract EToken is PolicyPoolComponent, IERC20Metadata, IEToken {
  uint256 public constant MIN_SCALE = 1e17; // 0.0000000001 == 1e-10 in ray

  using WadRayMath for uint256;
  using SafeERC20 for IERC20Metadata;

  uint256 internal constant SECONDS_PER_YEAR = 365 days;

  // Attributes taken from ERC20
  mapping(address => uint256) private _balances;
  mapping(address => mapping(address => uint256)) private _allowances;
  uint256 private _totalSupply;

  string private _name;
  string private _symbol;

  uint40 internal _expirationPeriod;
  uint256 internal _scaleFactor; // in Ray
  uint40 internal _lastScaleUpdate;

  uint256 internal _scr; // in Wad
  uint256 internal _scrInterestRate; // in Ray
  uint256 internal _tokenInterestRate; // in Ray
  uint256 internal _liquidityRequirement; // in Ray - Liquidity requirement to lock more than SCR
  uint256 internal _maxUtilizationRate; // in Ray - Maximum SCR/totalSupply rate for backup up new policies

  uint256 internal _poolLoan; // in Wad
  uint256 internal _poolLoanInterestRate; // in Ray
  uint256 internal _poolLoanScale; // in Ray
  uint40 internal _poolLoanLastUpdate;

  bool internal _acceptAllRMs; // By defaults, accepts (backs up) any RiskModule;
  // Exceptions to the accept all or accept none policy defined before
  mapping(address => bool) internal _acceptExceptions;

  event PoolLoan(uint256 value);
  event PoolLoanRepaid(uint256 value);

  modifier onlyAssetManager {
    require(
      _msgSender() == address(_policyPool.config().assetManager()),
      "The caller must be the PolicyPool's AssetManager"
    );
    _;
  }

  modifier validateParamsAfterChange() {
    _;
    _validateParameters();
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
  function initialize(
    string memory name_,
    string memory symbol_,
    IPolicyPool policyPool_,
    uint40 expirationPeriod,
    uint256 liquidityRequirement_,
    uint256 maxUtilizationRate_,
    uint256 poolLoanInterestRate_
  ) public initializer {
    __PolicyPoolComponent_init(policyPool_);
    __EToken_init_unchained(
      name_,
      symbol_,
      expirationPeriod,
      liquidityRequirement_,
      maxUtilizationRate_,
      poolLoanInterestRate_
    );
  }

  // solhint-disable-next-line func-name-mixedcase
  function __EToken_init_unchained(
    string memory name_,
    string memory symbol_,
    uint40 expirationPeriod,
    uint256 liquidityRequirement_,
    uint256 maxUtilizationRate_,
    uint256 poolLoanInterestRate_
  ) public initializer {
    _name = name_;
    _symbol = symbol_;
    _expirationPeriod = expirationPeriod;
    _scaleFactor = WadRayMath.ray();
    _lastScaleUpdate = uint40(block.timestamp);
    _scr = 0;
    _scrInterestRate = 0;
    _tokenInterestRate = 0;
    _liquidityRequirement = liquidityRequirement_;
    _maxUtilizationRate = maxUtilizationRate_;
    _acceptAllRMs = true;

    _poolLoan = 0;
    _poolLoanInterestRate = poolLoanInterestRate_;
    _poolLoanScale = WadRayMath.ray();
    _poolLoanLastUpdate = uint40(block.timestamp);
    _validateParameters();
  }

  // runs validation on EToken parameters
  function _validateParameters() internal view {
    require(
      _liquidityRequirement >= 8e26 && _liquidityRequirement <= 13e26,
      "Validation: liquidityRequirement must be [0.8, 1.3]"
    );
    require(
      _maxUtilizationRate >= 5e26 && _maxUtilizationRate <= WadRayMath.RAY,
      "Validation: maxUtilizationRate must be [0.5, 1]"
    );
    require(_poolLoanInterestRate <= 5e26, "Validation: poolLoanInterestRate must be <= 50%");
  }

  /*** BEGIN ERC20 methods - mainly copied from OpenZeppelin but changes in events and scaledAmount */

  /**
   * @dev Returns the name of the token.
   */
  function name() public view virtual override returns (string memory) {
    return _name;
  }

  /**
   * @dev Returns the symbol of the token, usually a shorter version of the
   * name.
   */
  function symbol() public view virtual override returns (string memory) {
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
  function decimals() public view virtual override returns (uint8) {
    return _policyPool.currency().decimals();
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
    uint256 principalBalance = _balances[account];
    if (principalBalance == 0) return 0;
    return principalBalance.wadToRay().rayMul(_calculateCurrentScale()).rayToWad();
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
  function allowance(address owner, address spender)
    public
    view
    virtual
    override
    returns (uint256)
  {
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
  function transferFrom(
    address sender,
    address recipient,
    uint256 amount
  ) public virtual override returns (bool) {
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
  function decreaseAllowance(address spender, uint256 subtractedValue)
    public
    virtual
    returns (bool)
  {
    uint256 currentAllowance = _allowances[_msgSender()][spender];
    require(currentAllowance >= subtractedValue, "EToken: decreased allowance below zero");
    _approve(_msgSender(), spender, currentAllowance - subtractedValue);

    return true;
  }

  function _scaleAmount(uint256 amount) internal view returns (uint256) {
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
  function _transfer(
    address sender,
    address recipient,
    uint256 amount
  ) internal virtual {
    require(sender != address(0), "EToken: transfer from the zero address");
    require(recipient != address(0), "EToken: transfer to the zero address");

    _beforeTokenTransfer(sender, recipient, amount);
    uint256 scaledAmount = _scaleAmount(amount);

    uint256 senderBalance = _balances[sender];
    require(senderBalance >= scaledAmount, "EToken: transfer amount exceeds balance");
    _balances[sender] = senderBalance - scaledAmount;
    _balances[recipient] += scaledAmount;

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
    uint256 scaledAmount = _scaleAmount(amount);

    _totalSupply += scaledAmount;
    _balances[account] += scaledAmount;
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

    uint256 scaledAmount = _scaleAmount(amount);
    uint256 accountBalance = _balances[account];
    require(accountBalance >= scaledAmount, "EToken: burn amount exceeds balance");
    _balances[account] = accountBalance - scaledAmount;
    _totalSupply -= scaledAmount;

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
  function _approve(
    address owner,
    address spender,
    uint256 amount
  ) internal virtual {
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
  function _beforeTokenTransfer(
    address from,
    address to,
    uint256 amount
  ) internal virtual {
    require(
      from == address(0) ||
        to == address(0) ||
        address(policyPool().config().lpWhitelist()) == address(0) ||
        policyPool().config().lpWhitelist().acceptsTransfer(this, from, to, amount),
      "Transfer not allowed - Liquidity Provider not whitelisted"
    );
  }

  /*** END ERC20 methods - mainly copied from OpenZeppelin but changes in events and scaledAmount */

  function _updateCurrentScale() internal {
    if (uint40(block.timestamp) == _lastScaleUpdate) return;
    _scaleFactor = _calculateCurrentScale();
    require(_scaleFactor >= MIN_SCALE, "Scale too small, can lead to rounding errors");
    _lastScaleUpdate = uint40(block.timestamp);
  }

  function _updateTokenInterestRate() internal {
    uint256 totalSupply_ = this.totalSupply().wadToRay();
    if (totalSupply_ == 0) _tokenInterestRate = 0;
    else _tokenInterestRate = _scrInterestRate.rayMul(_scr.wadToRay()).rayDiv(totalSupply_);
  }

  function _calculateCurrentScale() internal view returns (uint256) {
    if (uint40(block.timestamp) <= _lastScaleUpdate) return _scaleFactor;
    uint256 timeDifference = block.timestamp - _lastScaleUpdate;
    return
      _scaleFactor.rayMul(
        ((_tokenInterestRate * timeDifference) / SECONDS_PER_YEAR) + WadRayMath.ray()
      );
  }

  function getCurrentScale(bool updated) public view returns (uint256) {
    if (updated) return _calculateCurrentScale();
    else return _scaleFactor;
  }

  function ocean() public view virtual override returns (uint256) {
    uint256 totalSupply_ = this.totalSupply();
    if (totalSupply_ > _scr) return totalSupply_ - _scr;
    else return 0;
  }

  function oceanForNewScr() public view virtual override returns (uint256) {
    uint256 totalSupply_ = this.totalSupply();
    if (totalSupply_ > _scr) return (totalSupply_ - _scr).wadMul(_maxUtilizationRate.rayToWad());
    else return 0;
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

  function lockScr(uint256 policyInterestRate, uint256 scrAmount) external override onlyPolicyPool {
    require(scrAmount <= this.ocean(), "Not enought OCEAN to cover the SCR");
    _updateCurrentScale();
    if (_scr == 0) {
      _scr = scrAmount;
      _scrInterestRate = policyInterestRate;
    } else {
      uint256 origScr = _scr.wadToRay();
      _scr += scrAmount;
      _scrInterestRate = (_scrInterestRate.rayMul(origScr) +
        policyInterestRate.rayMul(scrAmount.wadToRay()))
      .rayDiv(_scr.wadToRay());
    }
    emit SCRLocked(policyInterestRate, scrAmount);
    _updateTokenInterestRate();
  }

  function unlockScr(uint256 policyInterestRate, uint256 scrAmount)
    external
    override
    onlyPolicyPool
  {
    require(scrAmount <= _scr, "Current SCR less than the amount you want to unlock");
    _updateCurrentScale();

    if (_scr == scrAmount) {
      _scr = 0;
      _scrInterestRate = 0;
    } else {
      uint256 origScr = _scr.wadToRay();
      _scr -= scrAmount;
      _scrInterestRate = (_scrInterestRate.rayMul(origScr) -
        policyInterestRate.rayMul(scrAmount.wadToRay()))
      .rayDiv(_scr.wadToRay());
    }
    emit SCRUnlocked(policyInterestRate, scrAmount);
    _updateTokenInterestRate();
  }

  function _discreteChange(uint256 amount, bool positive) internal {
    uint256 newTotalSupply = positive ? (totalSupply() + amount) : (totalSupply() - amount);
    _scaleFactor = newTotalSupply.wadToRay().rayDiv(_totalSupply.wadToRay());
    require(_scaleFactor >= MIN_SCALE, "Scale too small, can lead to rounding errors");
    _updateTokenInterestRate();
  }

  function discreteEarning(uint256 amount, bool positive) external override onlyPolicyPool {
    _updateCurrentScale();
    _discreteChange(amount, positive);
  }

  function assetEarnings(uint256 amount, bool positive) external override onlyAssetManager {
    _updateCurrentScale();
    _discreteChange(amount, positive);
  }

  function deposit(address provider, uint256 amount)
    external
    override
    onlyPolicyPool
    whenNotPaused
    returns (uint256)
  {
    require(
      address(policyPool().config().lpWhitelist()) == address(0) ||
        policyPool().config().lpWhitelist().acceptsDeposit(this, provider, amount),
      "Liquidity Provider not whitelisted"
    );
    _updateCurrentScale();
    _mint(provider, amount);
    _updateTokenInterestRate();
    return balanceOf(provider);
  }

  function totalWithdrawable() public view virtual override returns (uint256) {
    uint256 locked = _scr
    .wadToRay()
    .rayMul(WadRayMath.ray() + _scrInterestRate)
    .rayMul(_liquidityRequirement)
    .rayToWad();
    uint256 totalSupply_ = totalSupply();
    if (totalSupply_ >= locked) return totalSupply_ - locked;
    else return 0;
  }

  function withdraw(address provider, uint256 amount)
    external
    override
    onlyPolicyPool
    whenNotPaused
    returns (uint256)
  {
    _updateCurrentScale();
    uint256 balance = balanceOf(provider);
    if (balance == 0) return 0;
    if (amount > balance) amount = balance;
    uint256 withdrawable = totalWithdrawable();
    if (amount > withdrawable) amount = withdrawable;
    if (amount == 0) return 0;
    _burn(provider, amount);
    _updateTokenInterestRate();
    return amount;
  }

  function accepts(address riskModule, uint40 policyExpiration)
    public
    view
    virtual
    override
    returns (bool)
  {
    if (paused()) return false;
    if (
      (_acceptAllRMs && _acceptExceptions[riskModule]) || // all accepted except this one
      (!_acceptAllRMs && !_acceptExceptions[riskModule]) // all rejected this one is not an exception
    ) return false;
    return policyExpiration < (uint40(block.timestamp) + _expirationPeriod);
  }

  function _updatePoolLoanScale() internal {
    if (uint40(block.timestamp) == _poolLoanLastUpdate) return;
    _poolLoanScale = _getPoolLoanScale();
    _poolLoanLastUpdate = uint40(block.timestamp);
  }

  function _maxNegativeAdjustment() internal view returns (uint256) {
    uint256 ts = totalSupply();
    uint256 minTs = _totalSupply.wadToRay().rayMul(MIN_SCALE * 10).rayToWad();
    if (ts > minTs) return ts - minTs;
    else return 0;
  }

  function lendToPool(uint256 amount, bool fromOcean)
    external
    override
    onlyPolicyPool
    returns (uint256)
  {
    if (fromOcean && amount > ocean()) amount = ocean();
    if (!fromOcean && amount > totalSupply()) amount = totalSupply();
    if (amount > _maxNegativeAdjustment()) {
      amount = _maxNegativeAdjustment();
      if (amount == 0) return amount;
    }
    if (_poolLoan == 0) {
      _poolLoan = amount;
      _poolLoanScale = WadRayMath.ray();
      _poolLoanLastUpdate = uint40(block.timestamp);
    } else {
      _updatePoolLoanScale();
      _poolLoan += amount.wadToRay().rayDiv(_poolLoanScale).rayToWad();
    }
    _updateCurrentScale(); // shouldn't do anything because lendToPool is after unlock_scr but doing anyway
    _discreteChange(amount, false);
    emit PoolLoan(amount);
    if (!fromOcean && _scr > totalSupply()) {
      // Notify insolvency_hook - Insuficient solvency
      IInsolvencyHook hook = _policyPool.config().insolvencyHook();
      if (address(hook) != address(0)) {
        hook.insolventEToken(this, _scr - totalSupply());
      }
    }
    return amount;
  }

  function repayPoolLoan(uint256 amount) external override onlyPolicyPool {
    _updatePoolLoanScale();
    _poolLoan = (getPoolLoan() - amount).wadToRay().rayDiv(_poolLoanScale).rayToWad();
    _updateCurrentScale(); // shouldn't do anything because lendToPool is after unlock_scr but doing anyway
    _discreteChange(amount, true);
    emit PoolLoanRepaid(amount);
  }

  function _getPoolLoanScale() internal view returns (uint256) {
    if (uint40(block.timestamp) <= _poolLoanLastUpdate) return _poolLoanScale;
    uint256 timeDifference = block.timestamp - _poolLoanLastUpdate;
    return
      _poolLoanScale.rayMul(
        ((_poolLoanInterestRate * timeDifference) / SECONDS_PER_YEAR) + WadRayMath.ray()
      );
  }

  function getPoolLoan() public view virtual override returns (uint256) {
    if (_poolLoan == 0) return 0;
    return _poolLoan.wadToRay().rayMul(_getPoolLoanScale()).rayToWad();
  }

  function poolLoanInterestRate() public view returns (uint256) {
    return _poolLoanInterestRate;
  }

  function acceptAllRMs() public view returns (bool) {
    return _acceptAllRMs;
  }

  function isAcceptException(address riskModule) public view returns (bool) {
    return _acceptExceptions[riskModule];
  }

  function setPoolLoanInterestRate(uint256 newRate)
    external
    onlyPoolRole2(LEVEL2_ROLE, LEVEL3_ROLE)
    validateParamsAfterChange
  {
    bool tweak = !hasPoolRole(LEVEL2_ROLE);
    require(
      !tweak || _isTweakRay(_poolLoanInterestRate, newRate, 3e26),
      "Tweak exceeded: poolLoanInterestRate tweaks only up to 30%"
    );
    _updatePoolLoanScale();
    _poolLoanInterestRate = newRate;
    _parameterChanged(IPolicyPoolConfig.GovernanceActions.setPoolLoanInterestRate, newRate, tweak);
  }

  function setLiquidityRequirement(uint256 newRate)
    external
    onlyPoolRole2(LEVEL2_ROLE, LEVEL3_ROLE)
    validateParamsAfterChange
  {
    bool tweak = !hasPoolRole(LEVEL2_ROLE);
    require(
      !tweak || _isTweakRay(_liquidityRequirement, newRate, 1e26),
      "Tweak exceeded: liquidityRequirement tweaks only up to 10%"
    );
    _liquidityRequirement = newRate;
    _parameterChanged(IPolicyPoolConfig.GovernanceActions.setLiquidityRequirement, newRate, tweak);
  }

  function setMaxUtilizationRate(uint256 newRate)
    external
    onlyPoolRole2(LEVEL2_ROLE, LEVEL3_ROLE)
    validateParamsAfterChange
  {
    bool tweak = !hasPoolRole(LEVEL2_ROLE);
    require(
      !tweak || _isTweakRay(_maxUtilizationRate, newRate, 3e26),
      "Tweak exceeded: maxUtilizationRate tweaks only up to 30%"
    );
    _maxUtilizationRate = newRate;
    _parameterChanged(IPolicyPoolConfig.GovernanceActions.setMaxUtilizationRate, newRate, tweak);
  }

  function setAcceptAllRMs(bool acceptAllRMs_)
    external
    onlyPoolRole(LEVEL2_ROLE)
    validateParamsAfterChange
  {
    _acceptAllRMs = acceptAllRMs_;
    _parameterChanged(
      IPolicyPoolConfig.GovernanceActions.setAcceptAllRMs,
      acceptAllRMs_ ? 1 : 0,
      false
    );
  }

  function setAcceptException(address riskModule, bool isException)
    external
    onlyPoolRole(LEVEL2_ROLE)
    validateParamsAfterChange
  {
    _acceptExceptions[riskModule] = isException;
    uint256 value = uint160(riskModule);
    if (!isException) value |= (1 << 255);
    _parameterChanged(IPolicyPoolConfig.GovernanceActions.setAcceptException, value, false);
  }

  function getInvestable() public view virtual override returns (uint256) {
    return _scr + ocean() + getPoolLoan();
  }
}
