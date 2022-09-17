const path = require("path");
const shell = require("shelljs");

const { HARDHAT_NETWORK_RESET_EVENT } = require("hardhat/internal/constants");
const { TASK_NODE_CREATE_SERVER, TASK_NODE_SERVER_CREATED } = require("hardhat/builtin-tasks/task-names");

const nomiclabsUtils = require("solidity-coverage/plugins/resources/nomiclabs.utils");
const utils = require("solidity-coverage/utils");

exports.setupDirectories = function setupDirectories(config) {
  // Ensure no old contracts left remaining
  shell.rm("-rf", path.join(config.instrumentedDir, "contracts"));

  // Ensure no old deps left remaining
  shell.rm("-rf", path.join(config.instrumentedDir, "node_modules"));

  // Cleanup previous builds
  shell.rm("-rf", path.join(config.instrumentedDir, "build"));

  shell.mkdir(path.join(config.instrumentedDir, "node_modules"));
  if (config.copyDependencies) {
    config.copyDependencies.map((dependency) => {
      shell.cp(
        "-R",
        path.join(config.workingDir, "node_modules", dependency),
        path.join(config.instrumentedDir, "node_modules")
      );
    });
  }
};

exports.execAsync = async function execAsync(command, options = {}) {
  return new Promise((resolve, reject) => {
    const child = shell.exec(
      command,
      {
        async: true,
        cwd: options.cwd || process.cwd(),
        stdio: options.stdio || "inherit",
      },
      (code) => {
        exitCode = code;
        if (code === 0) resolve();
        else reject(`Error code ${code} from brownie`);
      }
    );
  });
};

exports.setupNode = async function setupNode(env, api, ui) {
  const network = nomiclabsUtils.setupHardhatNetwork(env, api, ui);

  const nodeConfig = env.config.brownieCoverage.nodeConfig;

  const server = await env.run(TASK_NODE_CREATE_SERVER, {
    ...nodeConfig,
    provider: network.provider,
  });
  await env.run(TASK_NODE_SERVER_CREATED, {
    ...nodeConfig,
    provider: network.provider,
    server,
  });

  const { port: actualPort, address } = await server.listen();

  const accounts = await utils.getAccountsHardhat(network.provider);
  const nodeInfo = await utils.getNodeInfoHardhat(network.provider);

  env.network.provider.on(HARDHAT_NETWORK_RESET_EVENT, () => {
    api.attachToHardhatVM(env.network.provider);
  });

  api.attachToHardhatVM(network.provider);

  nomiclabsUtils.setNetworkFrom(network.config, accounts);

  ui.report("hardhat-network", [nodeInfo.split("/")[1], env.network.name]);

  return { actualPort, address };
};
