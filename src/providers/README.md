# Providers Reference

This directory contains provider-specific browser flows for the live web UIs.

Files:

- [base.ts](base.ts) — shared provider adapter behavior
- [chatgpt.ts](chatgpt.ts) — ChatGPT-specific navigation, model selection, input, and extraction
- [claude.ts](claude.ts) — Claude-specific navigation, model selection, input, and extraction

Rules:

- UI selectors belong in [selectors/](../../selectors/README.md), not hardcoded here unless the selector is synthesized from other facts.
- Provider files should describe browser behavior, not own cross-provider orchestration.
- If a behavior applies to both providers, push it up into [service.ts](../service.ts) or [base.ts](base.ts).
