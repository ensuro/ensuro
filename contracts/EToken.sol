// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {ERC20PermitUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPolicyPool} from "./interfaces/IPolicyPool.sol";
import {ILPWhitelist} from "./interfaces/ILPWhitelist.sol";
import {ICooler} from "./interfaces/ICooler.sol";
import {IEToken} from "./interfaces/IEToken.sol";
import {IPolicyPoolComponent} from "./interfaces/IPolicyPoolComponent.sol";
import {ETKLib} from "./ETKLib.sol";
import {Reserve} from "./Reserve.sol";

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
contract EToken is Reserve, ERC20PermitUpgradeable, IEToken {
  using Math for uint256;
  using ETKLib for ETKLib.ScaledAmount;
  using ETKLib for ETKLib.Scr;
  using ETKLib for ETKLib.Scale;
  using SafeERC20 for IERC20Metadata;
  using SafeCast for uint256;

  uint256 internal constant WAD = 1e18;
  uint256 internal constant FOUR_DECIMAL_TO_WAD = 1e14;
  uint16 internal constant HUNDRED_PERCENT = 1e4;
  uint256 internal constant LIQ_REQ_MIN = 0.8e18; // 80%
  uint256 internal constant LIQ_REQ_MAX = 1.3e18; // 130%
  uint256 internal constant INT_LOAN_IR_MAX = 0.5e18; // 50% - Maximum value for InternalLoan interest rate

  ETKLib.ScaledAmount internal _tsScaled; // Total Supply scaled

  ETKLib.Scr internal _scr;

  // Mapping that keeps track of allowed borrowers (PremiumsAccount) and their current debt
  mapping(address => ETKLib.ScaledAmount) internal _loans;

  struct PackedParams {
    ILPWhitelist whitelist; // Whitelist for deposits and transfers
    uint16 liquidityRequirement; // Liquidity requirement to lock more/less than SCR - 4 decimals
    uint16 minUtilizationRate; // Min utilization rate, to reject deposits that leave UR under this value - 4 decimals
    uint16 maxUtilizationRate; // Max utilization rate, to reject lockScr that leave UR above this value - 4 decimals
    uint16 internalLoanInterestRate; // Annualized interest rate charged to internal borrowers (premiums accounts) - 4dec
  }

  PackedParams internal _params;

  IERC4626 internal _yieldVault;
  ICooler internal _cooler;

  error OnlyBorrower(address caller); // The caller must be a borrower
  error InvalidParameter(Parameter parameter);
  error TransferNotWhitelisted(address from_, address to_, uint256 value);
  error DepositNotWhitelisted(address account, uint256 value);
  error WithdrawalNotWhitelisted(address account, uint256 value);
  error NotEnoughScrFunds(uint256 required, uint256 available);
  error UtilizationRateTooLow(uint256 actualUtilization, uint256 minUtilization);
  error InvalidBorrower(address borrower);
  error BorrowerAlreadyAdded(address borrower);
  error InvalidWhitelist(ILPWhitelist whitelist);
  error InvalidCooler(ICooler cooler);
  error ExceedsMaxWithdraw(uint256 requested, uint256 maxWithdraw);
  error WithdrawalsRequireCooldown(ICooler cooler);

  event InternalLoan(address indexed borrower, uint256 value, uint256 amountAsked);
  event InternalLoanRepaid(address indexed borrower, uint256 value);
  event InternalBorrowerAdded(address indexed borrower);
  event InternalBorrowerRemoved(address indexed borrower, uint256 defaultedDebt);
  event ParameterChanged(Parameter param, uint256 newValue);
  event WhitelistChanged(ILPWhitelist oldWhitelist, ILPWhitelist newWhitelist);
  event CoolerChanged(ICooler oldCooler, ICooler newCooler);
  event ETokensRedistributed(address indexed owner, uint256 distributedProfit);

  modifier onlyBorrower() {
    require(_loans[_msgSender()].lastUpdate != 0, OnlyBorrower(_msgSender()));
    _;
  }

  // keccak256(abi.encode(uint256(keccak256("openzeppelin.storage.ERC20")) - 1)) & ~bytes32(uint256(0xff))
  // solhint-disable-next-line const-name-snakecase
  bytes32 private constant ERC20StorageLocation = 0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00;

  function _getERC20StorageFromEToken() private pure returns (ERC20Storage storage $) {
    // solhint-disable-next-line no-inline-assembly
    assembly {
      $.slot := ERC20StorageLocation
    }
  }

  /// @custom:oz-upgrades-unsafe-allow constructor
  // solhint-disable-next-line no-empty-blocks
  constructor(IPolicyPool policyPool_) Reserve(policyPool_) {}

  /**
   * @dev Initializes the eToken
   * @param maxUtilizationRate_ Max utilization rate (scr/totalSupply) (in Ray - default=1 Ray)
   * @param internalLoanInterestRate_ Rate of loans givencrto the policy pool (in Ray)
   * @param name_ Name of the eToken
   * @param symbol_ Symbol of the eToken
   */
  function initialize(
    string memory name_,
    string memory symbol_,
    uint256 maxUtilizationRate_,
    uint256 internalLoanInterestRate_
  ) public initializer {
    __Reserve_init();
    __ERC20_init(name_, symbol_);
    __ERC20Permit_init(name_);
    __EToken_init_unchained(maxUtilizationRate_, internalLoanInterestRate_);
  }

  // solhint-disable-next-line func-name-mixedcase
  function __EToken_init_unchained(
    uint256 maxUtilizationRate_,
    uint256 internalLoanInterestRate_
  ) internal onlyInitializing {
    _tsScaled.init();
    /* _scr = Scr({
      scr: 0,
      interestRate: 0,
      tokenInterestRate: 0
    }); */
    _params = PackedParams({
      maxUtilizationRate: 0, // Will be set in the next line
      liquidityRequirement: HUNDRED_PERCENT,
      minUtilizationRate: 0,
      internalLoanInterestRate: 0, // Will be set in the next line
      whitelist: ILPWhitelist(address(0))
    });

    setParam(Parameter.maxUtilizationRate, maxUtilizationRate_);
    setParam(Parameter.internalLoanInterestRate, internalLoanInterestRate_);
  }

  /// @inheritdoc IERC165
  function supportsInterface(bytes4 interfaceId) public view virtual override returns (bool) {
    return
      super.supportsInterface(interfaceId) ||
      interfaceId == type(IERC20).interfaceId ||
      interfaceId == type(IERC20Metadata).interfaceId ||
      interfaceId == type(IEToken).interfaceId;
  }

  /*** BEGIN ERC20 methods - changes required to customize OZ's ERC20 implementation */

  /// @inheritdoc IERC20Metadata
  function decimals() public view virtual override returns (uint8) {
    return _policyPool.currency().decimals();
  }

  /// @inheritdoc IERC20
  function totalSupply() public view virtual override returns (uint256) {
    return _tsScaled.projectScale(_scr).toCurrent(_tsScaled.amount);
  }

  /// @inheritdoc IERC20
  function balanceOf(address account) public view virtual override returns (uint256) {
    return _tsScaled.projectScale(_scr).toCurrent(super.balanceOf(account));
  }

  /// @inheritdoc ERC20Upgradeable
  function _update(address from, address to, uint256 value) internal virtual override {
    uint256 valueScaled;
    if (from == address(0)) {
      // Mint
      (_tsScaled, valueScaled) = _tsScaled.add(value, _scr);
    } else if (to == address(0)) {
      // Burn
      (_tsScaled, valueScaled) = _tsScaled.sub(value, _scr);
    } else {
      // Transfer
      require(
        address(_params.whitelist) == address(0) || _params.whitelist.acceptsTransfer(this, from, to, value),
        TransferNotWhitelisted(from, to, value)
      );
      valueScaled = _tsScaled.projectScale(_scr).toScaledCeil(value);
    }

    ERC20Storage storage $ = _getERC20StorageFromEToken();
    if (from != address(0)) {
      uint256 fromBalance = $._balances[from];
      if (fromBalance < valueScaled) {
        revert ERC20InsufficientBalance(from, _tsScaled.projectScale(_scr).toCurrent(fromBalance), value);
      }
      unchecked {
        // Overflow not possible: valueScaled <= fromBalance <= totalSupply.
        $._balances[from] = fromBalance - valueScaled;
      }
    }

    if (to != address(0)) {
      unchecked {
        // Overflow not possible: balance + valueScaled is at most totalSupply, which we know fits into a uint256.
        $._balances[to] += valueScaled;
      }
    }

    emit Transfer(from, to, value);
  }

  /*** END ERC20 methods */

  /** BEGIN Methods following AAVE's IScaledBalanceToken, to simplify future integrations */

  /**
   * @dev Returns the scaled balance of the user. The scaled balance is the sum of all the
   * updated stored balance divided by the EToken's scale index
   * @param user The user whose balance is calculated
   * @return The scaled balance of the user
   **/
  function scaledBalanceOf(address user) external view returns (uint256) {
    return super.balanceOf(user);
  }

  /**
   * @dev Returns the scaled balance of the user and the scaled total supply.
   * @param user The address of the user
   * @return The scaled balance of the user
   * @return The scaled balance and the scaled total supply
   **/
  function getScaledUserBalanceAndSupply(address user) external view returns (uint256, uint256) {
    return (super.balanceOf(user), uint256(_tsScaled.amount));
  }

  /**
   * @dev Returns the (un)scaled total supply of the EToken. Equals to the sum of `scaledBalanceOf(x)` of all users
   * @return The scaled total supply
   **/
  function scaledTotalSupply() external view returns (uint256) {
    return uint256(_tsScaled.amount);
  }

  /** END Methods following AAVE's IScaledBalanceToken */

  function getCurrentScale(bool updated) public view override returns (uint256) {
    if (updated) return _tsScaled.projectScale(_scr).toUint256();
    else return _tsScaled.scale.toUint256();
  }

  function fundsAvailable() public view returns (uint256) {
    return _scr.fundsAvailable(totalSupply());
  }

  function fundsAvailableToLock() public view returns (uint256) {
    uint256 ts = totalSupply();
    if (address(_cooler) != address(0)) {
      uint256 pendingWithdraw = _cooler.pendingWithdrawals(this);
      if (pendingWithdraw >= ts) {
        ts = 0;
      } else {
        ts = Math.min(ts - pendingWithdraw, ts.mulDiv(maxUtilizationRate(), WAD));
      }
    } else {
      ts = ts.mulDiv(maxUtilizationRate(), WAD);
    }
    return _scr.fundsAvailable(ts);
  }

  function yieldVault() public view override returns (IERC4626) {
    return _yieldVault;
  }

  function _setYieldVault(IERC4626 newYV) internal override {
    _yieldVault = newYV;
  }

  // solhint-disable-next-line func-name-mixedcase
  function _4toWad(uint16 value) internal pure returns (uint256) {
    // 4 decimals to Wad (18 decimals)
    return uint256(value) * FOUR_DECIMAL_TO_WAD;
  }

  function _wadTo4(uint256 value) internal pure returns (uint16) {
    // Wad to 4 decimals
    return (value / FOUR_DECIMAL_TO_WAD).toUint16();
  }

  function scr() public view virtual override returns (uint256) {
    return _scr.scrAmount();
  }

  function scrInterestRate() public view override returns (uint256) {
    return uint256(_scr.interestRate);
  }

  function tokenInterestRate() public view override returns (uint256) {
    uint256 ts = totalSupply();
    if (ts == 0) return 0;
    else {
      return uint256(_scr.interestRate).mulDiv(_scr.scr, ts);
    }
  }

  function liquidityRequirement() public view returns (uint256) {
    return _4toWad(_params.liquidityRequirement);
  }

  function maxUtilizationRate() public view returns (uint256) {
    return _4toWad(_params.maxUtilizationRate);
  }

  function minUtilizationRate() public view returns (uint256) {
    return _4toWad(_params.minUtilizationRate);
  }

  function utilizationRate() public view returns (uint256) {
    return _scr.scrAmount().mulDiv(WAD, this.totalSupply());
  }

  function lockScr(uint256 policyId, uint256 scrAmount, uint256 policyInterestRate) external override onlyBorrower {
    if (scrAmount > fundsAvailableToLock()) revert NotEnoughScrFunds(scrAmount, fundsAvailableToLock());
    _tsScaled = _tsScaled.discreteChange(0, _scr); // Accrues interests so far, to update the scale before SCR changes
    _scr = _scr.add(scrAmount, policyInterestRate);
    emit SCRLocked(policyId, policyInterestRate, scrAmount);
  }

  function unlockScr(
    uint256 policyId,
    uint256 scrAmount,
    uint256 policyInterestRate,
    int256 adjustment
  ) external override onlyBorrower {
    // Require removed, since it shouldn't happen and if happens it will fail in _scr.sub
    // require(scrAmount <= uint256(_scr.scr), "Current SCR less than the amount you want to unlock");
    _tsScaled = _tsScaled.discreteChange(adjustment, _scr);
    _scr = _scr.sub(scrAmount, policyInterestRate);
    emit SCRUnlocked(policyId, policyInterestRate, scrAmount, adjustment);
  }

  function _yieldEarnings(int256 earnings) internal override {
    _discreteChange(earnings);
    super._yieldEarnings(earnings);
  }

  function _discreteChange(int256 amount) internal {
    _tsScaled = _tsScaled.discreteChange(amount, _scr);
  }

  function deposit(uint256 amount, address caller, address receiver) external override onlyPolicyPool {
    require(
      address(_params.whitelist) == address(0) ||
        (_params.whitelist.acceptsDeposit(this, caller, amount) &&
          (caller == receiver || _params.whitelist.acceptsTransfer(this, caller, receiver, amount))),
      DepositNotWhitelisted(caller, amount)
    );
    _mint(receiver, amount);
    if (utilizationRate() < minUtilizationRate()) revert UtilizationRateTooLow(utilizationRate(), minUtilizationRate());
  }

  function totalWithdrawable() public view virtual override returns (uint256) {
    uint256 locked = _scr.scrAmount().mulDiv(liquidityRequirement(), WAD);
    uint256 totalSupply_ = totalSupply();
    if (totalSupply_ >= locked) return totalSupply_ - locked;
    else return 0;
  }

  function withdraw(
    uint256 amount,
    address caller,
    address owner,
    address receiver
  ) external override onlyPolicyPool returns (uint256) {
    /**
     * Here we don't check for maxUtilizationRate because that limit only affects locking more capital (`lockScr`), but
     * doesn't affects the right of liquidity providers to withdraw their funds.
     * The only limit for withdraws is the `totalWithdrawable()` function, that's affected by the relation between the
     * scr and the totalSupply.
     */
    uint256 maxWithdraw = Math.min(balanceOf(owner), totalWithdrawable());
    if (amount == type(uint256).max) amount = maxWithdraw;
    if (amount == 0) return 0;
    require(
      address(_cooler) == address(0) || address(_cooler) == caller || _cooler.cooldownPeriod(this, owner, amount) == 0,
      WithdrawalsRequireCooldown(_cooler)
    );
    require(amount <= maxWithdraw, ExceedsMaxWithdraw(amount, maxWithdraw));
    /**
     * For the whitelist validation, I use the owner address. If the caller != owner, then I assume that if the
     * owner gave spending approval to the caller, that's enough.
     */
    require(
      address(_params.whitelist) == address(0) || _params.whitelist.acceptsWithdrawal(this, owner, amount),
      WithdrawalNotWhitelisted(owner, amount)
    );
    if (caller != owner) {
      _spendAllowance(owner, caller, amount);
    }
    _burn(owner, amount);
    _transferTo(receiver, amount);
    return amount;
  }

  function redistribute(uint256 amount) external override {
    _burn(_msgSender(), amount);
    _discreteChange(amount.toInt256());
    emit ETokensRedistributed(_msgSender(), amount);
  }

  function addBorrower(address borrower) external override onlyPolicyPool {
    require(borrower != address(0), InvalidBorrower(borrower));
    ETKLib.ScaledAmount storage loan = _loans[borrower];
    require(loan.lastUpdate == 0, BorrowerAlreadyAdded(borrower));
    loan.init();
    emit InternalBorrowerAdded(borrower);
  }

  function removeBorrower(address borrower) external override onlyPolicyPool {
    require(borrower != address(0), InvalidBorrower(borrower));
    uint256 defaultedDebt = getLoan(borrower);
    delete _loans[borrower];
    emit InternalBorrowerRemoved(borrower, defaultedDebt);
  }

  /**
   * @dev Returns the maximum negative adjustment (discrete loss) the eToken can accept without breaking consistency.
   *      The limit comes from limits in the internal scale that takes scaledTotalSupply() to totalSupply()
   */
  function maxNegativeAdjustment() public view returns (uint256) {
    return totalSupply() - _tsScaled.minValue(); // Min value accepted by _tsScaled
  }

  function internalLoan(uint256 amount, address receiver) external override onlyBorrower returns (uint256) {
    uint256 amountAsked = amount;
    amount = Math.min(amount, maxNegativeAdjustment());
    if (amount == 0) return amountAsked;
    (_loans[_msgSender()], ) = _loans[_msgSender()].add(amount, internalLoanInterestRate());
    _discreteChange(-int256(amount));
    _transferTo(receiver, amount);
    emit InternalLoan(_msgSender(), amount, amountAsked);
    return amountAsked - amount;
  }

  function repayLoan(uint256 amount, address onBehalfOf) external override {
    // Anyone can call this method, since it has to pay
    ETKLib.ScaledAmount storage loan = _loans[onBehalfOf];
    require(loan.lastUpdate != 0, InvalidBorrower(onBehalfOf));
    (_loans[onBehalfOf], ) = loan.sub(amount, internalLoanInterestRate());
    _discreteChange(int256(amount));
    emit InternalLoanRepaid(onBehalfOf, amount);
    // Interaction at the end for security reasons
    currency().safeTransferFrom(_msgSender(), address(this), amount);
  }

  function getLoan(address borrower) public view virtual override returns (uint256) {
    ETKLib.ScaledAmount storage loan = _loans[borrower];
    require(loan.lastUpdate != 0, InvalidBorrower(borrower));
    return loan.projectScale(internalLoanInterestRate()).toCurrentCeil(uint256(loan.amount));
  }

  function internalLoanInterestRate() public view returns (uint256) {
    return _4toWad(_params.internalLoanInterestRate);
  }

  function setParam(Parameter param, uint256 newValue) public {
    if (param == Parameter.liquidityRequirement) {
      require(newValue >= LIQ_REQ_MIN && newValue <= LIQ_REQ_MAX, InvalidParameter(param));
      _params.liquidityRequirement = _wadTo4(newValue);
    } else if (param == Parameter.minUtilizationRate) {
      require(newValue <= WAD, InvalidParameter(param));
      _params.minUtilizationRate = _wadTo4(newValue);
    } else if (param == Parameter.maxUtilizationRate) {
      require(newValue <= WAD, InvalidParameter(param));
      _params.maxUtilizationRate = _wadTo4(newValue);
      /*
       * We don't validate minUtilizationRate < maxUtilizationRate because the opposite is valid too.
       * These limits aren't strong limits on the values the utilization rate can take, but instead they are
       * limits on specific operations.
       * `minUtilizationRate` is used to avoid new deposits to dilute the yields of existing LPs, but it doesn't
       * prevent the UR from going down in other operations (`unlockScr` for example).
       * `maxUtilizationRate` is used to prevent selling more coverage when UR is too high, only checked on `lockScr`
       * operations, but not in withdrawals or other operations.
       */
    } else {
      // (param == Parameter.internalLoanInterestRate) - since param can only take one of 4 values

      // This call changes the interest rate without updating the current loans up to this point
      // So, if interest rate goes from 5% to 6%, this change will be retroactive to the lastUpdate of each
      // loan. Since it's a permissioned call, I'm ok with this. If a caller wants to reduce the impact, it can
      // issue 1 wei repayLoan to each active loan, forcing the update of the scales
      require(newValue <= INT_LOAN_IR_MAX, InvalidParameter(param));
      _params.internalLoanInterestRate = _wadTo4(newValue);
    }
    emit ParameterChanged(param, newValue);
  }

  function setWhitelist(ILPWhitelist lpWhitelist_) external {
    require(
      address(lpWhitelist_) == address(0) || IPolicyPoolComponent(address(lpWhitelist_)).policyPool() == _policyPool,
      InvalidWhitelist(lpWhitelist_)
    );
    emit WhitelistChanged(_params.whitelist, lpWhitelist_);
    _params.whitelist = lpWhitelist_;
  }

  function whitelist() external view returns (ILPWhitelist) {
    return _params.whitelist;
  }

  function setCooler(ICooler newCooler) external {
    require(
      address(newCooler) == address(0) || IPolicyPoolComponent(address(newCooler)).policyPool() == _policyPool,
      InvalidCooler(newCooler)
    );
    emit CoolerChanged(_cooler, newCooler);
    _cooler = newCooler;
  }

  function cooler() external view override returns (address) {
    return address(_cooler);
  }

  /**
   * @dev This empty reserved space is put in place to allow future versions to add new
   * variables without shifting down storage in the inheritance chain.
   * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
   */
  uint256[44] private __gap;
}
