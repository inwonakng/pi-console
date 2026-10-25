import { realpath } from "node:fs/promises";
import type { HostOwnerOptions } from "./host-owner.js";
import { manageService } from "./service-management.js";
import { selectedApplication, serviceBuild } from "./service-paths.js";
import { writeRestart, type RestartReceipt } from "./service-restart.js";

// Detach IPC before shutdown; the helper has its own session/process group.
// User-systemd definitions must retain KillMode=process and ExitType=main.
const deadline = setTimeout(() => { console.error("Restart handoff timed out; no restart attempted"); process.exit(1); }, 10000);
process.once("disconnect", () => { clearTimeout(deadline); process.exit(1); });
process.once("message", (message: { options: HostOwnerOptions & { root: string }; receipt: RestartReceipt }) => {
  clearTimeout(deadline);
  process.removeAllListeners("disconnect");
  process.disconnect();
  void restart(message).catch((error) => { console.error(error); process.exitCode = 1; });
});
process.send?.("ready");

async function restart({ options, receipt }: { options: HostOwnerOptions & { root: string }; receipt: RestartReceipt }): Promise<void> {
  try {
    // Resolve on the target machine, never from a frontend-supplied path.
    const appRoot = await realpath(await selectedApplication(options.appRoot));
    const selectedBuild = await serviceBuild(appRoot);
    const outcome = await manageService("restart", { ...options, appRoot }, {
      force: receipt.force, expectedEpoch: receipt.serviceEpoch });
    const hello = outcome.hello;
    if (!hello || hello.hostId !== receipt.hostId || typeof hello.serviceEpoch !== "string"
      || hello.serviceEpoch === receipt.serviceEpoch || hello.buildId !== selectedBuild) {
      throw new Error("Replacement host/epoch/build did not match the requested restart; inspect the service log");
    }
    receipt.status = "completed";
    receipt.result = { serviceEpoch: hello.serviceEpoch, buildId: selectedBuild };
  } catch (error) {
    receipt.status = "failed";
    receipt.error = { code: typeof (error as NodeJS.ErrnoException).code === "string" ? (error as NodeJS.ErrnoException).code! : "service_error",
      message: (error instanceof Error ? error.message : "Server restart failed").slice(0, 4096) };
    console.error("Server restart failed", error);
    process.exitCode = 1;
  }
  await writeRestart(options.root, receipt);
}
