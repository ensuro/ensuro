# Changes version 3.0

## Upgrade to OpenZeppelin Contracts v5.4 and other technical upgrades

In [PR 204](https://github.com/ensuro/ensuro/pull/204) we upgraded the dependencies from OpenZeppelin Contracts v4.x to
the current major version (5.x). This change also included upgrading the Solidity compiler to one of the latest
versions (0.8.30).

## Remove legacy / migration smart contracts

In [PR 205](https://github.com/ensuro/ensuro/pull/205) we removed some old / deprecated contracts.

## Migration to AccessManagedProxy for access control

This [PR 206](https://github.com/ensuro/ensuro/pull/206) applies a change to all the contracts on how we handle access
control to sensitive methods. Previously, we had access control rules hardcoded in the code by decorating protected
methods with decorators such as onlyRole(LEVEL1_ROLE). In this change, we applied a different approach to the access
control logic, by moving it to the proxy instead of having it in the implementation contracts.

By moving the access control logic to the proxy that delegates this into a configurable AccessManager contract, we have
much more flexibility, and we delay the decisions up to the deployment.

Check [this presentation](https://www.youtube.com/watch?v=DKdwJ9Ap9vM) at DeFi Security Summit 2025 for a
complete explanation of this design pattern.

## Pluggable IAssetManager strategy => ERC4626 yield vault

In this change, implemented in [PR 207](https://github.com/ensuro/ensuro/pull/207), we changed how the delegation to
the asset management contracts is implemented. Previously, we had different implementations that were plugged into the
reserve contracts with strategy contracts that were called with delegatecall. Now, we just invest the funds into an
ERC-4626 compatible vault. The change is mainly a simplification, without affecting the flexibility for defining custom
asset management policies.

## Refactoring of EToken using OZ's ERC20 base contract

In [PR 208](https://github.com/ensuro/ensuro/pull/208) we applied a refactoring to the EToken (liquidity pool) code,
using ERC20 base contract from OpenZeppelin library.

## Migration from WadRayMath to OZ's Math

In [PR 209](https://github.com/ensuro/ensuro/pull/209) we changed the code from using the WadRayMath (library took
from AAVE v2 code) to using the more standard Math library included in OpenZeppelin Contracts library. Besides this
change, this PR also included a refactoring of how we track the accrual of interests coming from the solvency capital
locked (SCR) in the eTokens.

## Remove Pausable base from components

In [PR 210](https://github.com/ensuro/ensuro/pull/210) we removed the inheritance of Pausable on the protocol
components (eTokens, Risk Modules, PremiumsAccounts). This removes the possibility of pausing individual components.
We kept the pause feature on the PolicyPool contract. Also, the component status that is tracked in the PolicyPool
contract allows for disabling a particular component. Finally, the flexible access control implemented on PR 206, also
gives us the flexibility for disabling specific contracts. Overall, this change simplified the code without affecting
our ability to do emergency pauses of given contracts.

## Use Custom Errors instead of string errors

In [PR 211](https://github.com/ensuro/ensuro/pull/211) we changed the code to use custom errors instead of error
messages. This aligns with current best practices in Solidity development.

## Refactoring in RiskModule: extract IUnderwriter

Previously, in Ensuro v2, we had different implementations of the RiskModule component, which is responsible for
pricing and resolving policies. Now (implemented in [PR 212](https://github.com/ensuro/ensuro/pull/212)), we have a
single implementation, and we delegate to an underwriter contract the responsibility related to pricing the policy
from a given input. For now, we have only implementations of this underwriter contract that just receive all the
pricing information from outside, without storing on-chain pricing parameters such as RoCs, MoC, collateralization
ratios, etc.

## Use specific governance events / Governance library removed

In [PR 213](https://github.com/ensuro/ensuro/pull/213) we applied a change in the protocol. Previously, we were
emitting in many cases a generic event (ParameterChanged). Now we are using specific event names for each kind of
change in the configuration.

## EIP-2612 (ERC20 signed approval) + operate on behalf #214

With this change ([PR 214](https://github.com/ensuro/ensuro/pull/214)), we added the possibility of operating with the
protocol using signed approvals of USDC. Also, our eTokens can be transferred with signed approvals. Finally, we added
features to operate on behalf of someone else (depositing into the protocol, minting the tokens for another user, or
withdrawing another user’s eTokens, granted we had the required allowance).

## Flexible Policy Replacements

Up to v2, we had support for policy replacements (changing the values of an active policy), but with very strong
limitations. After [PR 215](https://github.com/ensuro/ensuro/pull/215), we can change almost everything in an active
policy: the exposure, the expiration, the collateralization ratios, the RoCs, the pure premium (only increase), the
CoCs (only increase), and the Ensuro and Partner commissions (only increase).

## Optional cooldown for EToken withdrawals

This change ([PR 216](https://github.com/ensuro/ensuro/pull/216)) gives us the possibility to implement a cooldown
period for withdrawals. This cooldown period might be required in some pools to be able to anticipate the capital
flows, or to avoid someone taking an excessive advantage from information asymmetry.

If a given eToken has a Cooler contract, this contract will define the cooldown period required for withdrawals. In
that case, immediate withdrawals are disabled, and they must be scheduled. When the withdrawals are scheduled, the user
transfers the eTokens and receives an NFT that entitles him to receive up to the withdrawal amount (might be less if
there are losses during the cooldown period) when the cooldown expires.

## Policy Cancellation Feature

This change ([PR 217](https://github.com/ensuro/ensuro/pull/217)) gives us the possibility to cancel active policies,
executing a total or partial refund of the premium (except the Ensuro and partner commissions). When a policy is
cancelled, the exposure and the locked funds back as it were before.

## Full Signed Underwriter + OZ 5.5 + Multicall in PolicyPool

This [PR 218](https://github.com/ensuro/ensuro/pull/218) is a continuation of the change made on
[PR 212](https://github.com/ensuro/ensuro/pull/212) (the refactoring of RiskModule and introduction of IUnderwriter),
where we have an implementation of the underwriter contract that receives the input signed by an authorized account.
This way, we can have different permissions for pricing and for creating the policy.

Besides that, in the same PR we upgraded the OpenZeppelin version from 5.4 to 5.5, to start the version 3 with
the latest released version of OZ contracts.

Finally, we modified the `PolicyPool` contract, adding support for the [multicall
method](https://docs.openzeppelin.com/contracts/5.x/api/utils#Multicall) that allows to call several methods
at once. With this change we removed the `expirePolicies` method, that can be replaced with a single
`multicall()`.

Finally, in the `RiskModule` contract we added a `newPolicies` method that allows to create several policies
for the same owner in a single call. This will save gas for many microinsurance use cases.
