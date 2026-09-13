import { execFileSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";

function isContained(root, candidate) {
  return candidate !== root && candidate.startsWith(`${root}${path.sep}`);
}

export function verifyDisposableGitWorkspaces(workspaces, disposableRoot) {
  let root;
  try {
    root = realpathSync(disposableRoot);
  } catch {
    throw new Error(`disposable root does not exist: ${disposableRoot}`);
  }

  const verified = {};
  for (const [key, configuredPath] of Object.entries(workspaces)) {
    let workspace;
    try {
      workspace = realpathSync(configuredPath);
    } catch {
      throw new Error(`workspace ${key} does not exist: ${configuredPath}`);
    }
    if (!statSync(workspace).isDirectory()) {
      throw new Error(`workspace ${key} is not a directory: ${configuredPath}`);
    }
    if (!isContained(root, workspace)) {
      throw new Error(`workspace ${key} resolves outside disposable root ${root}`);
    }

    let gitRoot;
    try {
      gitRoot = execFileSync("git", ["-C", workspace, "rev-parse", "--show-toplevel"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      throw new Error(`workspace ${key} is not a Git repository: ${configuredPath}`);
    }
    if (realpathSync(gitRoot) !== workspace) {
      throw new Error(`workspace ${key} is not the root of its disposable Git repository`);
    }
    verified[key] = workspace;
  }
  return verified;
}
