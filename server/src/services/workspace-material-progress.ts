import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile, readlink } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_MAX_FILES = 2_000;
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;

export type WorkspaceMaterialSnapshot =
  | { status: "verified"; digest: string; fileCount: number; bytes: number }
  | { status: "unknown"; reason: string };

export function isVerifiedWorkspaceMaterialProgressReceipt(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  const beforeDigest = receipt.beforeDigest;
  const afterDigest = receipt.afterDigest;
  return (
    receipt.version === 1 &&
    receipt.source === "paperclip_server" &&
    receipt.status === "verified" &&
    receipt.reason === "workspace_material_state_changed" &&
    receipt.changed === true &&
    typeof receipt.workspaceId === "string" &&
    receipt.workspaceId.length > 0 &&
    typeof beforeDigest === "string" &&
    beforeDigest.length > 0 &&
    typeof afterDigest === "string" &&
    afterDigest.length > 0 &&
    beforeDigest !== afterDigest
  );
}

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function insideWorkspace(cwd: string, path: string) {
  const root = resolve(cwd);
  const candidate = resolve(root, path);
  return candidate === root || candidate.startsWith(`${root}${sep}`) ? candidate : null;
}

export async function captureWorkspaceMaterialSnapshot(input: {
  cwd: string;
  providerType: string;
  maxFiles?: number;
  maxBytes?: number;
}): Promise<WorkspaceMaterialSnapshot> {
  if (input.providerType !== "git_worktree") {
    return { status: "unknown", reason: "workspace_ownership_unenforceable" };
  }
  const maxFiles = input.maxFiles ?? DEFAULT_MAX_FILES;
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
  try {
    const [{ stdout: head }, { stdout: diff }, { stdout: untrackedOutput }] = await Promise.all([
      execFileAsync("git", ["rev-parse", "HEAD"], { cwd: input.cwd, encoding: "utf8" }),
      execFileAsync("git", ["diff", "--binary", "--no-ext-diff", "HEAD"], {
        cwd: input.cwd,
        encoding: "buffer",
        maxBuffer: maxBytes + 1,
      }),
      execFileAsync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
        cwd: input.cwd,
        encoding: "buffer",
        maxBuffer: maxBytes + 1,
      }),
    ]);
    const diffBuffer = Buffer.from(diff);
    if (diffBuffer.byteLength > maxBytes) {
      return { status: "unknown", reason: "workspace_snapshot_resource_limit" };
    }
    const paths = Buffer.from(untrackedOutput)
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .sort();
    if (paths.length > maxFiles) {
      return { status: "unknown", reason: "workspace_snapshot_resource_limit" };
    }
    let bytes = diffBuffer.byteLength;
    const entries: string[] = [];
    for (const relativePath of paths) {
      const absolutePath = insideWorkspace(input.cwd, relativePath);
      if (!absolutePath) return { status: "unknown", reason: "workspace_path_escape" };
      const stat = await lstat(absolutePath);
      let content: Buffer;
      let type: "file" | "symlink";
      if (stat.isSymbolicLink()) {
        type = "symlink";
        content = Buffer.from(await readlink(absolutePath));
      } else if (stat.isFile()) {
        type = "file";
        content = await readFile(absolutePath);
      } else {
        return { status: "unknown", reason: "workspace_entry_type_unsupported" };
      }
      bytes += content.byteLength;
      if (bytes > maxBytes) {
        return { status: "unknown", reason: "workspace_snapshot_resource_limit" };
      }
      entries.push(JSON.stringify([relativePath, type, stat.mode, content.byteLength, sha256(content)]));
    }
    return {
      status: "verified",
      digest: sha256(`${head.trim()}\n${sha256(diffBuffer)}\n${entries.join("\n")}`),
      fileCount: paths.length,
      bytes,
    };
  } catch {
    return { status: "unknown", reason: "workspace_snapshot_unavailable" };
  }
}