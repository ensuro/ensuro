// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPolicyPool} from "../interfaces/IPolicyPool.sol";
import {Reserve} from "./Reserve.sol";
import {IEToken} from "../interfaces/IEToken.sol";
import {IPolicyPoolConfig} from "../interfaces/IPolicyPoolConfig.sol";
import {WadRayMath} from "./WadRayMath.sol";
import {TimeScaled} from "./TimeScaled.sol";

/**
 * @title Ensuro ERC20 EToken - interest-bearing token
 * @dev Implementation of the interest/earnings bearing token for the Ensuro protocol.
 *      `_tsScaled.scale` scales the balances stored in _balances. _tsScaled (totalSupply scaled) grows
 *      continuoulsly at tokenInterestRate().
 *      Every operation that changes the utilization rate (_scr.scr/totalSupply) or the _scr.interestRate, updates
 *      first the _tsScaled.scale accumulating the interest accrued since _tsScaled.lastUpdate.
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
contract EToken is Reserve, IERC20Metadata, IEToken {
  using WadRayMath for uint256;
  using TimeScaled for TimeScaled.ScaledAmount;
  using SafeERC20 for IERC20Metadata;

  uint256 internal constant SECONDS_PER_YEAR = 365 days;

  // Attributes taken from ERC20
  mapping(address => uint256) private _balances;
  mapping(address => mapping(address => uint256)) private _allowances;

  string private _name;
  string private _symbol;

  TimeScaled.ScaledAmount internal _tsScaled; // Total Supply scaled

  struct Scr {
    uint128 scr; // in Wad - Capital locked as Solvency Capital Requirement of backed up policies
    uint64 interestRate; // in Wad - Interest rate received in exchange of solvency capital
    uint64 tokenInterestRate; // in Wad - Overall interest rate of the token
  }

  Scr internal _scr;

  // Mapping that keeps track of allowed borrowers (PremiumsAccount) and their current debt
  mapping(address => TimeScaled.ScaledAmount) internal _poolLoans;

  struct PackedParams {
    uint16 liquidityRequirement; // Liquidity requirement to lock more/less than SCR - 4 decimals
    uint16 minUtilizationRate; // Min utilization rate, to reject deposits that leave UR under this value - 4 decimals
    uint16 maxUtilizationRate; // Max utilization rate, to reject lockScr that leave UR above this value - 4 decimals
    uint16 poolLoanInterestRate; // Annualized interest rate charged to internal borrowers (premiums accounts) - 4dec
  }

  PackedParams internal _params;

  event PoolLoan(address indexed borrower, uint256 value, uint256 amountAsked);
  event PoolLoanRepaid(address indexed borrower, uint256 value);
  event PoolBorrowerAdded(address borrower);

  modifier onlyBorrower() {
    require(_poolLoans[_msgSender()].scale != 0, "The caller must be a borrower");
    _;
  }

  /// @custom:oz-upgrades-unsafe-allow constructor
  // solhint-disable-next-line no-empty-blocks
  constructor(IPolicyPool policyPool_) Reserve(policyPool_) {}

  /**
   * @dev Initializes the eToken
   * @param maxUtilizationRate_ Max utilization rate (scr/totalSupply) (in Ray - default=1 Ray)
   * @param poolLoanInterestRate_ Rate of loans givencrto the policy pool (in Ray)
   * @param name_ Name of the eToken
   * @param symbol_ Symbol of the eToken
   */
  function initialize(
    string memory name_,
    string memory symbol_,
    uint256 maxUtilizationRate_,
    uint256 poolLoanInterestRate_
  ) public initializer {
    __PolicyPoolComponent_init();
    __EToken_init_unchained(name_, symbol_, maxUtilizationRate_, poolLoanInterestRate_);
  }

  // solhint-disable-next-line func-name-mixedcase
  function __EToken_init_unchained(
    string memory name_,
    string memory symbol_,
    uint256 maxUtilizationRate_,
    uint256 poolLoanInterestRate_
  ) internal initializer {
    _name = name_;
    _symbol = symbol_;
    _tsScaled.init();
    /* _scr = Scr({
      scr: 0,
      interestRate: 0,
      tokenInterestRate: 0
    }); */
    _params = PackedParams({
      maxUtilizationRate: uint16(maxUtilizationRate_ / 1e14),
      liquidityRequirement: 1e4,
      minUtilizationRate: 0,
      poolLoanInterestRate: uint16(poolLoanInterestRate_ / 1e14)
    });

    _validateParameters();
  }

  // runs validation on EToken parameters
  function _validateParameters() internal view override {
    require(
      _params.liquidityRequirement >= 8e3 && _params.liquidityRequirement <= 13e3,
      "Validation: liquidityRequirement must be [0.8, 1.3]"
    );
    require(
      _params.maxUtilizationRate >= 5e3 && _params.maxUtilizationRate <= 1e4,
      "Validation: maxUtilizationRate must be [0.5, 1]"
    );
    require(_params.minUtilizationRate <= 1e4, "Validation: minUtilizationRate must be [0, 1]");
    require(_params.poolLoanInterestRate <= 5e3, "Validation: poolLoanInterestRate must be <= 50%");
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
    return _tsScaled.getScaledAmount(tokenInterestRate());
  }

  /**
   * @dev See {IERC20-balanceOf}.
   */
  function balanceOf(address account) public view virtual override returns (uint256) {
    uint256 principalBalance = _balances[account];
    if (principalBalance == 0) return 0;
    return _tsScaled.getScale(tokenInterestRate()).rayMul(principalBalance.wadToRay()).rayToWad();
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
    uint256 scaledAmount = _tsScaled.scaleAmountNow(tokenInterestRate(), amount);

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
    uint256 scaledAmount = _tsScaled.add(amount, tokenInterestRate());
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

    uint256 scaledAmount = _tsScaled.sub(amount, tokenInterestRate());
    uint256 accountBalance = _balances[account];
    require(accountBalance >= scaledAmount, "EToken: burn amount exceeds balance");
    _balances[account] = accountBalance - scaledAmount;

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

  function _updateTokenInterestRate() internal {
    uint256 totalSupply_ = this.totalSupply();
    if (totalSupply_ == 0) _scr.tokenInterestRate = 0;
    else {
      _scr.tokenInterestRate = uint64(
        uint256(_scr.interestRate).wadMul(uint256(_scr.scr)).wadDiv(totalSupply_)
      );
    }
  }

  function getCurrentScale(bool updated) public view returns (uint256) {
    if (updated) return _tsScaled.getScale(tokenInterestRate());
    else return uint256(_tsScaled.scale);
  }

  function fundsAvailable() public view returns (uint256) {
    uint256 totalSupply_ = this.totalSupply();
    if (totalSupply_ > uint256(_scr.scr)) return totalSupply_ - uint256(_scr.scr);
    else return 0;
  }

  function fundsAvailableToLock() public view returns (uint256) {
    uint256 totalSupply_ = this.totalSupply();
    if (totalSupply_ > uint256(_scr.scr))
      return (totalSupply_ - uint256(_scr.scr)).wadMul(maxUtilizationRate());
    else return 0;
  }

  function scr() public view virtual override returns (uint256) {
    return uint256(_scr.scr);
  }

  function scrInterestRate() public view override returns (uint256) {
    return uint256(_scr.interestRate);
  }

  function tokenInterestRate() public view override returns (uint256) {
    return uint256(_scr.tokenInterestRate);
  }

  function liquidityRequirement() public view returns (uint256) {
    return uint256(_params.liquidityRequirement) * 1e14; // 4 -> 18 decimals
  }

  function maxUtilizationRate() public view returns (uint256) {
    return uint256(_params.maxUtilizationRate) * 1e14; // 4 -> 18 decimals
  }

  function minUtilizationRate() public view returns (uint256) {
    return uint256(_params.minUtilizationRate) * 1e14; // 4 -> 18 decimals
  }

  function utilizationRate() public view returns (uint256) {
    return uint256(_scr.scr).wadDiv(this.totalSupply());
  }

  function lockScr(uint256 scrAmount, uint256 policyInterestRate) external override onlyBorrower {
    require(
      scrAmount <= this.fundsAvailableToLock(),
      "Not enought funds available to cover the SCR"
    );
    _tsScaled.updateScale(tokenInterestRate());
    if (_scr.scr == 0) {
      _scr.scr = uint128(scrAmount);
      _scr.interestRate = uint64(policyInterestRate);
    } else {
      uint256 origScr = uint256(_scr.scr);
      uint256 newScr = origScr + scrAmount;
      _scr.interestRate = uint64(
        (uint256(_scr.interestRate).wadMul(origScr) + policyInterestRate.wadMul(scrAmount)).wadDiv(
          newScr
        )
      );
      _scr.scr = uint128(newScr);
    }
    emit SCRLocked(policyInterestRate, scrAmount);
    _updateTokenInterestRate();
  }

  function unlockScr(
    uint256 scrAmount,
    uint256 policyInterestRate,
    int256 adjustment
  ) external override onlyBorrower {
    require(scrAmount <= uint256(_scr.scr), "Current SCR less than the amount you want to unlock");
    _tsScaled.updateScale(tokenInterestRate());

    if (uint256(_scr.scr) == scrAmount) {
      _scr.scr = 0;
      _scr.interestRate = 0;
    } else {
      uint256 origScr = uint256(_scr.scr);
      uint256 newScr = origScr - scrAmount;
      _scr.interestRate = uint64(
        (uint256(_scr.interestRate).wadMul(origScr) - policyInterestRate.wadMul(scrAmount)).wadDiv(
          newScr
        )
      );
      _scr.scr = uint128(newScr);
    }
    emit SCRUnlocked(policyInterestRate, scrAmount);
    _discreteChange(adjustment);
  }

  function _discreteChange(int256 amount) internal {
    _tsScaled.discreteChange(amount, tokenInterestRate());
    _updateTokenInterestRate();
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
    _mint(provider, amount);
    _updateTokenInterestRate();
    require(utilizationRate() >= minUtilizationRate(), "Deposit rejected - Utilization Rate < min");
    return balanceOf(provider);
  }

  function totalWithdrawable() public view virtual override returns (uint256) {
    uint256 locked = uint256(_scr.scr).wadMul(liquidityRequirement());
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
    uint256 balance = balanceOf(provider);
    if (balance == 0) return 0;
    if (amount > balance) amount = balance;
    uint256 withdrawable = totalWithdrawable();
    if (amount > withdrawable) amount = withdrawable;
    if (amount == 0) return 0;
    _burn(provider, amount);
    _updateTokenInterestRate();
    _transferTo(provider, amount);
    return amount;
  }

  function addBorrower(address borrower) external override onlyPolicyPool {
    TimeScaled.ScaledAmount storage loan = _poolLoans[borrower];
    if (loan.scale == 0) {
      loan.init();
      emit PoolBorrowerAdded(borrower);
    }
  }

  function lendToPool(
    uint256 amount,
    address receiver,
    bool fromAvailable
  ) external override onlyBorrower whenNotPaused returns (uint256) {
    uint256 amountAsked = amount;
    if (fromAvailable && amount > fundsAvailable()) amount = fundsAvailable();
    if (!fromAvailable && amount > totalSupply()) amount = totalSupply();
    if (amount > _tsScaled.maxNegativeAdjustment(tokenInterestRate())) {
      amount = _tsScaled.maxNegativeAdjustment(tokenInterestRate());
      if (amount == 0) return amountAsked;
    }
    TimeScaled.ScaledAmount storage loan = _poolLoans[_msgSender()];
    loan.add(amount, poolLoanInterestRate());
    _discreteChange(-int256(amount));
    _transferTo(receiver, amount);
    emit PoolLoan(_msgSender(), amount, amountAsked);
    return amountAsked - amount;
  }

  function repayPoolLoan(uint256 amount, address onBehalfOf) external override {
    // Anyone can call this method, since it has to pay
    currency().safeTransferFrom(_msgSender(), address(this), amount);
    TimeScaled.ScaledAmount storage loan = _poolLoans[onBehalfOf];
    require(loan.scale != 0, "Not a registered borrower");
    loan.sub(amount, poolLoanInterestRate());
    _discreteChange(int256(amount));
    emit PoolLoanRepaid(onBehalfOf, amount);
  }

  function getPoolLoan(address borrower) public view virtual override returns (uint256) {
    TimeScaled.ScaledAmount storage loan = _poolLoans[borrower];
    if (loan.scale == 0) return 0;
    return loan.getScaledAmount(poolLoanInterestRate());
  }

  function poolLoanInterestRate() public view returns (uint256) {
    return uint256(_params.poolLoanInterestRate) * 1e14; // to wad 4 -> 18 digits
  }

  function setPoolLoanInterestRate(uint256 newRate)
    external
    onlyPoolRole2(LEVEL2_ROLE, LEVEL3_ROLE)
  {
    bool tweak = !hasPoolRole(LEVEL2_ROLE);
    require(
      !tweak || _isTweakWad(poolLoanInterestRate(), newRate, 3e17),
      "Tweak exceeded: poolLoanInterestRate tweaks only up to 30%"
    );
    // This call changes the interest rate without updating the current loans up to this point
    // So, if interest rate goes from 5% to 6%, this change will be retroactive to the lastUpdate of each
    // loan. Since it's a permissioned call, I'm ok with this. If a caller wants to reduce the impact, it can
    // issue 1 wei repayPoolLoan to each active loan, forcing the update of the scales
    _params.poolLoanInterestRate = uint16(newRate / 1e14);
    _parameterChanged(IPolicyPoolConfig.GovernanceActions.setPoolLoanInterestRate, newRate, tweak);
  }

  function setLiquidityRequirement(uint256 newRate)
    external
    onlyPoolRole2(LEVEL2_ROLE, LEVEL3_ROLE)
  {
    bool tweak = !hasPoolRole(LEVEL2_ROLE);
    require(
      !tweak || _isTweakWad(liquidityRequirement(), newRate, 1e17),
      "Tweak exceeded: liquidityRequirement tweaks only up to 10%"
    );
    _params.liquidityRequirement = uint16(newRate / 1e14);
    _parameterChanged(IPolicyPoolConfig.GovernanceActions.setLiquidityRequirement, newRate, tweak);
  }

  function setMaxUtilizationRate(uint256 newRate) external onlyPoolRole2(LEVEL2_ROLE, LEVEL3_ROLE) {
    bool tweak = !hasPoolRole(LEVEL2_ROLE);
    require(
      !tweak || _isTweakWad(maxUtilizationRate(), newRate, 3e17),
      "Tweak exceeded: maxUtilizationRate tweaks only up to 30%"
    );
    _params.maxUtilizationRate = uint16(newRate / 1e14);
    _parameterChanged(IPolicyPoolConfig.GovernanceActions.setMaxUtilizationRate, newRate, tweak);
  }

  function setMinUtilizationRate(uint256 newRate) external onlyPoolRole2(LEVEL2_ROLE, LEVEL3_ROLE) {
    bool tweak = !hasPoolRole(LEVEL2_ROLE);
    require(
      !tweak || _isTweakWad(minUtilizationRate(), newRate, 3e17),
      "Tweak exceeded: minUtilizationRate tweaks only up to 30%"
    );
    _params.minUtilizationRate = uint16(newRate / 1e14);
    _parameterChanged(IPolicyPoolConfig.GovernanceActions.setMinUtilizationRate, newRate, tweak);
  }
}
