const { findAll, isNodeType } = require("solidity-ast/utils");

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

function hasEvents({ item }) {
  return [...findAll("EventDefinition", item)].length > 0;
}

function hasTypes({ item }) {
  return [...findAll(["StructDefinition", "EnumDefinition", "UserDefinedValueTypeDefinition"], item)].length > 0;
}

function hasVariables({ item }) {
  return item.nodeType === "ContractDefinition"
    ? item.nodes.filter(isNodeType("VariableDeclaration")).filter((v) => v.stateVariable && v.visibility !== "private")
    : false;
}

function hasErrors({ item }) {
  return [...findAll("ErrorDefinition", item)].length > 0;
}

function hasPublicFunctions({ item }) {
  return (
    [...findAll("FunctionDefinition", item)].filter((f) => f.visibility !== "private" && f.visibility !== "internal")
      .length > 0
  );
}

function hasPrivateFunctions({ item }) {
  return (
    [...findAll("FunctionDefinition", item)].filter((f) => f.visibility === "private" || f.visibility === "internal")
      .length > 0
  );
}

module.exports = {
  hasVariables,
  hasTypes,
  hasErrors,
  hasEvents,
  hasPrivateFunctions,
  hasPublicFunctions,
  publicFunctions,
  privateFunctions,
};
