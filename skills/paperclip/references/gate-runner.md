# Completion-critical gate runner

Use `scripts/paperclip-run-gates.py` only when a task already requires multiple shell quality checks. The runner does not choose or add gates.

Run it synchronously:

```bash
python3 ~/.hermes/skills/paperclip/scripts/paperclip-run-gates.py \
  --config artifacts/quality-gates.config.json \
  --result artifacts/quality-gates.result.json \
  --log-dir artifacts/quality-gate-logs
```

The config is JSON:

```json
{
  "deadlineSeconds": 840,
  "maxLogBytes": 1048576,
  "gates": [
    {
      "name": "pytest",
      "command": ["uv", "run", "python", "-m", "pytest", "-q"],
      "timeoutSeconds": 600
    },
    {
      "name": "ruff-format",
      "command": ["uv", "run", "python", "-m", "ruff", "format", "--check", "."]
    }
  ],
  "cleanup": {
    "name": "drop-disposable-database",
    "command": ["python3", "scripts/drop-test-database.py"],
    "timeoutSeconds": 60
  }
}
```

Rules:

- Pass commands as argument arrays. Use `bash -o pipefail -c <command>` only when a real pipeline is required.
- Set `deadlineSeconds` below the admitted agent runtime so cleanup and final disposition have time to finish.
- The runner executes gates in order and preserves every failure even when later gates pass.
- A timeout or cancellation produces `status: "incomplete"` and attempts cleanup.
- A failed gate or cleanup produces `status: "failed"`.
- Logs are bounded by `maxLogBytes`; `logBytes` records total output and `logTruncated` reports truncation.
- The result starts as an atomically written incomplete record and becomes complete only after gates and cleanup finish.
- Mark work complete only when the process exits zero and the result has `complete: true`, `status: "succeeded"`, every gate succeeded, and cleanup succeeded.
- Never use a destructive cleanup command without its own explicit target validation.
