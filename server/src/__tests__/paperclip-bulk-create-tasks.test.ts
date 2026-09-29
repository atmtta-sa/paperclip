import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const helperPath = path.resolve(
  "skills/paperclip/scripts/paperclip-bulk-create-tasks.py",
);

const cleanupDirs = new Set<string>();
const servers = new Set<http.Server>();

afterEach(async () => {
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
  servers.clear();
  await Promise.all(
    [...cleanupDirs].map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
  cleanupDirs.clear();
});

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

async function makeHarness() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-bulk-create-"));
  cleanupDirs.add(dir);
  const manifestPath = path.join(dir, "manifest.json");
  const projectIds = {
    ORP: "23ea58fd-85ac-4deb-81c0-161cc8c054ab",
    Whattsi: "ca391000-371e-42f1-aa92-d1535487b906",
  };
  const tasks = [
    ["ORP Dash Cytoscape", projectIds.ORP, "orp-dash"],
    ["ORP React Flow", projectIds.ORP, "orp-react"],
    ["Whattsi Dash Cytoscape", projectIds.Whattsi, "whattsi-dash"],
    ["Whattsi React Flow", projectIds.Whattsi, "whattsi-react"],
  ].map(([title, projectId, key]) => ({
    title,
    projectId,
    assigneeAgentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    description: `${title} implementation`,
    initialPlan: `# Plan\n\nImplement ${title}.`,
    idempotencyKey: `architecture:${key}`,
    status: "todo",
  }));
  await fs.writeFile(manifestPath, JSON.stringify({ tasks }), "utf8");

  const issues: Array<Record<string, unknown>> = [];
  const userAgents: string[] = [];
  let posts = 0;
  const server = http.createServer(async (req, res) => {
    userAgents.push(req.headers["user-agent"] ?? "");
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    res.setHeader("Content-Type", "application/json");
    if (
      req.method === "GET" &&
      url.pathname === "/api/companies/company-1/issues"
    ) {
      const query = url.searchParams.get("q");
      expect(url.searchParams.get("view")).toBe("compact");
      expect(url.searchParams.get("limit")).toBe("20");
      res.end(JSON.stringify(issues.filter((issue) => issue.title === query)));
      return;
    }
    if (
      req.method === "POST" &&
      url.pathname === "/api/companies/company-1/issues"
    ) {
      expect(req.headers.authorization).toBe("Bearer run-token");
      expect(req.headers["x-paperclip-run-id"]).toBe("run-1");
      const body = await readJson(req);
      posts += 1;
      const issue = {
        ...body,
        id: `00000000-0000-4000-8000-${String(posts).padStart(12, "0")}`,
        identifier: `COM-${300 + posts}`,
      };
      issues.push(issue);
      res.statusCode = 201;
      res.end(JSON.stringify(issue));
      return;
    }
    const issueMatch = url.pathname.match(/^\/api\/issues\/(.+)$/);
    if (req.method === "GET" && issueMatch) {
      const issue = issues.find((candidate) => candidate.id === issueMatch[1]);
      if (!issue) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      res.end(JSON.stringify(issue));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "unexpected route" }));
  });
  servers.add(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing address");

  const run = async () => {
    const result = await execFileAsync("python3", [helperPath, manifestPath], {
      env: {
        ...process.env,
        PAPERCLIP_API_URL: `http://127.0.0.1:${address.port}/api`,
        PAPERCLIP_API_KEY: "run-token",
        PAPERCLIP_COMPANY_ID: "company-1",
        PAPERCLIP_RUN_ID: "run-1",
      },
    });
    return JSON.parse(result.stdout) as {
      createdCount: number;
      reusedCount: number;
      tasks: Array<{ identifier: string; title: string; projectId: string }>;
    };
  };

  return { run, issues, getPosts: () => posts, tasks, userAgents };
}

describe("paperclip bulk task creation helper", () => {
  it("documents the one-call bulk creation path in the installed skill", async () => {
    const skill = await fs.readFile(
      path.resolve("skills/paperclip/SKILL.md"),
      "utf8",
    );

    expect(skill).toContain("Multi-task creation within a bounded run");
    expect(skill).toContain("scripts/paperclip-bulk-create-tasks.py");
    expect(skill).toContain("Do not probe OpenAPI paths");
    expect(skill).toContain("one terminal tool invocation");
  });

  it("creates four tasks with bounded searches and verified readbacks", async () => {
    const harness = await makeHarness();

    const result = await harness.run();

    expect(result.createdCount).toBe(4);
    expect(result.reusedCount).toBe(0);
    expect(result.tasks).toHaveLength(4);
    expect(harness.getPosts()).toBe(4);
    expect(harness.issues).toHaveLength(4);
    expect(harness.userAgents.length).toBeGreaterThan(0);
    expect(new Set(harness.userAgents)).toEqual(
      new Set(["Paperclip-Bulk-Task-Helper/1.0"]),
    );
  });

  it("reuses exact project/title matches on a safe rerun", async () => {
    const harness = await makeHarness();
    await harness.run();

    const rerun = await harness.run();

    expect(rerun.createdCount).toBe(0);
    expect(rerun.reusedCount).toBe(4);
    expect(rerun.tasks).toHaveLength(4);
    expect(harness.getPosts()).toBe(4);
  });
});
