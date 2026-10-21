import { createHash } from "node:crypto";
import { readdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Channel } from "./session-catalog.js";

export const applicationRoot = (): string => fileURLToPath(new URL("../../", import.meta.url));
export const defaultRoot = (channel: Channel): string => join(homedir(), ".local/state/pi-console/service", channel);
export async function serviceBuild(): Promise<string> {
  const root = await realpath(dirname(fileURLToPath(import.meta.url)));
  const hash = createHash("sha256").update(root);
  for (const file of (await readdir(root)).filter((file) => file.endsWith(".js")).sort()) hash.update(file).update(await readFile(join(root, file)));
  return `sha256:${hash.digest("hex")}`;
}
export function requireNode(): void {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || major === 22 && minor < 19) throw new Error("Service/bridge requires Node >=22.19.0");
}
