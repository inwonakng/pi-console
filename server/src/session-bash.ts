import { object } from "./pi-records.js";

// Wire contract of shared/bash-jobs.ts. No extension runtime is loaded in the owner.
export type BashJobSummary = {
  jobId: string; command: string; cwd: string; state: "starting" | "running" | "terminal" | "unresolved";
  createdAt: string; startedAt?: string; endedAt?: string; managedId?: string; timeout?: number;
  exitCode: number | null; signal: string | null; sandboxBlocked: boolean;
  cleanup: "pending" | "complete" | "unresolved"; stopReason?: "stop" | "deadline" | "owner_shutdown";
  error?: string; completion: "pending" | "queued" | "delivered" | "collected" | "suppressed"; restored: boolean;
};
type Output = { jobId: string; stream: "stdout" | "stderr"; text: string; offset: number; nextOffset: number; totalBytes: number; eof: boolean };
export type BashServiceResult =
  | { kind: "bash_job_list"; jobs: BashJobSummary[]; nextOffset: number | null }
  | { kind: "bash_job_status"; job: BashJobSummary }
  | { kind: "bash_job_result"; job: BashJobSummary; stdout: Output; stderr: Output }
  | { kind: "bash_join_cancelled"; jobId: string }
  | { kind: "bash_wait_cancelled"; invocationId: string; cancelled: boolean };
export function bashOperation(operation: string): boolean {
  return ["bash.list", "bash.status", "bash.join", "bash.stop", "bash.cancel-wait"].includes(operation);
}
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).every(key => keys.includes(key));
const text = (v: unknown, max = 1024): v is string => typeof v === "string" && Buffer.byteLength(v) <= max;
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const id = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{22}$/.test(v);
function summary(v: unknown): v is BashJobSummary {
  return object(v) && Buffer.byteLength(JSON.stringify(v)) <= 12 * 1024 && exact(v, ["jobId", "command", "cwd", "state", "createdAt", "startedAt", "endedAt", "managedId", "timeout", "exitCode", "signal", "sandboxBlocked", "cleanup", "stopReason", "error", "completion", "restored"])
    && id(v.jobId) && text(v.command, 4096) && text(v.cwd, 4096) && text(v.createdAt)
    && ["starting", "running", "terminal", "unresolved"].includes(String(v.state))
    && ["startedAt", "endedAt", "managedId", "error"].every(key => v[key] === undefined || text(v[key], 4096))
    && (v.timeout === undefined || typeof v.timeout === "number" && Number.isFinite(v.timeout) && v.timeout > 0)
    && (v.exitCode === null || Number.isSafeInteger(v.exitCode)) && (v.signal === null || text(v.signal))
    && typeof v.sandboxBlocked === "boolean" && typeof v.restored === "boolean"
    && ["pending", "complete", "unresolved"].includes(String(v.cleanup))
    && (v.stopReason === undefined || ["stop", "deadline", "owner_shutdown"].includes(String(v.stopReason)))
    && ["pending", "queued", "delivered", "collected", "suppressed"].includes(String(v.completion));
}
function output(v: unknown, stream: string, jobId: string): v is Output {
  return object(v) && Buffer.byteLength(JSON.stringify(v)) <= 100 * 1024 && exact(v, ["jobId", "stream", "text", "offset", "nextOffset", "totalBytes", "eof"])
    && v.jobId === jobId && v.stream === stream && text(v.text, 64 * 1024)
    && integer(v.offset) && integer(v.nextOffset) && integer(v.totalBytes)
    && v.offset <= v.nextOffset && v.nextOffset <= v.totalBytes && v.nextOffset - v.offset <= 16 * 1024
    && typeof v.eof === "boolean" && v.eof === (v.nextOffset === v.totalBytes);
}
export function validBashResult(v: unknown): v is BashServiceResult {
  if (!object(v)) return false;
  switch (v.kind) {
    case "bash_job_list": return exact(v, ["kind", "jobs", "nextOffset"]) && Array.isArray(v.jobs) && v.jobs.length <= 20
      && v.jobs.every(summary) && (v.nextOffset === null || integer(v.nextOffset));
    case "bash_job_status": return exact(v, ["kind", "job"]) && summary(v.job);
    case "bash_job_result": return exact(v, ["kind", "job", "stdout", "stderr"]) && summary(v.job)
      && output(v.stdout, "stdout", v.job.jobId) && output(v.stderr, "stderr", v.job.jobId);
    case "bash_join_cancelled": return exact(v, ["kind", "jobId"]) && id(v.jobId);
    case "bash_wait_cancelled": return exact(v, ["kind", "invocationId", "cancelled"]) && text(v.invocationId, 128)
      && /^[\w-]+$/.test(v.invocationId) && typeof v.cancelled === "boolean";
    default: return false;
  }
}
