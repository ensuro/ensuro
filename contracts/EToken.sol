// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPolicyPool} from "./interfaces/IPolicyPool.sol";
import {ILPWhitelist} from "./interfaces/ILPWhitelist.sol";
import {IEToken} from "./interfaces/IEToken.sol";
import {IPolicyPoolComponent} from "./interfaces/IPolicyPoolComponent.sol";
import {WadRayMath} from "./dependencies/WadRayMath.sol";
import {TimeScaled} from "./TimeScaled.sol";
import {Governance} from "./Governance.sol";
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
contract EToken is Reserve, ERC20Upgradeable, IEToken {
  using WadRayMath for uint256;
  using TimeScaled for TimeScaled.ScaledAmount;
  using SafeERC20 for IERC20Metadata;
  using SafeCast for uint256;

  uint256 internal constant FOUR_DECIMAL_TO_WAD = 1e14;
  uint16 internal constant HUNDRED_PERCENT = 1e4;
  uint16 internal constant MAX_UR_MIN = 5e3; // 50% - Minimum value for Max Utilization Rate
  uint16 internal constant LIQ_REQ_MIN = 8e3; // 80%
  uint16 internal constant LIQ_REQ_MAX = 13e3; // 130%
  uint16 internal constant INT_LOAN_IR_MAX = 5e3; // 50% - Maximum value for InternalLoan interest rate

  TimeScaled.ScaledAmount internal _tsScaled; // Total Supply scaled

  struct Scr {
    uint128 scr; // in Wad - Capital locked as Solvency Capital Requirement of backed up policies
    uint64 interestRate; // in Wad - Interest rate received in exchange of solvency capital
    uint64 tokenInterestRate; // in Wad - Overall interest rate of the token
  }

  Scr internal _scr;

  // Mapping that keeps track of allowed borrowers (PremiumsAccount) and their current debt
  mapping(address => TimeScaled.ScaledAmount) internal _loans;

  struct PackedParams {
    ILPWhitelist whitelist; // Whitelist for deposits and transfers
    uint16 liquidityRequirement; // Liquidity requirement to lock more/less than SCR - 4 decimals
    uint16 minUtilizationRate; // Min utilization rate, to reject deposits that leave UR under this value - 4 decimals
    uint16 maxUtilizationRate; // Max utilization rate, to reject lockScr that leave UR above this value - 4 decimals
    uint16 internalLoanInterestRate; // Annualized interest rate charged to internal borrowers (premiums accounts) - 4dec
  }

  PackedParams internal _params;

  IERC4626 internal _yieldVault;

  event InternalLoan(address indexed borrower, uint256 value, uint256 amountAsked);
  event InternalLoanRepaid(address indexed borrower, uint256 value);
  event InternalBorrowerAdded(address indexed borrower);
  event InternalBorrowerRemoved(address indexed borrower, uint256 defaultedDebt);

  modifier onlyBorrower() {
    require(_loans[_msgSender()].scale != 0, "The caller must be a borrower");
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
    __ERC20_init(name_, symbol_);
    __Reserve_init();
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
      maxUtilizationRate: _wadTo4(maxUtilizationRate_),
      liquidityRequirement: HUNDRED_PERCENT,
      minUtilizationRate: 0,
      internalLoanInterestRate: _wadTo4(internalLoanInterestRate_),
      whitelist: ILPWhitelist(address(0))
    });

    _validateParameters();
  }

  /// @inheritdoc IERC165
  function supportsInterface(bytes4 interfaceId) public view virtual override returns (bool) {
    return
      super.supportsInterface(interfaceId) ||
      interfaceId == type(IERC20).interfaceId ||
      interfaceId == type(IERC20Metadata).interfaceId ||
      interfaceId == type(IEToken).interfaceId;
  }

  // runs validation on EToken parameters
  function _validateParameters() internal view override {
    require(
      _params.liquidityRequirement >= LIQ_REQ_MIN && _params.liquidityRequirement <= LIQ_REQ_MAX,
      "Validation: liquidityRequirement must be [0.8, 1.3]"
    );
    require(
      _params.maxUtilizationRate >= MAX_UR_MIN && _params.maxUtilizationRate <= HUNDRED_PERCENT,
      "Validation: maxUtilizationRate must be [0.5, 1]"
    );
    require(_params.minUtilizationRate <= HUNDRED_PERCENT, "Validation: minUtilizationRate must be [0, 1]");
    /*
     * We don't validate minUtilizationRate < maxUtilizationRate because the opposite is valid too.
     * These limits aren't strong limits on the values the utilization rate can take, but instead they are
     * limits on specific operations.
     * `minUtilizationRate` is used to avoid new deposits to dilute the yields of existing LPs, but it doesn't
     * prevent the UR from going down in other operations (`unlockScr` for example).
     * `maxUtilizationRate` is used to prevent selling more coverage when UR is too high, only checked on `lockScr`
     * operations, but not in withdrawals or other operations.
     */
    require(_params.internalLoanInterestRate <= INT_LOAN_IR_MAX, "Validation: internalLoanInterestRate must be <= 50%");
  }

  /*** BEGIN ERC20 methods - changes required to customize OZ's ERC20 implementation */

  /// @inheritdoc IERC20Metadata
  function decimals() public view virtual override returns (uint8) {
    return _policyPool.currency().decimals();
  }

  /// @inheritdoc IERC20
  function totalSupply() public view virtual override returns (uint256) {
    return _tsScaled.getCurrentAmount(tokenInterestRate());
  }

  /// @inheritdoc IERC20
  function balanceOf(address account) public view virtual override returns (uint256) {
    return _tsScaled.scaledToCurrentNow(tokenInterestRate(), super.balanceOf(account));
  }

  /// @inheritdoc ERC20Upgradeable
  function _update(address from, address to, uint256 value) internal virtual override whenNotPaused {
    uint256 valueScaled;
    if (from == address(0)) {
      // Mint
      valueScaled = _tsScaled.add(value, tokenInterestRate());
    } else if (to == address(0)) {
      // Burn
      valueScaled = _tsScaled.sub(value, tokenInterestRate());
    } else {
      // Transfer
      require(
        address(_params.whitelist) == address(0) || _params.whitelist.acceptsTransfer(this, from, to, value),
        "Transfer not allowed - Liquidity Provider not whitelisted"
      );
      valueScaled = _tsScaled.currentToScaledNow(tokenInterestRate(), value);
    }

    ERC20Storage storage $ = _getERC20StorageFromEToken();
    if (from != address(0)) {
      uint256 fromBalance = $._balances[from];
      if (fromBalance < valueScaled) {
        revert ERC20InsufficientBalance(from, _tsScaled.scaledToCurrentNow(tokenInterestRate(), fromBalance), value);
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

  function _updateTokenInterestRate() internal {
    uint256 totalSupply_ = this.totalSupply();
    if (totalSupply_ == 0) _scr.tokenInterestRate = 0;
    else {
      uint256 newTokenInterestRate = uint256(_scr.interestRate).wadMul(uint256(_scr.scr)).wadDiv(totalSupply_);
      _scr.tokenInterestRate = (newTokenInterestRate > type(uint64).max)
        ? type(uint64).max
        : newTokenInterestRate.toUint64();
      // This is not the mathematically correct value, but the max we can set. The actual value of the total supply
      // will be adjusted when the policies expire or are resolved and the SCR is unlocked.
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
    uint256 supply = this.totalSupply().wadMul(maxUtilizationRate());
    if (supply > uint256(_scr.scr)) return supply - uint256(_scr.scr);
    else return 0;
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
    return uint256(_scr.scr);
  }

  function scrInterestRate() public view override returns (uint256) {
    return uint256(_scr.interestRate);
  }

  function tokenInterestRate() public view override returns (uint256) {
    return uint256(_scr.tokenInterestRate);
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
    return uint256(_scr.scr).wadDiv(this.totalSupply());
  }

  function lockScr(uint256 scrAmount, uint256 policyInterestRate) external override onlyBorrower whenNotPaused {
    require(scrAmount <= this.fundsAvailableToLock(), "Not enough funds available to cover the SCR");
    _tsScaled.updateScale(tokenInterestRate());
    if (_scr.scr == 0) {
      _scr.scr = scrAmount.toUint128();
      _scr.interestRate = policyInterestRate.toUint64();
    } else {
      uint256 origScr = uint256(_scr.scr);
      uint256 newScr = origScr + scrAmount;
      _scr.interestRate = (uint256(_scr.interestRate).wadMul(origScr) + policyInterestRate.wadMul(scrAmount))
        .wadDiv(newScr)
        .toUint64();
      _scr.scr = newScr.toUint128();
    }
    emit SCRLocked(policyInterestRate, scrAmount);
    _updateTokenInterestRate();
  }

  function unlockScr(
    uint256 scrAmount,
    uint256 policyInterestRate,
    int256 adjustment
  ) external override onlyBorrower whenNotPaused {
    require(scrAmount <= uint256(_scr.scr), "Current SCR less than the amount you want to unlock");
    _tsScaled.updateScale(tokenInterestRate());

    if (uint256(_scr.scr) == scrAmount) {
      _scr.scr = 0;
      _scr.interestRate = 0;
    } else {
      uint256 origScr = uint256(_scr.scr);
      uint256 newScr = origScr - scrAmount;
      _scr.interestRate = (uint256(_scr.interestRate).wadMul(origScr) - policyInterestRate.wadMul(scrAmount))
        .wadDiv(newScr)
        .toUint64();
      _scr.scr = newScr.toUint128();
    }
    emit SCRUnlocked(policyInterestRate, scrAmount);
    _discreteChange(adjustment);
  }

  function _yieldEarnings(int256 earnings) internal override {
    _discreteChange(earnings);
    super._yieldEarnings(earnings);
  }

  function _discreteChange(int256 amount) internal {
    _tsScaled.discreteChange(amount, tokenInterestRate());
    _updateTokenInterestRate();
  }

  function deposit(address provider, uint256 amount) external override onlyPolicyPool returns (uint256) {
    require(
      address(_params.whitelist) == address(0) || _params.whitelist.acceptsDeposit(this, provider, amount),
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

  function withdraw(address provider, uint256 amount) external override onlyPolicyPool returns (uint256) {
    /**
     * Here we don't check for maxUtilizationRate because that limit only affects locking more capital (`lockScr`), but
     * doesn't affects the right of liquidity providers to withdraw their funds.
     * The only limit for withdraws is the `totalWithdrawable()` function, that's affected by the relation between the
     * scr and the totalSupply.
     */
    uint256 maxWithdraw = Math.min(balanceOf(provider), totalWithdrawable());
    if (amount == type(uint256).max) amount = maxWithdraw;
    if (amount == 0) return 0;
    require(amount <= maxWithdraw, "amount > max withdrawable");
    require(
      address(_params.whitelist) == address(0) || _params.whitelist.acceptsWithdrawal(this, provider, amount),
      "Liquidity Provider not whitelisted"
    );
    _burn(provider, amount);
    _updateTokenInterestRate();
    _transferTo(provider, amount);
    return amount;
  }

  function addBorrower(address borrower) external override onlyPolicyPool {
    require(borrower != address(0), "EToken: Borrower cannot be the zero address");
    TimeScaled.ScaledAmount storage loan = _loans[borrower];
    if (loan.scale == 0) {
      loan.init();
      emit InternalBorrowerAdded(borrower);
    }
  }

  function removeBorrower(address borrower) external override onlyPolicyPool {
    require(borrower != address(0), "EToken: Borrower cannot be the zero address");
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

  function internalLoan(
    uint256 amount,
    address receiver
  ) external override onlyBorrower whenNotPaused returns (uint256) {
    uint256 amountAsked = amount;
    amount = Math.min(amount, maxNegativeAdjustment());
    if (amount == 0) return amountAsked;
    TimeScaled.ScaledAmount storage loan = _loans[_msgSender()];
    loan.add(amount, internalLoanInterestRate());
    _discreteChange(-int256(amount));
    _transferTo(receiver, amount);
    emit InternalLoan(_msgSender(), amount, amountAsked);
    return amountAsked - amount;
  }

  function repayLoan(uint256 amount, address onBehalfOf) external override whenNotPaused {
    require(amount > 0, "EToken: amount should be greater than zero.");
    // Anyone can call this method, since it has to pay
    TimeScaled.ScaledAmount storage loan = _loans[onBehalfOf];
    require(loan.scale != 0, "Not a registered borrower");
    loan.sub(amount, internalLoanInterestRate());
    _discreteChange(int256(amount));
    emit InternalLoanRepaid(onBehalfOf, amount);
    // Interaction at the end for security reasons
    currency().safeTransferFrom(_msgSender(), address(this), amount);
  }

  function getLoan(address borrower) public view virtual override returns (uint256) {
    TimeScaled.ScaledAmount storage loan = _loans[borrower];
    return loan.getCurrentAmount(internalLoanInterestRate());
  }

  function internalLoanInterestRate() public view returns (uint256) {
    return _4toWad(_params.internalLoanInterestRate);
  }

  function setParam(Parameter param, uint256 newValue) external {
    if (param == Parameter.liquidityRequirement) {
      _params.liquidityRequirement = _wadTo4(newValue);
    } else if (param == Parameter.minUtilizationRate) {
      _params.minUtilizationRate = _wadTo4(newValue);
    } else if (param == Parameter.maxUtilizationRate) {
      _params.maxUtilizationRate = _wadTo4(newValue);
    } else if (param == Parameter.internalLoanInterestRate) {
      // This call changes the interest rate without updating the current loans up to this point
      // So, if interest rate goes from 5% to 6%, this change will be retroactive to the lastUpdate of each
      // loan. Since it's a permissioned call, I'm ok with this. If a caller wants to reduce the impact, it can
      // issue 1 wei repayLoan to each active loan, forcing the update of the scales
      _params.internalLoanInterestRate = _wadTo4(newValue);
    }
    _parameterChanged(
      Governance.GovernanceActions(uint256(Governance.GovernanceActions.setLiquidityRequirement) + uint256(param)),
      newValue
    );
  }

  function setWhitelist(ILPWhitelist lpWhitelist_) external {
    require(
      address(lpWhitelist_) == address(0) || IPolicyPoolComponent(address(lpWhitelist_)).policyPool() == _policyPool,
      "Component not linked to this PolicyPool"
    );
    _params.whitelist = lpWhitelist_;
    _componentChanged(Governance.GovernanceActions.setLPWhitelist, address(lpWhitelist_));
  }

  function whitelist() external view returns (ILPWhitelist) {
    return _params.whitelist;
  }

  /**
   * @dev This empty reserved space is put in place to allow future versions to add new
   * variables without shifting down storage in the inheritance chain.
   * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
   */
  uint256[45] private __gap;
}
