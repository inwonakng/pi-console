import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Lexical containment only. Callers decide whether to canonicalize live paths;
// approved permission scopes and history's symlink objects must stay lexical.
export function pathInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep));
}

export function resolveToolPath(path: string, cwd: string): string {
  // Match Pi's file-tool input syntax, not persisted/Git-relative filenames.
  let normalized = path.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  if (normalized === "~") return homedir();
  if (normalized.startsWith("~/")) return join(homedir(), normalized.slice(2));
  if (normalized.startsWith("file://")) normalized = fileURLToPath(normalized);
  return resolve(cwd, normalized);
}
