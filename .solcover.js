module.exports = {
  //   workingDir: process.cwd(),
  //   contractsDir: path.join(process.cwd(), "contracts"),
  //   instrumentedDir: path.join(process.cwd(), "instrumented"),
  //   client: client,
  port: 8545,
  skipFiles: ["dependencies/", "mocks/", "migration/"],
  mocha: {
    grep: "@skip-on-coverage", // Find everything with this tag
    invert: true, // Run the grep's inverse set.
  },
  //   logger: console,
};
