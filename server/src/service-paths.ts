import { createHash } from "node:crypto";
import { readdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Channel } from "./session-catalog.js";

export const endpoint = (root: string): string => join(root, "service.sock");
export const applicationRoot = (): string => fileURLToPath(new URL("../../", import.meta.url));
// Service profiles are HOME-based, independent of XDG_STATE_HOME; --root is explicit.
export const defaultRoot = (channel: Channel): string => join(homedir(), ".local/state/pi-console/service", channel);
export async function serviceBuild(appRoot = applicationRoot()): Promise<string> {
  const root = await realpath(join(appRoot, "server/dist"));
  const hash = createHash("sha256").update(root);
  for (const file of (await readdir(root)).filter((file) => file.endsWith(".js")).sort()) hash.update(file).update(await readFile(join(root, file)));
  return `sha256:${hash.digest("hex")}`;
}
/** Installed dev snapshots share management ownership only with their source checkout. */
export async function devCheckout(appRoot: string): Promise<string> {
  let marker: string;
  try { marker = await readFile(join(appRoot, ".pi-console-install"), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return appRoot;
    throw error;
  }
  const fields = new Map(marker.trimEnd().split("\n").map((line) => {
    const index = line.indexOf("=");
    return [line.slice(0, index), line.slice(index + 1)];
  }));
  const checkout = fields.get("checkout");
  if (fields.get("channel") !== "dev" || !checkout || !isAbsolute(checkout)) return appRoot;
  return checkout;
}
/** Installed snapshots use a stable selection path; live owners retain resolved roots. */
export async function selectedApplication(appRoot: string): Promise<string> {
  const root = await realpath(appRoot);
  if (dirname(root).endsWith("/versions")) {
    const selected = join(dirname(dirname(root)), "current");
    // Refuse a selection link outside this installation.
    const target = await realpath(selected);
    if (dirname(target) !== dirname(root)) throw new Error("Selected runtime is outside its installation");
    return selected;
  }
  return root;
}
export async function managementIdentity(appRoot: string, channel: Channel): Promise<string> {
  const root = await realpath(appRoot);
  let marker: string | undefined;
  try { marker = await readFile(join(root, ".pi-console-install"), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const markerChannel = marker?.match(/^channel=(.+)$/m)?.[1] ?? "dev";
  if (markerChannel !== channel) throw new Error(`This ${markerChannel} runtime cannot administer the ${channel} channel`);
  return channel === "dev" ? `dev:${await devCheckout(root)}` : `stable:${dirname(root).endsWith("/versions") ? dirname(dirname(root)) : root}`;
}
export function requireNode(): void {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || major === 22 && minor < 19) throw new Error("Service/bridge requires Node >=22.19.0");
}
