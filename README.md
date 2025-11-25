[![Tests](https://github.com/ensuro/ensuro/actions/workflows/tests.yaml/badge.svg)](https://github.com/ensuro/ensuro/actions/workflows/tests.yaml)
[![cov](https://raw.githubusercontent.com/ensuro/ensuro/_xml_coverage_reports/data/main/badge.svg)](https://github.com/ensuro/ensuro/actions/workflows/tests.yaml)
[![Build](https://github.com/ensuro/ensuro/actions/workflows/build-base-image.yaml/badge.svg)](https://github.com/ensuro/ensuro/actions/workflows/build-base-image.yaml)
[![release](https://badgen.net/github/release/ensuro/ensuro)](https://github.com/ensuro/ensuro/releases)
[![NPM Package](https://github.com/ensuro/ensuro/actions/workflows/npm.yaml/badge.svg)](https://www.npmjs.com/package/@ensuro/core)

# Ensuro - Blockchain-based, licensed, reinsurance

Ensuro is a blockchain-based protocol that manages the capital to support insurance products.

It allows liquidity providers (LPs) to deposit capital (using stable coins) that will fulfill solvency capital
requirements of underwritten policies. This capital will be deposited in different pools (_eTokens_) that are linked to
different risks. The capital will be locked for the duration of policies and will report profits to the LPs in the form
of continous interest.

On the policy side, the policies are injected into the protocol by _Risk Modules_. Each Ensuro partner is represented
by a _Premiums Account_ contract, that accumulates the pure premium of that partner. Connected to a given
_Premiums Account_ you can have several risk modules, each representing different products or lines or business.

Each risk module has three responsabilities: policy injection, pricing and policy resolution. The pricing
responsibility, that includes not only pricing new policies but also validating and pricing replacements and
cancellations, is delegated to an _Underwriter_ contract that is plugged into the RiskModule.

Each policy sold and active is a _risk_ or potential loss, a random variable that goes from 0 (no losses) to the
maximum payout defined in the policy. The solvency capital to cover these risks comes from two sources:

- **pure premiums**: the part of the premium that's equal to the estimated mean of the risk random variable (expected
  losses), paid by the policy holder.
- **scr**: the rest of the solvency capital (unexpected losses), required to be able to cover the risks with a given
  _confidence level_, is locked from the _eTokens_.

![Architecture Diagram](Architecture.png "Architecture Diagram")

## Contracts

<dl>
<dt>PolicyPool</dt>
<dd>
    PolicyPool is the protocol's main contract. It keeps track of active policies and receives spending allowances. It
    has methods for LP to deposit/withdraw, acting as a gateway. The PolicyPool is connected to a set of eTokens,
    Premiums Accounts, and RiskModules, keeping the registry of which are in the protocol.

    It also tracks the active exposure and the exposure limit for each RiskModule.

    This contract also follows the ERC721 standard, minting an NFT for each policy created. The owner of the NFT is who
    will receive the payout in case there's any.

</dd>
</dl>

<dl>
<dt>EToken</dt>
<dd>
    EToken is an ERC20-compatible contract that counts the capital of each liquidity provider in a given pool. The
    valuation is one-to-one with the underlying stablecoin (rebasing token). The view `scr()` returns the amount of
    capital that's locked backing up policies. For this capital locked, the pool receives an interest (see
    `scrInterestRate()` and `tokenInterestRate()`) that is continuously accrued in the balance of eToken holders.

    It can have an optional _Cooler_ contract that will handle the cooldown period for withdrawals. If no
    _Cooler_ is defined, the withdrawals are immediate (provided the `utilizationRate()` after the withdrawal
    is under 100%).

</dd>
</dl>

<dl>
<dt>RiskModule</dt>
<dd>
    This contract allows risk partners and customers to interact with the protocol. The specific logic regarding
    pricing is delegated to the _Underwriter_ contract. RiskModule must be called to create a new policy; after
    calling the _Underwriter_ to validate and build the price, it builds the Policy object and submits it to the
    PolicyPool.
</dd>
</dl>

<dl>
<dt>PremiumsAccount</dt>
<dd>
    The risk modules are grouped in premiums accounts that keep track of their policies' pure premiums (active and
    earned). The responsibility of these contracts is to keep track of the premiums and release the payouts. When
    premiums are exhausted (losses more than expected), they borrow money from the eTokens to cover the payouts. This
    money will be repaid when/if later the premiums account has a surplus (losses less than expected).
</dd>
</dl>

<dl>
<dt>Reserve</dt>
<dd>
    Both _eTokens_ and _PremiumsAccounts_ are _reserves_ because they hold assets. It's possible to assign to each
    reserve a _yield vault_. This _yield vault_ is an ERC-4626 contract that will invest the delegated funds to
    generate additional returns by investing in other DeFi protocols.
</dd>
</dl>

<dl>
<dt>LPWhitelist</dt>
<dd>
    This is an optional component. If present it controls which Liquidity Providers can deposit or transfer their
    <i>eTokens</i>. Each eToken may be or not connected to a whitelist.
</dd>
</dl>

<dl>
<dt>Cooler</dt>
<dd>
    This is an optional component. If present it controls the cooldown period required to withdraw funds from a given
    _eToken_. Each eToken may be or not connected to a cooler.
</dd>
</dl>

<dl>
<dt>Policy</dt>
<dd>
    Policy is a library with the struct and the calculation of relevant attributes of a policy. It includes the logic
    around the premium distribution, SCR calculation, shared coverage, and other protocol behaviors.
</dd>
</dl>

## Access Control / Governance

The protocol uses the _Access Managed Proxy_ design pattern. Under this design pattern, the access control
logic of permissioned methods is not defined in the code with modifiers (like `onlyOwner` or `onlyRole`). Instead, the
contracts are expected to be deployed behind an[AccessManagedProxy](https://github.com/ensuro/access-managed-proxy)
that will delegate the access control configuration to an
[AccessManager](https://docs.openzeppelin.com/contracts/5.x/api/access#AccessManager) contract. For
gas usage reasons, we might have _skipped methods_ that are defined at deployment time, that don't call the
_AccessManager_ contract and just pass thru the call as a standard proxy. In `js/ampConfig.js` there's the
recommended setup for these skipped methods, but make sure to verify against the actual deployed contracts.

Check [this presentation](https://www.youtube.com/watch?v=DKdwJ9Ap9vM) at DeFi Security Summit 2025 for a
complete explanation of this design pattern.

Regarding the specific access control configuration, check [our
docs](https://docs.ensuro.co/ensuro-docs/deployments) for the actual manifest of access control rules.

## Upgradability

Ensuro contracts are upgradeable, meaning the code can be changed after deployment. We implement this following the
[UUPS pattern](https://eips.ethereum.org/EIPS/eip-1822) where the contract used is a proxy that can be redirected to a
different implementation.

The main reason to do this is to be able to fix errors and to do minor changes in the protocol.

We will never deploy upgrades to live contracts without prior notice to the users, mainly if it implies a change in the
behavior. The permission for executing upgrades will be always subject to timelocks and delegated either to
Ensuro's board and/or to a Security Council.

Have in mind the new versions of the contracts might or might not be covered by the same audit processes as the initial
ones. See our [audit applicability matrix](https://docs.ensuro.co/ensuro-docs/deployments/audits) to check which audit
applies to the currently deployed contracts.

## Development

For coding the smart contracts the approach we took was prototyping initially in Python (see folder `prototype`), and
later we coded in Solidity. The tests run the same test case both on the Python prototype code and the Solidity code.
To adapt the Solidity code that is called using [ethproto](https://github.com/gnarvaja/eth-prototype), we have some
glue code implemented in `tests/wrappers.py`.

Not all the core logic is implemented in the Python prototype, but most of it.

### Without docker

You can also run the development environment without using docker, just Python (>=3.12) and Node v22 are required as
pre-requisits.

Initial setup:

```bash
# Setup a virtualenv
python3 -m venv venv
source venv/bin/activate
# Install python dependencies
pip install -r requirements.txt
pip install -r requirements-dev.txt
# Install javascript dependencies
nvm use  # To change to node v22
npm install
```

Then, you can run the tests with:

```bash
# Start a local node
npx hardhat node

# Run python tests
pytest

# Run js tests
npx hardhat test
```

### Using docker

The development environment is prepared for running inside a docker container defined in the Dockerfile. Also you can
launch the docker environment using [invoke tasks](http://www.pyinvoke.org/), but before you need to run
`pip install inv-py-docker-k8s-tasks` to install a package with common tasks for coding inside docker. Then with
`inv start-dev` you should be able to launch the docker environment. Then you can run specific tasks:

- `inv test`: runs the test suite
- `inv shell`: opens a shell inside the docker container

Also the docker container is prepared to run [hardhat](https://hardhat.org/). This will be used probably for deployment
scripts and perhaps some aditional tests.

## Code Audits

- Audit by [Quantstamp](https://quantstamp.com/) - 2022-09-26 through 2022-10-20: [AuditReport](audits/Quantstamp-Ensuro-Final-Report-2022-11-09.pdf)
- Audit by [SlowMist](https://www.slowmist.com) - 2021-09-29: [AuditReport](audits/SlowMistAuditReport-Ensuro-2021-09-29.pdf)
- Process Quality Review by [DefiSafety](https://www.defisafety.com/) - 2024-03-18: [Process Quality Review](audits/DefiSafety.Process_Quality_Review.Ensuro.pdf)

[![DeFiSafety Badge](audits/DefiSafety-93-badge.png)](https://www.defisafety.com/app/pqrs/594)

## Change log

We don't have a change log file, but the best source for the log of changes is the [Releases
Page](https://github.com/ensuro/ensuro/releases). Besides that, check [Changes v3](CHANGES_V3.md) for an
outline of the main changes done from version 2.x to version 3.0.

## Contributing

Thank you for your interest in Ensuro! Head over to our [Contributing Guidelines](CONTRIBUTING.md) for instructions on
how to sign our Contributors Agreement and get started with Ensuro!

Please note we have a [Code of Conduct](CODE_OF_CONDUCT.md), please follow it in all your interactions with the
project.

## Authors

- _Guillermo M. Narvaja_

## License

The repository and all contributions are licensed under
[APACHE 2.0](https://www.apache.org/licenses/LICENSE-2.0). Please review our [LICENSE](LICENSE) file.
