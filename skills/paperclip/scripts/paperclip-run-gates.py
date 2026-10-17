#!/usr/bin/env python3
"""Run completion-critical quality gates with durable aggregate results."""

from __future__ import annotations

import argparse
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

_CURRENT_PROCESS: subprocess.Popen[bytes] | None = None
_CANCEL_SIGNAL: int | None = None


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def _safe_name(value: str) -> str:
    normalized = re.sub(r"[^A-Za-z0-9._-]+", "-", value).strip("-.")
    return normalized or "gate"


def _require_non_empty_string(value: object, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} must be a non-empty string")
    return value.strip()


def _require_command_parts(value: object, label: str) -> list[str]:
    if not isinstance(value, list) or not value:
        raise ValueError(f"{label} must be a non-empty string array")
    if any(not isinstance(part, str) or not part for part in value):
        raise ValueError(f"{label} must be a non-empty string array")
    return value


def _optional_positive_number(value: object, label: str) -> float | None:
    if value is None:
        return None
    if not isinstance(value, (int, float)) or value <= 0:
        raise ValueError(f"{label} must be positive")
    return float(value)


def _validate_command(raw: object, label: str) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ValueError(f"{label} must be an object")
    return {
        "name": _require_non_empty_string(raw.get("name"), f"{label}.name"),
        "command": _require_command_parts(raw.get("command"), f"{label}.command"),
        "timeoutSeconds": _optional_positive_number(
            raw.get("timeoutSeconds"), f"{label}.timeoutSeconds"
        ),
    }


def _load_config(path: Path) -> dict[str, Any]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError("config must be an object")
    gates_raw = raw.get("gates")
    if not isinstance(gates_raw, list) or not gates_raw:
        raise ValueError("config.gates must be a non-empty array")
    cleanup = _validate_command(raw.get("cleanup"), "config.cleanup")
    deadline = raw.get("deadlineSeconds", 840)
    max_log_bytes = raw.get("maxLogBytes", 1_048_576)
    if not isinstance(deadline, (int, float)) or deadline <= 0:
        raise ValueError("config.deadlineSeconds must be positive")
    if not isinstance(max_log_bytes, int) or max_log_bytes <= 0:
        raise ValueError("config.maxLogBytes must be a positive integer")
    return {
        "deadlineSeconds": float(deadline),
        "maxLogBytes": max_log_bytes,
        "gates": [
            _validate_command(gate, f"config.gates[{index}]")
            for index, gate in enumerate(gates_raw)
        ],
        "cleanup": cleanup,
    }


