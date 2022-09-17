const { subtask } = require("hardhat/config");

const {
  TASK_COMPILE_SOLIDITY_GET_COMPILER_INPUT,
  TASK_COMPILE_SOLIDITY_GET_COMPILATION_JOB_FOR_FILE,
  TASK_COMPILE_SOLIDITY_LOG_COMPILATION_ERRORS,
} = require("hardhat/builtin-tasks/task-names");

// Toggled true for `coverage` task only.
let measureCoverage = false;
let instrumentedSources;
let configureYulOptimizer = false;
let optimizerDetails;

module.exports.setInstrumentedSources = function setInstrumentedSources(sources) {
  instrumentedSources = {};
  sources.map((target) => {
    instrumentedSources[target.canonicalPath] = target.source;
  });
};

module.exports.setMeasureCoverage = function setMeasureCoverage(measure) {
  measureCoverage = measure;
};

/*
The following subtasks are copy-pasted verbatim from solidity-coverage.

They are simply adapted to run in a different environment by the code above.

TODO: propose a change in solidity-coverage so their subtasks can be reused directly
*/
subtask(TASK_COMPILE_SOLIDITY_GET_COMPILER_INPUT).setAction(async (_, { config }, runSuper) => {
  const solcInput = await runSuper();
  if (measureCoverage) {
    console.log("MANGLING COMPILER INPUT");
    // The source name here is actually the global name in the solc input,
    // but hardhat uses the fully qualified contract names.
    for (const [sourceName, source] of Object.entries(solcInput.sources)) {
      const absolutePath = path.join(config.paths.root, sourceName);
      // Patch in the instrumented source code.
      if (absolutePath in instrumentedSources) {
        source.content = instrumentedSources[absolutePath];
      }
    }
  }
  return solcInput;
});

// Solidity settings are best set here instead of the TASK_COMPILE_SOLIDITY_GET_COMPILER_INPUT task.
subtask(TASK_COMPILE_SOLIDITY_GET_COMPILATION_JOB_FOR_FILE).setAction(async (_, __, runSuper) => {
  const compilationJob = await runSuper();
  if (measureCoverage && typeof compilationJob === "object") {
    if (compilationJob.solidityConfig.settings === undefined) {
      compilationJob.solidityConfig.settings = {};
    }

    const { settings } = compilationJob.solidityConfig;
    if (settings.metadata === undefined) {
      settings.metadata = {};
    }
    if (settings.optimizer === undefined) {
      settings.optimizer = {};
    }
    // Unset useLiteralContent due to solc metadata size restriction
    settings.metadata.useLiteralContent = false;
    // Override optimizer settings for all compilers
    settings.optimizer.enabled = false;

    // This is fixes a stack too deep bug in ABIEncoderV2
    // Experimental because not sure this works as expected across versions....
    if (configureYulOptimizer) {
      if (optimizerDetails === undefined) {
        settings.optimizer.details = {
          yul: true,
          yulDetails: {
            stackAllocation: true,
          },
        };
        // Other configurations may work as well. This loads custom details from .solcoverjs
      } else {
        settings.optimizer.details = optimizerDetails;
      }
    }
  }
  return compilationJob;
});

// Suppress compilation warnings because injected trace function triggers
// complaint about unused variable
subtask(TASK_COMPILE_SOLIDITY_LOG_COMPILATION_ERRORS).setAction(async (_, __, runSuper) => {
  const defaultWarn = console.warn;

  if (measureCoverage) {
    console.warn = () => {};
  }
  await runSuper();
  console.warn = defaultWarn;
});
