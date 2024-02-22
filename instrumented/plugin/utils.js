const shell = require("shelljs");

const { HARDHAT_NETWORK_RESET_EVENT } = require("hardhat/internal/constants");
const { TASK_NODE_CREATE_SERVER, TASK_NODE_SERVER_CREATED } = require("hardhat/builtin-tasks/task-names");

const nomiclabsUtils = require("solidity-coverage/plugins/resources/nomiclabs.utils");
const utils = require("solidity-coverage/utils");

exports.execAsync = async function execAsync(command, options = {}) {
  return new Promise((resolve, reject) => {
    shell.exec(
      command,
      {
        async: true,
        cwd: options.cwd || process.cwd(),
        stdio: options.stdio || "inherit",
      },
      (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Error code ${code} from python`));
      }
    );
  });
};

exports.setupNode = async function setupNode(env, api, ui) {
  const network = nomiclabsUtils.setupHardhatNetwork(env, api, ui);

  const localhostNetworkURL = new URL(env.config.networks.localhost.url);
  const nodeConfig = { hostname: localhostNetworkURL.hostname, port: parseInt(localhostNetworkURL.port) };

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
