import { execFileSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readlinkSync, rmSync } from "node:fs";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { beginEpoch, managedSpawn, managedStarted, managedResult, stopManaged } from "./managed-process.mjs";

const script = fileURLToPath(import.meta.url);

/** Owns only networking. Each workload still gets its own bwrap/seccomp sandbox. */
export class LinuxSessionNetwork {
  constructor(child, done, registryRoot) {
    this.child = child;
    this.done = done;
    this.registryRoot = registryRoot;
    this.fds = [];
    this.ended = false;
    void done.then(() => { this.ended = true; });
  }

  static async start(httpSocketPath, socksSocketPath, env = process.env) {
    if (!httpSocketPath || !socksSocketPath) throw new Error("Linux session network requires initialized proxy bridges");
    let registryRoot;
    env = { ...env };
    if (!env.PI_CONSOLE_PROCESS_REGISTRY || !env.PI_CONSOLE_OWNER_EPOCH) {
      registryRoot = mkdtempSync(join(tmpdir(), "pi-network-process-"));
      env.PI_CONSOLE_PROCESS_REGISTRY = join(registryRoot, "processes.sqlite");
      env.PI_CONSOLE_OWNER_EPOCH = randomUUID();
      delete env.PI_CONSOLE_PROCESS_JOB;
      beginEpoch(env.PI_CONSOLE_PROCESS_REGISTRY, env.PI_CONSOLE_OWNER_EPOCH);
    }
    let child;
    try {
      // Keep the caller's uid mapping: commands enter this user namespace before
      // bwrap creates their private user/PID/mount namespaces. Only the trusted
      // holder keeps capabilities, to bring up lo; workloads still drop them.
      child = managedSpawn("unshare", ["--user", "--map-current-user", "--keep-caps", "--net",
        process.execPath, script, "keeper", httpSocketPath, socksSocketPath], {
        env, stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      if (registryRoot) rmSync(registryRoot, { recursive: true, force: true });
      throw error;
    }
    const done = new Promise(resolve => child.once("close", resolve));
    const network = new LinuxSessionNetwork(child, done, registryRoot);
    let output = "", stderr = "";
    child.stderr.on("data", data => { stderr = (stderr + data).slice(-4096); });
    child.stdin.on("error", () => {});
    let timer;
    const ready = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", () => reject(new Error(`Linux session network stopped before startup: ${stderr.trim()}`)));
      child.stdout.on("data", data => {
        output += data;
        if (output.length > 4096) return reject(new Error("Invalid Linux session network startup response"));
        if (!output.includes("\n")) return;
        try { resolve(JSON.parse(output.split("\n")[0])); }
        catch (error) { reject(error); }
      });
      timer = setTimeout(() => reject(new Error(`Linux session network startup timed out: ${stderr.trim()}`)), 10000);
    });
    try {
      const [, message] = await Promise.all([managedStarted(child), ready]);
      if (!Number.isSafeInteger(message.pid) || message.pid <= 0 || message.uid !== process.getuid()) {
        throw new Error("Invalid Linux session network owner");
      }
      // Pin namespace handles rather than relying on a PID that could be reused.
      // nsenter opens these host-side paths before the command's private /proc.
      for (const kind of ["user", "net"]) network.fds.push(openSync(`/proc/${message.pid}/ns/${kind}`, "r"));
      if (readlinkSync(`/proc/${process.pid}/fd/${network.fds[1]}`) === readlinkSync("/proc/self/ns/net")) {
        throw new Error("Linux session network did not isolate the host network");
      }
      network.namespace = {
        user: `/proc/${process.pid}/fd/${network.fds[0]}`,
        net: `/proc/${process.pid}/fd/${network.fds[1]}`,
      };
      network.assertAlive();
      return network;
    } catch (error) {
      try { await network.close(); }
      catch (cleanupError) { throw Object.assign(cleanupError, { network }); }
      const detail = [error.message, stderr.trim()].filter(Boolean).join("\n");
      throw new Error(`Cannot initialize session-local Linux networking (requires unshare, nsenter and ip): ${detail}`, { cause: error });
    } finally { clearTimeout(timer); }
  }

  assertAlive() {
    if (this.ended || this.closing || this.child.exitCode !== null || this.child.signalCode !== null) {
      throw new Error("Session-local Linux networking stopped; restart the session. No command was started.");
    }
  }

  close() {
    return this.closing ??= this.stop();
  }

  async stop() {
    this.child.stdin.end();
    // The holder normally closes its listeners immediately on EOF. The managed
    // supervisor remains responsible for all descendants if shutdown stalls.
    const stop = setTimeout(() => stopManaged(this.child), 2000);
    let deadline;
    try {
      await Promise.race([this.done, new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error("Linux session network cleanup remains unresolved")), 10000);
      })]);
      const result = managedResult(this.child);
      if (!result || result.managedUnresolved) throw new Error("Linux session network cleanup remains unresolved");
      for (const fd of this.fds.splice(0)) closeSync(fd);
      if (this.registryRoot) rmSync(this.registryRoot, { recursive: true, force: true });
    } finally { clearTimeout(stop); clearTimeout(deadline); }
  }
}

async function keeper(httpSocketPath, socksSocketPath) {
  // A fresh unshare netns has no external interfaces and lo starts down.
  execFileSync("ip", ["link", "set", "dev", "lo", "up"], { timeout: 5000 });
  // Refuse a missing namespace-entry utility before advertising readiness.
  execFileSync("nsenter", ["--version"], { stdio: "ignore", timeout: 5000 });
  const servers = [], sockets = new Set();
  let finish;
  const stopped = new Promise(resolve => { finish = resolve; });
  const shutdown = () => finish();
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  process.stdin.once("end", shutdown);
  process.stdin.resume();
  try {
    for (const [port, path] of [[3128, httpSocketPath], [1080, socksSocketPath]]) {
      const server = createServer(socket => {
        const upstream = connect(path);
        sockets.add(socket); sockets.add(upstream);
        socket.on("error", () => upstream.destroy());
        upstream.on("error", () => socket.destroy());
        socket.once("close", () => { sockets.delete(socket); upstream.destroy(); });
        upstream.once("close", () => { sockets.delete(upstream); socket.destroy(); });
        socket.pipe(upstream).pipe(socket);
      });
      servers.push(server);
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen({ host: "::", port, ipv6Only: false }, resolve);
      }).catch(async error => {
        if (error.code !== "EAFNOSUPPORT") throw error;
        await new Promise((resolve, reject) => {
          server.once("error", reject);
          server.listen(port, "127.0.0.1", resolve);
        });
      });
      server.on("error", error => { console.error(error.message); process.exitCode = 1; shutdown(); });
    }
    console.log(JSON.stringify({ pid: process.pid, uid: process.getuid() }));
    await stopped;
  } finally {
    process.stdin.pause();
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv[2] === "keeper") {
  keeper(process.argv[3], process.argv[4]).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
