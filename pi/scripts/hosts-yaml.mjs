import { readFileSync } from "node:fs";
import { parseDocument, stringify } from "yaml";

try {
  const source = readFileSync(0, "utf8");
  if (process.argv[2] === "decode") {
    const document = parseDocument(source);
    const problem = document.errors[0] ?? document.warnings[0];
    if (problem) throw problem;
    process.stdout.write(JSON.stringify(document.toJS()));
  } else if (process.argv[2] === "encode") {
    process.stdout.write(stringify(JSON.parse(source)));
  } else throw new Error("Expected encode or decode");
} catch (error) {
  console.error("Invalid hosts YAML: " + error.message);
  process.exitCode = 1;
}
