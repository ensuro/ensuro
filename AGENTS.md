# AGENTS.md — Ensuro

Ensuro is a Solidity smart-contract protocol for blockchain-based insurance/reinsurance. Node 22, Python ≥ 3.12, Solidity 0.8.30 (EVM Prague).

---

## Developer setup (without Docker)

```bash
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt -r requirements-dev.txt
nvm use          # switches to Node 22 per .nvmrc
npm install
npx hardhat compile   # must run before any tests; artifacts/ is the output
```

---

## Test suites

There are **two independent test suites** — both must pass.

### Python tests (`tests/`)

Require a live Hardhat node:

```bash
# Terminal 1 – start the node (or use the helper)
npx hardhat node

# Terminal 2
USE_CUSTOM_ERRORS=Y pytest
```

- `USE_CUSTOM_ERRORS=Y` is required to match how CI runs pytest; omitting it may hide failures.
- Each test module is parameterized via `TEST_VARIANTS` (default: `["prototype", "ethereum"]`). The `"prototype"` variant runs against the pure-Python model in `prototype/`; the `"ethereum"` variant runs the same test logic against the compiled Solidity contracts over JSON-RPC. Run a single variant: `TEST_VARIANTS=ethereum pytest`.
- Run a single module: `pytest tests/test_etoken.py`
- `conftest.py` points `CONTRACT_JSON_PATH` at `artifacts/` — compile first or tests will fail silently.

### JS/Hardhat tests (`test/`)

```bash
npx hardhat test
# with gas report:
REPORT_GAS=1 npx hardhat test
```

Run a single file:

```bash
npx hardhat test test/test-etoken.js
```

---

## Lint / format

```bash
npm run solhint          # Solidity linting
npm run prettier         # format contracts/**/*.sol, test/**/*.js, tasks/**/*.js
black .                  # Python (line-length 110)
isort .                  # Python import order
flake8                   # Python lint
```

Pre-commit hooks enforce all of the above plus gitleaks. Install once with `pre-commit install`.

---

## Coverage

Unified coverage (Python + JS tests instrumented together):

```bash
USE_CUSTOM_ERRORS=Y npx hardhat python-coverage
# HTML report: coverage/index.html
# Cobertura XML: coverage/cobertura-coverage.xml
```

---

## Other useful commands

```bash
npx hardhat compile
npx hardhat size-contracts     # check contract sizes (not run on compile by default)
npx hardhat python-coverage    # unified coverage
```

Deploy smoke test (starts its own HH node):

```bash
scripts/deploySmokeTest.sh
```

---

## Architecture notes

- **Access control**: contracts use the *Access Managed Proxy* pattern — no `onlyOwner`/`onlyRole` modifiers in the contracts themselves. Access control is delegated to an `AccessManager` via `AccessManagedProxy`. Some high-frequency methods are declared as *skipped* (bypass the proxy check); the canonical list is in `js/ampConfig.js`.
- **Upgradability**: UUPS proxy pattern throughout.
- **Contracts**: `PolicyPool`, `EToken`, `RiskModule`, `PremiumsAccount`, `Reserve`, `Cooler`, `LPManualWhitelist`, `Policy` (library). Core logic lives directly in `contracts/`.
- **Python prototype**: `prototype/ensuro.py` is a Python model of the protocol used as the reference implementation. Python tests run the same test cases against both the prototype and the compiled Solidity.
- **`tests/wrappers.py` / `prototype/wrappers.py`**: glue code adapting Solidity contract calls to the Python test harness via [ethproto](https://github.com/gnarvaja/eth-prototype).

---

## CI order (tests.yaml)

```
npm ci + pip install
→ npx hardhat compile
→ npx hardhat size-contracts
→ npm run solhint
→ pytest (with USE_CUSTOM_ERRORS=Y, HH node started via scripts/utils.sh startHHNode)
→ scripts/deploySmokeTest.sh
→ scripts/deploySmokeTest-fork.sh  (needs ALCHEMY_URL secret)
→ npx hardhat test (with REPORT_GAS=1)
```

Parallel `coverage` job runs `npx hardhat python-coverage` and publishes Cobertura XML as a PR comment.

---

## Docker (optional)

```bash
pip install inv-py-docker-k8s-tasks
inv start-dev    # launch container (ensuro_devenv)
inv test         # compile + run pytest + JS tests inside container
inv shell        # shell inside container
```
