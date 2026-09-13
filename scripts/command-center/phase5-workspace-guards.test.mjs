import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { verifyDisposableGitWorkspaces } from "./phase5-workspace-guards.mjs";

function initGitRepository(directory) {
  mkdirSync(directory, { recursive: true });
  execFileSync("git", ["init", "--quiet", directory]);
}

test("accepts five distinct real Git repositories beneath the disposable root", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "paperclip-phase5-guard-"));
  const workspaces = {};
  for (const key of ["lead", "orp", "whattsi", "codex", "hermes"]) {
    const directory = path.join(root, key);
    initGitRepository(directory);
    workspaces[key] = directory;
  }

  assert.deepEqual(verifyDisposableGitWorkspaces(workspaces, root), workspaces);
});

test("rejects a missing workspace", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "paperclip-phase5-guard-"));
  assert.throws(
    () => verifyDisposableGitWorkspaces({ lead: path.join(root, "missing") }, root),
    /does not exist/,
  );
});

test("rejects a directory that is not a Git repository", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "paperclip-phase5-guard-"));
  const directory = path.join(root, "plain");
  mkdirSync(directory);
  assert.throws(
    () => verifyDisposableGitWorkspaces({ lead: directory }, root),
    /not a Git repository/,
  );
});

test("rejects a symlink that resolves outside the disposable root", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "paperclip-phase5-guard-"));
  const outside = mkdtempSync(path.join(os.tmpdir(), "paperclip-phase5-outside-"));
  initGitRepository(outside);
  const linked = path.join(root, "linked");
  symlinkSync(outside, linked, "dir");

  assert.notEqual(realpathSync(linked), linked);
  assert.throws(
    () => verifyDisposableGitWorkspaces({ lead: linked }, root),
    /resolves outside disposable root/,
  );
});
