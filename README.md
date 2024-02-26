[![Tests](https://github.com/ensuro/ensuro/actions/workflows/tests.yaml/badge.svg)](https://github.com/ensuro/ensuro/actions/workflows/tests.yaml)
[![cov](https://github.com/ensuro/ensuro/raw/main/badges/coverage.svg)](https://github.com/ensuro/ensuro/actions/workflows/tests.yaml)
[![Build and Push Docker Image to Google Artifact Registry](https://github.com/ensuro/ensuro/actions/workflows/build-base-image.yaml/badge.svg)](https://github.com/ensuro/ensuro/actions/workflows/build-base-image.yaml)
[![release](https://badgen.net/github/release/ensuro/ensuro)](https://github.com/ensuro/ensuro/releases)
[![NPM Package](https://github.com/ensuro/ensuro/actions/workflows/npm.yaml/badge.svg)](https://www.npmjs.com/package/@ensuro/core)

# Ensuro - Decentralized capital for insurance

Ensuro is a decentralized protocol that manages the capital to support insurance products.

It allows liquidity providers (LPs) to deposit capital (using stable coins) that will fulfill solvency capital requirements of underwritten policies. This capital will be deposited in different pools (_eTokens_) that are linked to different risks. The capital will be locked for the duration of policies and will report profits to the LPs in the form of continous interest.

On the policy side, the policies are injected into the protocol by _Risk Modules_. Each risk module represent an Ensuro partner and a specific insurance product and is implemented with a smart contract (inherited from `RiskModule`). Each risk module has two responsabilities: pricing and policy resolution. Also, the RiskModule smart contract stores several parameters of the risk module such as Ensuro and Risk Module fees, capital allocation limits, etc.

Each policy sold and active it's a _risk_ or potential loss, a random variable that goes from 0 (no losses) to the maximum payout defined in the policy. The solvency capital to cover these risks comes from two sources:

- **pure premiums**: the part of the premium that's equal to the estimated mean of the risk random variable (expected losses), paid by the policy holder.
- **scr**: the rest of the solvency capital (unexpected losses), required to be able to cover the risks with a given _confidence level_, is locked from the _eTokens_.

![Architecture Diagram](Architecture.png "Architecture Diagram")

## Contracts

<dl>
<dt>PolicyPool</dt>
<dd>
PolicyPool is the protocol's main contract. It keeps track of active policies and receives spending allowances. It has methods for LP to deposit/withdraw, acting as a gateway. The PolicyPool is connected to a set of eTokens, Premiums Accounts, and RiskModules.
This contract also follows the ERC721 standard, minting an NFT for each policy created. The owner of the NFT is who will receive the payout in case there's any.
</dd>
</dl>

<dl>
<dt>AccessManager</dt>
<dd>This contract the access control permissions for the governance actions.</dd>
</dl>

<dl>
<dt>EToken</dt>
<dd>EToken is an ERC20-compatible contract that counts the capital of each liquidity provider in a given pool. The valuation is one-to-one with the underlying stablecoin. The view `scr()` returns the amount of capital that's locked backing up policies. For this capital locked, the pool receives an interest (see `scrInterestRate()` and `tokenInterestRate()`) that is continuously accrued in the balance of eToken holders.</dd>
</dl>

<dl>
<dt>RiskModule</dt>
<dd>This base contract allows risk partners and customers to interact with the protocol. It needs to be reimplemented for each different product, each time defining the proper policy parameters, price validation, and policy resolution strategy (e.g., using oracles). RiskModule must be called to create a new policy; after validating the price and storing parameters needed for resolution, RiskModule submits the policy to PolicyPool.</dd>
</dl>

<dl>
<dt>PremiumsAccount</dt>
<dd>The risk modules are grouped in premiums accounts that keep track of their policies' pure premiums (active and earned). The responsibility of these contracts is to keep track of the premiums and release the payouts. When premiums are exhausted (losses more than expected), they borrow money from the eTokens to cover the payouts. This money will be repaid when/if later the premiums account has a surplus (losses less than expected).</dd>
</dl>

<dl>
<dt>AssetManager</dt>
<dd>Both _eTokens_ and _PremiumsAccounts_ are _reserves_ because they hold assets. It's possible to assign to each reserve an AssetManager. The AssetManager is a contract that operates in the reserve's context (through delegatecalls) and manages the assets by applying some strategy to invest in other DeFi protocols to generate additional returns.</dd>
</dl>

<dl>
<dt>LPWhitelist</dt>
<dd>This is an optional component. If present it controls which Liquidity Providers can deposit or transfer their <i>eTokens</i>. Each eToken may be or not connected to a whitelist.</dd>
</dl>

<dl>
<dt>Policy</dt>
<dd>Policy is a library with the struct and the calculation of relevant attributes of a policy. It includes the logic around the premium distribution, SCR calculation, shared coverage, and other protocol behaviors.</dd>
</dl>

## Governance

The protocol uses three levels of access control, plus a guardian role. These roles can be assigned at protocol level or specifically for a component. The roles are managed by the AccessManager smart contract.

More info about governance in https://docs.google.com/spreadsheets/d/1LqlogRn8AlnLq1rPTd5UT7CJI3uc31PdBaxj4pX3mtE/edit?usp=sharing

## Upgradability

Ensuro contracts are upgradeable, meaning the code can be changed after deployment. We implement this following the UUPS pattern (https://eips.ethereum.org/EIPS/eip-1822) where the contract used is a proxy that can be redirected to a different implementation.

The main reason to do this is to be able to fix errors and to do minor changes in the protocol.

We will never deploy upgrades to live contracts without prior notice to the users, mainly if it implies a change in the behavior. The permission for executing upgrades will be delegated to two different roles:

- LEVEL1_ROLE: this will be delegated to a Timelock contract that will give enough time to the users to be notified of the imminent upgrade.
- GUARDIAN_ROLE: this will used only for emergency situations to prevent hacks or fix vulnerabilities. It will be delegated to multisigs where one of the signers is a trusted third party.

Have in mind the new versions of the contracts might or might not be covered by the same audit processes as the initial ones. Always check the details of the audit reports.

## Development

For coding the smart contracts the approach we took was prototyping initially in Python (see folder `prototype`), and later we coded in Solidity. The tests run the same test case both on the Python prototype code and the Solidity code. To adapt the Solidity code that is called using [ethproto](https://github.com/gnarvaja/eth-prototype), we have some glue code implemented in `tests/wrappers.py`.

### Without docker

You can also run the development environment without using docker, just Python (>=3.9) and Node v16 are required as pre-requisits.

Initial setup:

```bash
# Setup a virtualenv
python3 -m venv venv
source venv/bin/activate
# Install python dependencies
pip install -r requirements.txt
pip install -r requirements-dev.txt
# Install javascript dependencies
nvm use  # To change to node v16
npm install
```

Then, you can run the tests with:

```bash
# Start a local node
npx hardhat node

# Run python tests
pytest

# Run js tests
npx hardhat test --network localhost
```

### Using docker

The development environment is prepared for running inside a docker container defined in the Dockerfile. Also you can launch the docker environment using [invoke tasks](http://www.pyinvoke.org/), but before you need to run `pip install inv-py-docker-k8s-tasks` to install a package with common tasks for coding inside docker. Then with `inv start-dev` you should be able to launch the docker environment. Then you can run specific tasks:

- `inv test`: runs the test suite
- `inv shell`: opens a shell inside the docker container

Also the docker container is prepared to run [hardhat](https://hardhat.org/). This will be used probably for deployment scripts and perhaps some aditional tests.

## Code Audits

- Audit by [Quantstamp](https://quantstamp.com/) - 2022-09-26 through 2022-10-20: [AuditReport](audits/Quantstamp-Ensuro-Final-Report-2022-11-09.pdf)
- Audit by [SlowMist](https://www.slowmist.com) - 2021-09-29: [AuditReport](audits/SlowMistAuditReport-Ensuro-2021-09-29.pdf)

## Contributing

Thank you for your interest in Ensuro! Head over to our [Contributing Guidelines](CONTRIBUTING.md) for instructions on how to sign our Contributors Agreement and get started with
Ensuro!

Please note we have a [Code of Conduct](CODE_OF_CONDUCT.md), please follow it in all your interactions with the project.

## Authors

- _Guillermo M. Narvaja_

## License

The repository and all contributions are licensed under
[APACHE 2.0](https://www.apache.org/licenses/LICENSE-2.0). Please review our [LICENSE](LICENSE) file.
