# Instrumented contracts for coverage measurement

This directory holds a hardhat plugin to get a unified coverage report for smart contracts by running both hardhat (js) and ethproto (python) tests.

It uses `solidity-coverage` to instrument the smart contracts.

## Usage

Add the plugin to your `hardhat.config.js`:

```
require("./instrumented/plugin/hardhat.plugin");
```

Then from the repository root run:

```
npx hardhat python-coverage
```

It will output test run details and the coverage report on the console.

It will also create an awesome html report on `coverage/index.html`.

# TODO

## Implement a way for pytest to know it's running under coverage evaluation

This is not strictly required right now, since all tests complete successfully under coverage evaluation.

Nevertheless, it might be useful for some cases.

An ideal solution would require no changes in the tests, or at most a new fixture / decorator.
