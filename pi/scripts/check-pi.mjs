import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export function checkPi(binary, environment = process.env) {
  let version;
  try {
    version = execFileSync(binary, ["--version"], {
      env: environment, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new Error("Pi >=1.3.0 is required to run locally. Install Pi and make sure pi is available on PATH. Could not run: " + binary);
  }
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match || Number(match[1]) < 1 || Number(match[1]) === 1 && Number(match[2]) < 3) {
    throw new Error("Pi >=1.3.0 is required to run locally; found " + version + ". Upgrade Pi and retry.");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { checkPi(process.argv[2] || "pi"); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
