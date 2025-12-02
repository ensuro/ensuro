const { findAll } = require("solidity-ast/utils");

function publicFunctions({ item }) {
  return [...findAll("FunctionDefinition", item)].filter(
    (f) => f.visibility !== "private" && f.visibility !== "internal"
  );
}

function privateFunctions({ item }) {
  return [...findAll("FunctionDefinition", item)].filter(
    (f) => f.visibility === "private" || f.visibility === "internal"
  );
}

module.exports = {
  publicFunctions,
  privateFunctions,
};
