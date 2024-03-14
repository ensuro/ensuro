const PluginUI = require("solidity-coverage/plugins/resources/nomiclabs.ui");

const { task } = require("hardhat/config");
const { HardhatPluginError } = require("hardhat/plugins");
const { TASK_TEST, TASK_COMPILE } = require("hardhat/builtin-tasks/task-names");
const { setInstrumentedSources, setMeasureCoverage } = require("./solcov");

// UI for the task flags...
const ui = new PluginUI();

task("python-coverage", "Generates a code coverage report for all tests, including python's").setAction(async function (
  args,
  env
) {
  // eslint-disable-next-line global-require
  const { execAsync, setupNode } = require("./utils");
  // eslint-disable-next-line global-require
  const API = require("solidity-coverage/lib/api");
  // eslint-disable-next-line global-require
  const utils = require("solidity-coverage/utils");
  // eslint-disable-next-line global-require
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

  // Setup hardhat node
  setupNode(env, api, ui);

  // Run python tests
  try {
    await execAsync("pytest");
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
});
