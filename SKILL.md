---
name: chatferry
description: >
  Use ChatFerry to drive the live ChatGPT and Claude web UIs through a stable
  CLI contract. Trigger this skill when an agent should submit prompts, wait on
  durable runs, read private conversation URLs, reload saved exports, or list
  available models from the browser-backed harness instead of using an official API.
---

# ChatFerry

Use this skill when the task is to interact with ChatGPT or Claude through the local browser harness and continue from the saved export artifacts.

## Prerequisites

- ChatFerry must be installed: `npm install -g chatferry`
- The target provider must already be logged in. If not, run `chatferry login <provider>` and wait for the human to finish login and any 2FA.
- Keep the browser headed. ChatFerry is designed around real persistent browser profiles, not headless automation.
- Data (profiles, run state) lives in `~/.chatferry/` by default. Override with `CHATFERRY_HOME`.

## Agent Contract

- Default to `--json` for every non-interactive command.
- Treat the CLI as the contract surface. Do not scrape local state files unless the user explicitly asked for internals.
- If you are unsure about the live command shape, inspect it first:

```bash
chatferry schema --json
chatferry schema ask --json
chatferry schema models --json
```

- JSON-mode validation and parser failures are emitted as structured JSON on stderr.
- Run ids, local file paths, and conversation URLs are validated. Do not guess formats or pass unsafe paths with traversal segments like `..`.

## Commands

- `chatferry schema [command] [--json]` describes the live CLI contract.
- `chatferry models <provider> [--json]` returns the provider model catalog.
- `chatferry ask <provider> "<prompt>" [--file PATH] [--model NAME] [--output PATH] [--json]` sends a prompt and waits for the completed markdown export.
- `chatferry ask <provider> "<prompt>" --no-wait [--json]` creates a durable async run and returns immediately with a `run_id`.
- `chatferry status <run_id> [--json]` inspects current run state.
- `chatferry wait <run_id> [--timeout N] [--json]` blocks until the run completes.
- `chatferry result <run_id> [--json]` returns the output path for a completed run.
- `chatferry runs [--provider chatgpt|claude] [--status STATUS] [--json]` lists recent runs.
- `chatferry cancel <run_id> [--json]` cancels a queued or active run.
- `chatferry read <url> [--output PATH] [--json]` extracts a full private conversation transcript.
- `chatferry reload <existing-export.md> [--output PATH] [--json]` reopens the saved `chat_url` from an existing export and refreshes it.

## Run Statuses

Runs have five states: `queued`, `running`, `completed`, `failed`, `cancelled`.

## JSON Output Shape

Every run-related command emits these fields:

```json
{
  "run_id": "run_...",
  "provider": "chatgpt|claude",
  "status": "queued|running|completed|failed|cancelled",
  "model": "Instant|Thinking/Standard|...",
  "prompt_preview": "first 160 chars...",
  "output_path": "/path/to/export.md",
  "chat_url": "https://...",
  "created_at": "ISO timestamp",
  "completed_at": "ISO timestamp or null",
  "error": "message or null"
}
```

## Export Contract

- Prompt/response exports produce two artifacts:
  - human markdown: `<output>.md`
  - machine sidecar: `<output>.meta.json`
- `reload` expects the sibling `.meta.json` file. It does not parse machine truth back out of markdown headings.
- Read exports can also produce `<output>.artifacts/` for Claude artifact-backed content.
- After `ask`, `read`, or `reload`, read the saved files from disk. Do not expect the response body on stdout.

## Model Contract

- `models --json` is the stable way to discover available models.
- The JSON shape is a provider catalog with `provider`, `current`, and `inputs[]`.
- Each input has `id`, `label`, `selected`, `family`, `familyId`, `effort`, `effortId`.
- Do not hardcode UI strings. Call `models --json` first and use the returned catalog.
- ChatGPT families: `Instant`, `Thinking` (Light/Standard/Extended/Heavy), `Pro` (Standard/Extended).
- Claude families: `Opus 4.6`, `Sonnet 4.6`, `Haiku 4.5` (each Standard/Extended).
- The exact live set can drift. Use `models --json` instead of relying on these lists.

## Typical Latency

For a simple "hello world" prompt on fast models:

- ChatGPT Instant: ~15s end-to-end
- ChatGPT Thinking/Standard: ~22s (model thinks longer)
- Claude Sonnet 4.6/Standard: ~16s
- Claude Sonnet 4.6/Extended: ~16s

Breakdown: ~2s browser launch, ~5-7s model selection (human-paced menu clicks), ~1s acceptance, ~5-8s generation + completion detection, ~1s capture. Most of the time is real work, not overhead.

For expensive models (Pro/Extended, Opus/Extended, Thinking/Heavy), expect minutes — use `ask --no-wait`.

## Operating Notes

- Use `ask --no-wait` for slow or expensive work, then `wait` / `result` to collect.
- `ask` (with default `--wait`) is fine for simple one-shot usage.
- Browser ownership is serialized per provider profile. Do not try to run two `chatgpt` or two `claude` sessions concurrently from separate agents outside the daemon flow.
- While a provider daemon is active, `models`, `read`, and `reload` are routed through it automatically.
- `login` refuses to run while a provider daemon is active because login is an interactive browser-owned flow.
- Prefer `--file` or stdin over giant shell-quoted prompts when the prompt is multi-line or punctuation-heavy.
- The CLI rejects unsafe path shapes (traversal segments, control characters).
- All delays and timeouts are centralized in `src/timing.ts`. If tuning browser pacing, that is the single file to edit.

## Good Defaults

- If the task needs a model choice:
  1. `chatferry models <provider> --json`
  2. choose from the returned catalog
  3. `chatferry ask` with `--model`

- If the task may run long:
  1. `chatferry ask --no-wait --json`
  2. store `run_id`
  3. `chatferry wait <run_id> --json`
  4. `chatferry result <run_id> --json`

- If a prior export may have been incomplete:
  1. verify `<output>.meta.json` exists
  2. run `chatferry reload <output>.md --json`
  3. read the refreshed markdown and sidecar

## Error Handling

- If not logged in, the CLI throws with the exact login command to run: `chatferry login <provider>`.
- If the prompt is not accepted within 60s, the CLI throws rather than silently capturing stale page content.
- If generation times out (5 min) on fast models (Instant, Sonnet, etc.), the CLI throws. Slow models (Pro, Thinking) use deferred completion polling — they can take 10-40 minutes on complex prompts.
- If the provider shows a transient error ("Something went wrong"), the CLI throws immediately. There is no automatic retry — retry at the caller level.
- Claude ask captures all artifacts on a turn, not just the last one.

## What Not To Assume

- Do not assume the requested model actually ran. Check the `model` field in the result.
- Do not assume a short active timeout means the provider failed; the run may use deferred completion for extended ChatGPT Pro work.
- Do not assume reload can work from markdown alone; the sidecar `.meta.json` is required.
- Do not assume Claude long-form outputs are always inline; artifacts are part of the normal product behavior.
