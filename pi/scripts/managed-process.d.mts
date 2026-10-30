import type { ChildProcess, ChildProcessWithoutNullStreams } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
export type ManagedExit = { code: number | null; signal: NodeJS.Signals | null; error?: string; managedUnresolved: boolean; survivors?: number[]; nested?: {id: string; status: string}[] };
export type ManagedJob = { id: string; parent: string | null; label: string; status: "intent" | "running" | "cancelled" | "done" | "unresolved" | "interrupted"; launch_open: number; result?: ManagedExit };
export type ResourceStamp = { path: string; target: string; ino: string; mode: string; size: string; mtimeNs: string; ctimeNs: string };
export type ResourceManifest = {
  readonly buildId: string;
  readonly files: readonly ResourceStamp[];
  readonly resolutions: readonly { from: string; name: string; target: string | null }[];
  readonly lookup: readonly { path: string; target: string | null }[];
};
export function assertResourceManifest(manifest: ResourceManifest): void;
export function assertManagedResources(environment?: NodeJS.ProcessEnv): void;
export function ownerLease(root: string): { close(): void };
export function registry(path: string): DatabaseSync;
export function unreconciledEpochs(path: string): string[];
export type BootIdentity = { machineId: string; bootId: string };
export function bootIdentity(): BootIdentity | undefined;
export function beginEpoch(path: string, epoch: string, ownership?: { claim: string; owner: string }): void;
export function interruptEpoch(path: string, epoch: string, evidence: {
  basis: "previous_boot" | "administrator_confirmed_reboot";
  recordedBoot: BootIdentity | null; currentBoot: BootIdentity | null; time: string;
}): void;
export function assertManagedLaunchAllowed(path: string, epoch: string): void;
export function sealEpoch(path: string, epoch: string): void;
export function inspectEpoch(path: string, epoch: string): ManagedJob[];
export function managedSpawn(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; stdio: ["pipe", "pipe", "pipe"] }): ChildProcessWithoutNullStreams;
export function managedResult(child: ChildProcess): ManagedExit | undefined;
export function stopManaged(child: ChildProcess): boolean;
