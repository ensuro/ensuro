function formatThrows(throws) {
  const lines = throws.split("\n");
  let ret = "<dl>\n";
  for (const line of lines) {
    if (line.replaceAll(" ", "") === "") continue;
    const errorClass = line.split(" ")[0];
    const rest = line.substring(errorClass.length + 1);
    ret += `<dt>${errorClass}</dt>\n<dd>${rest}</dd>\n`;
  }
  ret += "</dl>\n";
  return ret;
}

function formatEmits(emits) {
  const lines = emits.split("\n");
  let ret = "<dl>\n";
  for (const line of lines) {
    if (line.replaceAll(" ", "") === "") continue;
    const errorClass = line.split(" ")[0];
    const rest = line.substring(errorClass.length + 1);
    ret += `<dt>${errorClass}</dt>\n<dd>${rest}</dd>\n`;
  }
  ret += "</dl>\n";
  return ret;
}

function formatPreConditions(pre) {
  const lines = pre.split("\n");
  let ret = "";
  for (const line of lines) {
    if (line.replaceAll(" ", "") === "") continue;
    ret += `- ${line}\n`;
  }
  return ret;
}

module.exports = {
  formatPreConditions,
  formatEmits,
  formatThrows,
};
