# Source Reference

This directory contains the ChatFerry implementation.

Start here:

- [cli.ts](cli.ts) — public CLI surface and command routing
- [daemon.ts](daemon.ts) — provider daemon, slot scheduling, and control-plane ownership
- [service.ts](service.ts) — provider-agnostic browser operations on a live `Page`

Directory map:

- [browser.ts](browser.ts) — persistent browser launch and provider locking
- [runs.ts](runs.ts) — durable run records and reconciliation
- [worker.ts](worker.ts) — legacy per-run worker path
- [providers/](providers/README.md) — provider-specific browser flows
- [capture.ts](capture.ts) — final conversation capture and deferred recovery
- [completion.ts](completion.ts) — completion detection heuristics
- [extract.ts](extract.ts) — markdown document construction and output paths
- [document.ts](document.ts) — parsing saved markdown exports
- [config.ts](config.ts) — selector/config loading
- [human.ts](human.ts) — human-like prompt insertion helpers
- [recovery.ts](recovery.ts) — transient provider failure recovery
- [soak.ts](soak.ts) — long-form live validation harness
- [types.ts](types.ts) — shared types
- [utils.ts](utils.ts) — shared filesystem and helper utilities

Tests:

- `*.test.ts` files cover deterministic logic that does not need a live browser session.

When editing:

- Keep provider-specific DOM logic in `providers/`.
- Keep selector truth in `selectors/`, not in code.
- Prefer routing and orchestration changes in `cli.ts`, `daemon.ts`, and `service.ts`.
