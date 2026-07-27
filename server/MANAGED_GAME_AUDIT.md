# Managed Game Reliability Audit

Generated: 2026-07-17T22:28:18.665Z

## Summary

- Checks: 6
- Passed: 5
- Failed: 1
- Critical: 0
- High: 1
- Medium: 0
- Low: 0

## Findings

### MG-001 — Audit harness completed all requested phases

Severity: **HIGH**

```json
{
  "error": "Error: Docker daemon unavailable: WARNING: Error loading config file: open C:\\Users\\balma\\.docker\\config.json: Access is denied.\npermission denied while trying to connect to the docker API at npipe:////./pipe/docker_engine\n    at main (C:\\Users\\balma\\Music\\karta\\backend\\server\\test\\audit\\run-managed-game-audit.js:701:11)\n    at C:\\Users\\balma\\Music\\karta\\backend\\server\\test\\audit\\run-managed-game-audit.js:757:11\n    at Object.<anonymous> (C:\\Users\\balma\\Music\\karta\\backend\\server\\test\\audit\\run-managed-game-audit.js:775:3)\n    at Module._compile (node:internal/modules/cjs/loader:1761:14)\n    at Object..js (node:internal/modules/cjs/loader:1893:10)\n    at Module.load (node:internal/modules/cjs/loader:1481:32)\n    at Module._load (node:internal/modules/cjs/loader:1300:12)\n    at TracingChannel.traceSync (node:diagnostics_channel:328:14)\n    at wrapModuleLoad (node:internal/modules/cjs/loader:245:24)\n    at Module.executeUserEntryPoint [as runMain] (node:internal/modules/run_main:154:5)",
  "backendLogTail": ""
}
```

## Metrics

```json
{
  "stateFuzz": {
    "sequences": 500,
    "seed": 1729,
    "actions": 30000,
    "failures": [],
    "failureCount": 0
  }
}
```

## Notes

