import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const runnerPath = path.join(repoRoot, "skills/paperclip/scripts/paperclip-run-gates.py");
const tempRoots: string[] = [];

type CommandSpec = { name: string; command: string[]; timeoutSeconds?: number };
type RunnerConfig = {
  deadlineSeconds?: number;
  maxLogBytes?: number;
  gates: CommandSpec[];
  cleanup: CommandSpec;
};

type GateRecord = {
  name: string;
  status: string;
  exitCode: number | null;
  durationMs: number;
  logPath: string;
  logBytes: number;
  logTruncated: boolean;
};

type RunnerResult = {
  status: string;
  complete: boolean;
  gates: GateRecord[];
  cleanup: GateRecord | null;
};

async function makeRun(config: RunnerConfig) {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-run-gates-"));
  tempRoots.push(root);
  const configPath = path.join(root, "config.json");
  const resultPath = path.join(root, "result.json");
  const logDir = path.join(root, "logs");
  await writeFile(configPath, JSON.stringify(config));
  return { root, configPath, resultPath, logDir };
}

function launch(paths: Awaited<ReturnType<typeof makeRun>>) {
  return spawn("python3", [runnerPath, "--config", paths.configPath, "--result", paths.resultPath, "--log-dir", paths.logDir], {
    cwd: paths.root,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForExit(child: ReturnType<typeof launch>) {
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  return { exitCode, stdout, stderr };
}

async function readResult(resultPath: string): Promise<RunnerResult> {
  return JSON.parse(await readFile(resultPath, "utf8")) as RunnerResult;
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition not reached before timeout");
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("paperclip-run-gates", () => {
  it("waits for foreground gates and records successful cleanup", async () => {
    const paths = await makeRun({
      gates: [{ name: "tests", command: ["bash", "-c", "sleep 0.15; printf passed"] }],
      cleanup: { name: "cleanup", command: ["bash", "-c", "printf cleaned"] },
    });
    const startedAt = Date.now();
    const run = await waitForExit(launch(paths));
    const result = await readResult(paths.resultPath);

    expect(run.exitCode).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual(result);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100);
    expect(result).toMatchObject({ status: "succeeded", complete: true });
    expect(result.gates).toHaveLength(1);
    expect(result.gates[0]).toMatchObject({ name: "tests", status: "succeeded", exitCode: 0 });
    expect(result.cleanup).toMatchObject({ name: "cleanup", status: "succeeded", exitCode: 0 });
  });

  it("preserves an early failure when a later gate succeeds", async () => {
    const paths = await makeRun({
      gates: [
        { name: "ruff-format", command: ["bash", "-c", "exit 7"] },
        { name: "bandit", command: ["bash", "-c", "exit 0"] },
      ],
      cleanup: { name: "cleanup", command: ["bash", "-c", "exit 0"] },
    });
    const run = await waitForExit(launch(paths));
    const result = await readResult(paths.resultPath);

    expect(run.exitCode).toBe(1);
    expect(JSON.parse(run.stdout)).toEqual(result);
    expect(result).toMatchObject({ status: "failed", complete: true });
    expect(result.gates.map(({ name, status, exitCode }) => ({ name, status, exitCode }))).toEqual([
      { name: "ruff-format", status: "failed", exitCode: 7 },
      { name: "bandit", status: "succeeded", exitCode: 0 },
    ]);
  });

  it("records pipeline, test, formatting, and declared complexity failures by name", async () => {
    const paths = await makeRun({
      gates: [
        { name: "pipeline", command: ["bash", "-o", "pipefail", "-c", "false | true"] },
        { name: "pytest", command: ["bash", "-c", "exit 2"] },
        { name: "ruff-format", command: ["bash", "-c", "exit 1"] },
        { name: "radon-threshold", command: ["bash", "-c", "exit 3"] },
      ],
      cleanup: { name: "cleanup", command: ["bash", "-c", "exit 0"] },
    });
    const run = await waitForExit(launch(paths));
    const result = await readResult(paths.resultPath);

    expect(run.exitCode).toBe(1);
    expect(result.gates.map((gate) => gate.name)).toEqual(["pipeline", "pytest", "ruff-format", "radon-threshold"]);
    expect(result.gates.every((gate) => gate.status === "failed")).toBe(true);
  });

  it("fails the aggregate result when cleanup fails", async () => {
    const paths = await makeRun({
      gates: [{ name: "tests", command: ["bash", "-c", "exit 0"] }],
      cleanup: { name: "cleanup", command: ["bash", "-c", "exit 9"] },
    });
    const run = await waitForExit(launch(paths));
    const result = await readResult(paths.resultPath);

    expect(run.exitCode).toBe(1);
    expect(result).toMatchObject({ status: "failed", complete: true });
    expect(result.cleanup).toMatchObject({ status: "failed", exitCode: 9 });
  });

  it("marks a timed-out gate incomplete and still runs cleanup", async () => {
    const paths = await makeRun({
      gates: [{ name: "tests", command: ["bash", "-c", "sleep 2"], timeoutSeconds: 0.1 }],
      cleanup: { name: "cleanup", command: ["bash", "-c", "printf cleaned > cleanup.marker"] },
    });
    const run = await waitForExit(launch(paths));
    const result = await readResult(paths.resultPath);

    expect(run.exitCode).toBe(124);
    expect(JSON.parse(run.stdout)).toEqual(result);
    expect(result).toMatchObject({ status: "incomplete", complete: false });
    expect(result.gates[0]).toMatchObject({ status: "timed_out" });
    expect(result.cleanup).toMatchObject({ status: "succeeded" });
    expect(await readFile(path.join(paths.root, "cleanup.marker"), "utf8")).toBe("cleaned");
  });

  it("keeps logs bounded while reporting the full byte count", async () => {
    const paths = await makeRun({
      maxLogBytes: 32,
      gates: [{ name: "noisy", command: ["python3", "-c", "print('x' * 200)"] }],
      cleanup: { name: "cleanup", command: ["bash", "-c", "exit 0"] },
    });
    const run = await waitForExit(launch(paths));
    const result = await readResult(paths.resultPath);
    const log = await readFile(result.gates[0].logPath);

    expect(run.exitCode).toBe(0);
    expect(result.gates[0].logTruncated).toBe(true);
    expect(result.gates[0].logBytes).toBeGreaterThan(32);
    expect(log.byteLength).toBe(32);
  });

  it("publishes incomplete state atomically and cleans up after cancellation", async () => {
    const paths = await makeRun({
      gates: [{ name: "tests", command: ["bash", "-c", "printf started > started.marker; sleep 30"] }],
      cleanup: { name: "cleanup", command: ["bash", "-c", "printf cleaned > cleanup.marker"] },
    });
    const child = launch(paths);
    await waitFor(async () => {
      try {
        const state = await readResult(paths.resultPath);
        await readFile(path.join(paths.root, "started.marker"));
        return state.status === "incomplete" && state.complete === false;
      } catch {
        return false;
      }
    });
    child.kill("SIGTERM");
    const run = await waitForExit(child);
    const result = await readResult(paths.resultPath);

    expect(run.exitCode).toBe(143);
    expect(JSON.parse(run.stdout)).toEqual(result);
    expect(result).toMatchObject({ status: "incomplete", complete: false });
    expect(result.cleanup).toMatchObject({ status: "succeeded" });
    expect(await readFile(path.join(paths.root, "cleanup.marker"), "utf8")).toBe("cleaned");
  });
});
