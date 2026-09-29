#!/usr/bin/env python3
"""Create a bounded manifest of Paperclip tasks safely and idempotently."""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, NoReturn

ALLOWED_FIELDS = {
    "title",
    "description",
    "projectId",
    "assigneeAgentId",
    "status",
    "priority",
    "initialPlan",
    "idempotencyKey",
    "parentId",
    "goalId",
    "blockedByIssueIds",
}
REQUIRED_FIELDS = {
    "title",
    "projectId",
    "assigneeAgentId",
    "initialPlan",
    "idempotencyKey",
}


def fail(message: str) -> NoReturn:
    raise SystemExit(message)


def require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        fail(f"Missing required environment variable: {name}")
    return value


def api_root(raw_url: str) -> str:
    root = raw_url.rstrip("/")
    if root.endswith("/api"):
        root = root[:-4]
    return f"{root}/api"


def request_json(
    url: str,
    token: str,
    *,
    method: str = "GET",
    run_id: str | None = None,
    payload: dict[str, Any] | None = None,
) -> Any:
    headers = {
        "Accept": "application/json",
        "Authorization": f"Bearer {token}",
    }
    data = None
    if payload is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    if method != "GET":
        if not run_id:
            fail("A run ID is required for mutating requests")
        headers["X-Paperclip-Run-Id"] = run_id
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            body = response.read().decode("utf-8")
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")[:1_000]
        fail(f"Paperclip API {method} failed ({error.code}): {detail}")
    except urllib.error.URLError as error:
        fail(f"Paperclip API {method} failed: {error.reason}")
    try:
        return json.loads(body)
    except json.JSONDecodeError:
        fail(f"Paperclip API {method} returned invalid JSON")


def list_items(value: Any) -> list[dict[str, Any]]:
    if isinstance(value, list):
        items = value
    elif isinstance(value, dict):
        items = value.get("items", value.get("data"))
    else:
        items = None
    if not isinstance(items, list) or not all(isinstance(item, dict) for item in items):
        fail("Paperclip issue search returned an unexpected response shape")
    return [dict(item) for item in items]


def validate_task(raw: Any, index: int) -> dict[str, Any]:
    if not isinstance(raw, dict):
        fail(f"Task {index} must be an object")
    unknown = set(raw) - ALLOWED_FIELDS
    if unknown:
        fail(f"Task {index} has unsupported fields: {', '.join(sorted(unknown))}")
    missing = [field for field in REQUIRED_FIELDS if not raw.get(field)]
    if missing:
        fail(f"Task {index} is missing required fields: {', '.join(sorted(missing))}")
    task = dict(raw)
    task.setdefault("status", "todo")
    task.setdefault("priority", "medium")
    for field in ("title", "projectId", "assigneeAgentId", "initialPlan", "idempotencyKey"):
        if not isinstance(task[field], str) or not task[field].strip():
            fail(f"Task {index} field {field} must be a non-empty string")
        task[field] = task[field].strip()
    if task["status"] not in {"backlog", "todo", "blocked"}:
        fail(f"Task {index} status must be backlog, todo, or blocked")
    return task


def verify_issue(issue: Any, task: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(issue, dict):
        fail(f"Readback for {task['title']} returned an unexpected response")
    for field in ("title", "projectId", "assigneeAgentId"):
        if issue.get(field) != task.get(field):
            fail(
                f"Readback mismatch for {task['title']}: "
                f"{field}={issue.get(field)!r}"
            )
    if not isinstance(issue.get("id"), str) or not issue["id"]:
        fail(f"Readback for {task['title']} is missing an issue ID")
    return {
        "id": issue["id"],
        "identifier": issue.get("identifier"),
        "title": issue["title"],
        "projectId": issue["projectId"],
        "assigneeAgentId": issue["assigneeAgentId"],
        "status": issue.get("status"),
    }


def load_tasks(manifest_path: Path) -> list[dict[str, Any]]:
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        fail(f"Cannot read task manifest: {error}")
    raw_tasks = manifest.get("tasks") if isinstance(manifest, dict) else None
    if not isinstance(raw_tasks, list) or not 1 <= len(raw_tasks) <= 50:
        fail("Manifest must contain 1 to 50 tasks")
    tasks = [validate_task(raw, index) for index, raw in enumerate(raw_tasks, 1)]
    identities = [(task["projectId"], task["title"]) for task in tasks]
    if len(set(identities)) != len(identities):
        fail("Manifest contains duplicate project/title task identities")
    idempotency_keys = [task["idempotencyKey"] for task in tasks]
    if len(set(idempotency_keys)) != len(idempotency_keys):
        fail("Manifest contains duplicate idempotency keys")
    return tasks


def plan_tasks(
    tasks: list[dict[str, Any]], api: str, token: str, company_id: str
) -> list[tuple[dict[str, Any], dict[str, Any] | None]]:
    decisions: list[tuple[dict[str, Any], dict[str, Any] | None]] = []
    for task in tasks:
        query = urllib.parse.urlencode(
            {"q": task["title"], "view": "compact", "limit": "20"}
        )
        found = list_items(
            request_json(f"{api}/companies/{company_id}/issues?{query}", token)
        )
        exact = [
            issue
            for issue in found
            if issue.get("title") == task["title"]
            and issue.get("projectId") == task["projectId"]
        ]
        if len(exact) > 1:
            fail(
                f"Duplicate check found multiple exact matches for "
                f"{task['projectId']} / {task['title']}"
            )
        decisions.append((task, exact[0] if exact else None))
    return decisions


def apply_tasks(
    decisions: list[tuple[dict[str, Any], dict[str, Any] | None]],
    api: str,
    token: str,
    company_id: str,
    run_id: str,
) -> dict[str, Any]:
    created_count = 0
    reused_count = 0
    verified: list[dict[str, Any]] = []
    for task, existing in decisions:
        if existing is None:
            issue = request_json(
                f"{api}/companies/{company_id}/issues",
                token,
                method="POST",
                run_id=run_id,
                payload=task,
            )
            created_count += 1
        else:
            issue = existing
            reused_count += 1
        issue_id = issue.get("id") if isinstance(issue, dict) else None
        if not isinstance(issue_id, str) or not issue_id:
            fail(f"Task result for {task['title']} is missing an issue ID")
        readback = request_json(f"{api}/issues/{issue_id}", token)
        verified.append(verify_issue(readback, task))
    return {
        "createdCount": created_count,
        "reusedCount": reused_count,
        "tasks": verified,
    }


def main() -> None:
    if len(sys.argv) != 2:
        fail("Usage: paperclip-bulk-create-tasks.py MANIFEST.json")
    tasks = load_tasks(Path(sys.argv[1]))
    api = api_root(require_env("PAPERCLIP_API_URL"))
    token = require_env("PAPERCLIP_API_KEY")
    company_id = require_env("PAPERCLIP_COMPANY_ID")
    run_id = require_env("PAPERCLIP_RUN_ID")
    decisions = plan_tasks(tasks, api, token, company_id)
    result = apply_tasks(decisions, api, token, company_id, run_id)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
