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
});