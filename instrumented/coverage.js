const path = require("path");
const API = require("solidity-coverage/lib/api");
const utils = require("solidity-coverage/utils");
const shell = require("shelljs");
const client = require("ganache-cli");

const COVERAGE_PROJECT_DIR = "instrumented";

const config = {
  workingDir: process.cwd(),
  contractsDir: path.join(process.cwd(), "contracts"),
  instrumentedDir: path.join(process.cwd(), COVERAGE_PROJECT_DIR),
  client: client,
  port: 8545,
  hacks: {
    // TODO: probably should get this from brownie-config
    copyDependencies: ["@openzeppelin", "@uniswap", "@chainlink"],
  },
};

let exitCode = 0;

async function instrumentAndTest() {
  const api = new API(config);

  const { targets } = utils.assembleFiles(config);

  const instrumented = api.instrument(targets);

  setupDirectories(config);

  utils.save(instrumented, config.contractsDir, path.join(config.instrumentedDir, "contracts"));

  await api.ganache();

  try {
    const testRun = new Promise((resolve, reject) => {
      const child = shell.exec(
        "brownie test",
        { async: true, cwd: path.join(process.cwd(), COVERAGE_PROJECT_DIR), stdio: "inherit" },
        (code) => {
          exitCode = code;
          if (code === 0) resolve();
          else reject(`Error code ${code} from brownie`);
        }
      );
    });
    await testRun;

    await api.report();
  } finally {
    api.finish();
  }
}

function setupDirectories(config) {
  // Ensure no old contracts left remaining
  shell.rm("-rf", path.join(config.instrumentedDir, "contracts"));

  // Ensure no old deps left remaining
  shell.rm("-rf", path.join(config.instrumentedDir, "node_modules"));

  shell.mkdir(path.join(config.instrumentedDir, "node_modules"));
  if (config.hacks?.copyDependencies) {
    config.hacks.copyDependencies.map((dependency) => {
      shell.cp(
        "-R",
        path.join(config.workingDir, "node_modules", dependency),
        path.join(config.instrumentedDir, "node_modules")
      );
    });
  }
}

instrumentAndTest().then(() => {
  process.exit(exitCode);
});