def _stop_process(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    deadline = time.monotonic() + 2
    while process.poll() is None and time.monotonic() < deadline:
        time.sleep(0.02)
    if process.poll() is None:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def _handle_signal(signum: int, _frame: object) -> None:
    global _CANCEL_SIGNAL
    _CANCEL_SIGNAL = signum
    if _CURRENT_PROCESS is not None:
        _stop_process(_CURRENT_PROCESS)


def _drain_output(
    stream: Any,
    log_path: Path,
    max_log_bytes: int,
    counters: dict[str, int],
) -> None:
    kept = 0
    total = 0
    with log_path.open("wb") as destination:
        while True:
            chunk = stream.read(65_536)
            if not chunk:
                break
            total += len(chunk)
            if kept < max_log_bytes:
                bounded = chunk[: max_log_bytes - kept]
                destination.write(bounded)
                kept += len(bounded)
    counters["total"] = total
    counters["kept"] = kept


def _run_command(
    spec: dict[str, Any],
    log_path: Path,
    max_log_bytes: int,
    timeout_seconds: float,
    *,
    honor_cancellation: bool = True,
) -> dict[str, Any]:
    global _CURRENT_PROCESS
    started_at = _utc_now()
    started = time.monotonic()
    counters = {"total": 0, "kept": 0}
    log_path.parent.mkdir(parents=True, exist_ok=True)
    process = subprocess.Popen(
        spec["command"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    _CURRENT_PROCESS = process
    assert process.stdout is not None
    drain = threading.Thread(
        target=_drain_output,
        args=(process.stdout, log_path, max_log_bytes, counters),
        daemon=True,
    )
    drain.start()
    status = "failed"
    try:
        deadline = started + timeout_seconds
        while process.poll() is None:
            if honor_cancellation and _CANCEL_SIGNAL is not None:
                _stop_process(process)
                status = "cancelled"
                break
            if time.monotonic() >= deadline:
                _stop_process(process)
                status = "timed_out"
                break
            time.sleep(0.02)
        if status not in {"cancelled", "timed_out"}:
            status = "succeeded" if process.returncode == 0 else "failed"
    finally:
        process.wait()
        drain.join(timeout=2)
        process.stdout.close()
        _CURRENT_PROCESS = None
    return {
        "name": spec["name"],
        "command": spec["command"],
        "status": status,
        "exitCode": process.returncode,
        "startedAt": started_at,
        "finishedAt": _utc_now(),
        "durationMs": round((time.monotonic() - started) * 1000),
        "logPath": str(log_path.resolve()),
        "logBytes": counters["total"],
        "logTruncated": counters["total"] > counters["kept"],
    }


def _initial_result() -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "status": "incomplete",
        "complete": False,
        "startedAt": _utc_now(),
        "finishedAt": None,
        "gates": [],
        "cleanup": None,
    }


def _execute_gates(
    config: dict[str, Any], log_dir: Path, run_started: float
) -> tuple[list[dict[str, Any]], bool]:
    records: list[dict[str, Any]] = []
    interrupted = False
    for index, gate in enumerate(config["gates"], start=1):
        remaining = config["deadlineSeconds"] - (time.monotonic() - run_started)
        if remaining <= 0:
            interrupted = True
            break
        gate_timeout = min(gate["timeoutSeconds"] or remaining, remaining)
        record = _run_command(
            gate,
            log_dir / f"{index:02d}-{_safe_name(gate['name'])}.log",
            config["maxLogBytes"],
            gate_timeout,
        )
        records.append(record)
        if record["status"] in {"timed_out", "cancelled"}:
            interrupted = True
            break
    return records, interrupted


def _execute_cleanup(config: dict[str, Any], log_dir: Path) -> dict[str, Any]:
    cleanup = config["cleanup"]
    return _run_command(
        cleanup,
        log_dir / f"cleanup-{_safe_name(cleanup['name'])}.log",
        config["maxLogBytes"],
        cleanup["timeoutSeconds"] or 60.0,
        honor_cancellation=False,
    )


def _has_gate_status(gates: list[dict[str, Any]], status: str) -> bool:
    return any(gate["status"] == status for gate in gates)


def _was_cancelled(gates: list[dict[str, Any]]) -> bool:
    return _CANCEL_SIGNAL is not None or _has_gate_status(gates, "cancelled")


def _was_timed_out(
    gates: list[dict[str, Any]], cleanup: dict[str, Any], interrupted: bool
) -> bool:
    return interrupted or _has_gate_status(gates, "timed_out") or cleanup["status"] == "timed_out"


def _has_failure(gates: list[dict[str, Any]], cleanup: dict[str, Any]) -> bool:
    return _has_gate_status(gates, "failed") or cleanup["status"] != "succeeded"


def _result_outcome(
    gates: list[dict[str, Any]], cleanup: dict[str, Any], interrupted: bool
) -> tuple[str, bool, int]:
    if _was_cancelled(gates):
        return "incomplete", False, 128 + (_CANCEL_SIGNAL or signal.SIGTERM)
    if _was_timed_out(gates, cleanup, interrupted):
        return "incomplete", False, 124
    if _has_failure(gates, cleanup):
        return "failed", True, 1
    return "succeeded", True, 0


def run(config: dict[str, Any], result_path: Path, log_dir: Path) -> int:
    result = _initial_result()
    _atomic_write_json(result_path, result)
    gates, interrupted = _execute_gates(config, log_dir, time.monotonic())
    cleanup = _execute_cleanup(config, log_dir)
    status, complete, exit_code = _result_outcome(gates, cleanup, interrupted)
    result.update(
        status=status,
        complete=complete,
        finishedAt=_utc_now(),
        gates=gates,
        cleanup=cleanup,
    )
    _atomic_write_json(result_path, result)
    return exit_code


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--result", required=True, type=Path)
    parser.add_argument("--log-dir", required=True, type=Path)
    args = parser.parse_args()

    try:
        config = _load_config(args.config)
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        print(f"Invalid gate-runner config: {exc}", file=sys.stderr)
        return 2

    for signum in (signal.SIGINT, signal.SIGTERM):
        signal.signal(signum, _handle_signal)
    return run(config, args.result, args.log_dir)


if __name__ == "__main__":
    raise SystemExit(main())
