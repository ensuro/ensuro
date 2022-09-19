const path = require("path");
const PluginUI = require("solidity-coverage/plugins/resources/nomiclabs.ui");

const { task, types } = require("hardhat/config");
const { HardhatPluginError } = require("hardhat/plugins");
const { TASK_TEST, TASK_COMPILE } = require("hardhat/builtin-tasks/task-names");
const { setInstrumentedSources, setMeasureCoverage } = require("./solcov");

// UI for the task flags...
const ui = new PluginUI();

task("brownie-coverage", "Generates a code coverage report for all tests, including brownie's").setAction(
  async function (args, env) {
    const { execAsync, setupDirectories, setupNode } = require("./utils");
    const API = require("solidity-coverage/lib/api");
    const utils = require("solidity-coverage/utils");
    const nomiclabsUtils = require("solidity-coverage/plugins/resources/nomiclabs.utils");

    let error;

    const config = nomiclabsUtils.normalizeConfig(env.config, args);

    setMeasureCoverage(true);

    const api = new API(utils.loadSolcoverJS(config));

    const { targets, skipped } = utils.assembleFiles(config, api.skipFiles);

    // Instrument
    const instrumented = api.instrument(targets);
    setInstrumentedSources(instrumented);

    utils.reportSkipped(config, skipped);

    // Compile
    ui.report("compilation", []);
    await env.run(TASK_COMPILE);

    // Setup instrumented brownie project
    setupDirectories(env.config.brownieCoverage);
    utils.save(
      [...instrumented, ...skipped],
      config.contractsDir,
      path.join(env.config.brownieCoverage.instrumentedDir, "contracts")
    );

    // Setup hardhat node
    setupNode(env, api, ui);

    // Run brownie tests
    try {
      await execAsync("brownie test --network hardhat", {
        cwd: env.config.brownieCoverage.instrumentedDir,
      });
    } catch (e) {
      error = e;
    }

    // Run hardhat tests
    try {
      await env.run(TASK_TEST, { testFiles: [] });
    } catch (e) {
      error = e;
    }

    // Report
    await api.report();

    // Finish
    await api.finish();

    if (error !== undefined) throw new HardhatPluginError(error);
  }
);
