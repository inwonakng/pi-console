import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { checkPi } from "../../pi/scripts/check-pi.mjs";
import { LocalClient } from "./local-client.js";
import { object } from "./pi-records.js";
import { managementIdentity } from "./service-paths.js";
import { listenerPort } from "./remote-transport.js";
import { managementLock, ServiceSupervisor } from "./service-supervisor.js";
import type { HostOwnerOptions } from "./host-owner.js";

export type ManagementAction = "start" | "stop" | "restart" | "enable" | "disable";
/** Shared CLI/frontend lifecycle path. Never reconciles or removes retained claims. */
export async function manageService(action: ManagementAction, options: HostOwnerOptions & { root: string }, config: {
  force: boolean; port?: number; supervisorDirectory?: string; path?: string; expectedEpoch?: string;
}): Promise<{ hello?: Record<string, unknown>; alreadyRunning?: boolean; startup?: Record<string, unknown>; message?: string }> {
  const { root, channel, binary } = options;
  const { force, supervisorDirectory, path, expectedEpoch } = config;
  const explicitPort = config.port !== undefined;
  const port = listenerPort(config.port, channel);
  const extraArgs: string[] = [];
  if (explicitPort) extraArgs.push("--port", String(port));
  if (options.provider) extraArgs.push("--provider", options.provider);
  if (options.model) extraArgs.push("--model", options.model);
  const assertManagementOwner = async (hello: Record<string, unknown>): Promise<void> => {
    const selected = await managementIdentity(options.appRoot, channel);
    const running = typeof hello.appRoot === "string" ? await managementIdentity(hello.appRoot, channel) : undefined;
    if (running !== selected) throw new Error(`Profile belongs to another installation/checkout (${running}); refusing management from ${selected}. Use a separate --root or its launcher. Explicit compatible frontend attachment remains allowed.`);
  };
  const connect = async (allowDisconnect = false): Promise<Awaited<ReturnType<typeof LocalClient.open>> | undefined> => {
    try { return await LocalClient.open(root, channel); }
    catch (error) {
      const code = String((error as NodeJS.ErrnoException).code);
      if (["ENOENT", "ECONNREFUSED"].includes(code) || allowDisconnect && ["service_disconnected", "ECONNRESET", "EPIPE"].includes(code)) return;
      throw error;
    }
  };
  const requireNoClaim = async (): Promise<void> => {
    try { await lstat(join(root, "owner.lock")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    throw new Error("Service lock remains without a reachable service. Inspect startup/cleanup and explicitly reconcile if appropriate; no supervisor teardown or automatic recovery occurred.");
  };
  const privateLog = async () => {
    const file = await open(join(root, "service.log"), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || stat.mode & 0o077) {
      await file.close(); throw new Error("service.log must be a private same-user regular file (0600)");
    }
    return file;
  };
  await managementIdentity(options.appRoot, channel);
  const unlock = await managementLock(root);
  try {
    let supervisor = await ServiceSupervisor.load(root, channel, options.appRoot, supervisorDirectory);
    if (supervisor) await supervisor.loaded();
    const existing = await connect();
    if (expectedEpoch && (!existing || existing.hello.serviceEpoch !== expectedEpoch)) {
      existing?.client.close();
      throw new Error("Service instance changed; restart was not sent");
    }
    let startupExit: string | undefined;
    if (existing) {
      try {
        await assertManagementOwner(existing.hello);
        if (existing.hello.stopping) throw new Error("Service is stopping; wait for closure and retry explicitly");
        if (action === "restart" && !supervisor && !explicitPort && object(existing.hello.network)
          && typeof existing.hello.network.port === "number") extraArgs.push("--port", String(listenerPort(existing.hello.network.port)));
      }
      catch (error) { existing.client.close(); throw error; }
    }
    // Check start configuration before stopping a healthy owner.
    if ((action === "enable" || action === "restart" || action === "start" && !existing) && !supervisor) {
      try {
        if (!binary || !isAbsolute(binary)) throw new Error("Pi >=1.3.0 is required to start a local server. Install Pi and make sure pi is available on PATH.");
        checkPi(binary);
      } catch (error) { existing?.client.close(); throw error; }
    }
    // A retained claim is ownership even when no endpoint is reachable. Fence
    // registration as well as launch; never let another checkout claim startup.
    if (action === "enable" && !existing) await requireNoClaim();
    if (action === "enable" && !supervisor) {
      existing?.client.close();
      await (await privateLog()).close();
      supervisor = await ServiceSupervisor.create({ ...options, binary: binary!, directory: supervisorDirectory, path, extraArgs });
      await supervisor.enable(!existing);
    } else if (action === "enable") {
      existing?.client.close();
      if (!existing) await supervisor!.configurePort(explicitPort ? port : undefined);
      await supervisor!.enable(!existing);
    } else if (action === "stop" || action === "restart" || action === "disable") {
      if (existing) {
        try { await existing.client.request("service.stop", { serviceEpoch: existing.hello.serviceEpoch, force }); }
        finally { existing.client.close(); }
        // Do not mistake the old listener for the replacement during restart.
        let closed = false;
        for (let n = 0; n < 600; n++) {
          let view: Awaited<ReturnType<typeof connect>>;
          try { view = await connect(); }
          catch (error) {
            if (!["service_disconnected", "ECONNRESET", "EPIPE"].includes(String((error as NodeJS.ErrnoException).code))) throw error;
            await delay(100); continue;
          }
          if (!view) { closed = true; break; }
          view.client.close();
          if (view.hello.serviceEpoch !== existing.hello.serviceEpoch) throw new Error("Service instance changed during shutdown; refusing further management");
          await delay(100);
        }
        if (!closed) throw new Error("Old service endpoint remains; refusing supervisor teardown/replacement");
        await supervisor?.waitStopped();
      } else await supervisor?.assertStopped();
      await requireNoClaim();
      if (action === "disable") await supervisor?.disable();
      if (action !== "restart") {
        const message = action === "disable" ? "Server shut down successfully; startup disabled."
          : existing ? "Server shut down successfully." : "Server is already stopped.";
        return { message };
      }
    } else if (existing) {
      existing.client.close();
      return { hello: existing.hello, alreadyRunning: true };
    }
    if (action !== "enable") {
      await requireNoClaim();
      if (supervisor) {
        await (await privateLog()).close();
        await supervisor.configurePort(explicitPort ? port : undefined);
        await supervisor.start();
      }
      else {
        const log = await privateLog();
        try {
          const child = spawn(process.execPath, [join(options.appRoot, "server/dist/cli.js"), "run", "--channel", channel, "--root", root, "--app-root", options.appRoot, ...extraArgs],
            { detached: true, cwd: options.appRoot, stdio: ["ignore", log.fd, log.fd], env: { ...process.env, PI_BINARY: binary! } });
          child.once("exit", (code, signal) => { startupExit = `code ${code}, signal ${signal}`; });
          await new Promise<void>((done, fail) => { child.once("spawn", done); child.once("error", fail); });
          child.unref();
        } finally { await log.close(); }
      }
    }
    for (let n = 0; n < 600; n++) {
      if (startupExit) throw new Error(`Service exited during startup (${startupExit}); inspect ${join(root, "service.log")}`);
      const view = await connect(true);
      if (view) {
        view.client.close(); await assertManagementOwner(view.hello);
        if (view.hello.stopping) throw new Error("Discovered service is stopping; no replacement started");
        if (expectedEpoch && view.hello.serviceEpoch === expectedEpoch) throw new Error("Old service instance is still running");
        return { hello: view.hello, alreadyRunning: action === "enable" && !!existing,
          startup: action === "enable" ? await supervisor!.status() : undefined };
      }
      await delay(100);
    }
    throw new Error(`Service did not become ready; inspect ${join(root, "service.log")}. Existing claims require explicit reconcile, never automatic removal.`);
  } finally { await unlock(); }
}
