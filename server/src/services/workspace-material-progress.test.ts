import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { captureWorkspaceMaterialSnapshot } from "./workspace-material-progress.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]) {
  await execFileAsync("git", args, { cwd });
}

describe("workspace material progress", () => {
  it("detects tracked and untracked source changes in an isolated worktree", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "paperclip-progress-"));
    await git(cwd, "init");
    await git(cwd, "config", "user.email", "test@example.invalid");
    await git(cwd, "config", "user.name", "Paperclip Test");
    await writeFile(join(cwd, "tracked.ts"), "export const value = 1;\n");
    await git(cwd, "add", "tracked.ts");
    await git(cwd, "commit", "-m", "baseline");

    const before = await captureWorkspaceMaterialSnapshot({ cwd, providerType: "git_worktree" });
    await writeFile(join(cwd, "tracked.ts"), "export const value = 2;\n");
    await mkdir(join(cwd, "src"));
    await writeFile(join(cwd, "src", "new.ts"), "export const added = true;\n");
    const after = await captureWorkspaceMaterialSnapshot({ cwd, providerType: "git_worktree" });

    expect(before.status).toBe("verified");
    expect(after.status).toBe("verified");
    if (before.status !== "verified" || after.status !== "verified") {
      throw new Error("expected verified workspace snapshots");
    }
    expect(after.digest).not.toBe(before.digest);
  });

  it("fails closed for a shared local checkout", async () => {
    const snapshot = await captureWorkspaceMaterialSnapshot({
      cwd: "/shared/project",
      providerType: "local_fs",
    });
    expect(snapshot).toEqual({ status: "unknown", reason: "workspace_ownership_unenforceable" });
  });

  it("excludes untracked dependency trees before applying the file limit", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "paperclip-progress-"));
    await git(cwd, "init");
    await git(cwd, "config", "user.email", "test@example.invalid");
    await git(cwd, "config", "user.name", "Paperclip Test");
    await writeFile(join(cwd, "tracked.ts"), "export const value = 1;\n");
    await git(cwd, "add", "tracked.ts");
    await git(cwd, "commit", "-m", "baseline");
    await mkdir(join(cwd, "node_modules", "dependency"), { recursive: true });
    await writeFile(join(cwd, "node_modules", "dependency", "index.js"), "generated\n");
    await mkdir(join(cwd, "src"));
    await writeFile(join(cwd, "src", "new.ts"), "export const added = true;\n");

    const snapshot = await captureWorkspaceMaterialSnapshot({
      cwd,
      providerType: "git_worktree",
      maxFiles: 1,
    });

    expect(snapshot.status).toBe("verified");
  });

  it("reports bounded diagnostics when relevant files exceed the limit", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "paperclip-progress-"));
    await git(cwd, "init");
    await git(cwd, "config", "user.email", "test@example.invalid");
    await git(cwd, "config", "user.name", "Paperclip Test");
    await writeFile(join(cwd, "tracked.ts"), "export const value = 1;\n");
    await git(cwd, "add", "tracked.ts");
    await git(cwd, "commit", "-m", "baseline");
    await writeFile(join(cwd, "one.ts"), "one\n");
    await writeFile(join(cwd, "two.ts"), "two\n");

    const snapshot = await captureWorkspaceMaterialSnapshot({
      cwd,
      providerType: "git_worktree",
      maxFiles: 1,
    });

    expect(snapshot).toEqual({
      status: "unknown",
      reason: "workspace_snapshot_resource_limit",
      diagnostics: {
        phase: "untracked_list",
        maxFiles: 1,
        maxBytes: 20 * 1024 * 1024,
        filesObserved: 2,
        bytesObserved: 0,
      },
    });
  });
});