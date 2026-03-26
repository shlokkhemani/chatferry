# Selectors Reference

This directory is the canonical home for provider DOM selectors.

Files:

- [chatgpt.yaml](chatgpt.yaml) — ChatGPT selectors
- [claude.yaml](claude.yaml) — Claude selectors

How to use this directory:

- If a provider UI changes, update the selector YAML first.
- Keep code reading selectors through [config.ts](../src/config.ts).
- Prefer primary selector plus ordered fallbacks instead of one-off selector patches in provider code.

This directory is reference, not narrative. The source of truth for current selector choice is the YAML itself.
