# Instrumented contracts for coverage measurement

This directory is a dummy brownie project to compile and test contracts instrumented by solidity-coverage.

The whole flow is handled by a hardhat plugin.

## Usage

Add the plugin to your `hardhat.config.js`:

```
require("./instrumented/plugin/hardhat.plugin");
```

Then from the repository root run:

```
npx hardhat brownie-coverage
```

It will output test run details and the coverage report on the console.

It will also create an awesome html report on `coverage/index.html`.

# TODO

Although this works, a lot could be improved. Here is a list of possible improvements in no particular order.

## Generate brownie config on the fly

Instead of having a static config file that duplicates the main one and changes the solc config, we could generate it on the fly and avoid duplication.

## Eliminate the need for a whole separate project

Dependency management for the instrumented project is quite hacky.

Adding a flag to indicate an alternative config file for brownie would eliminate the need for all that.

Fixing [brownie#1602](https://github.com/eth-brownie/brownie/issues/1602) may also be a good solution to this problem.

## Implement a way for pytest/brownie to know they're running under coverage evaluation

This is not strictly required right now, since all tests complete successfully under coverage evaluation.

Nevertheless, it might be useful for some cases.

An ideal solution would require no changes in brownie or the tests, or at most a new fixture / decorator.
