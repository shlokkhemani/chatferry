# Contributing to ChatFerry

## Prerequisites

- Node.js 20+
- A paid ChatGPT or Claude account (free tiers hit rate limits quickly)
- A desktop session with a display (headed Chromium is required; headless does not work reliably with these sites)

## Dev Setup

```bash
git clone https://github.com/YOUR_USER/chatferry.git
cd chatferry
npm install
npx playwright install chromium
npm run build
npm test
```

## How Selectors Work

Each provider has a YAML file in `selectors/` (e.g., `selectors/chatgpt.yaml`). These files define the DOM selectors ChatFerry uses to interact with the provider's web UI.

A selector entry has a `primary` selector and optional `fallbacks`:

```yaml
selectors:
  input:
    description: "Main prompt input"
    primary: "#prompt-textarea"
    fallbacks:
      - 'textarea[data-id="root"]'
```

`src/config.ts` loads these YAML files at runtime via `loadProviderConfig()`. The `selectorCandidates()` helper returns `[primary, ...fallbacks]` so provider code tries selectors in priority order and degrades gracefully when UIs change.

## Adding a New Provider

1. Create `selectors/foo.yaml` with the provider name, home URL, and all required selector entries (see `selectors/chatgpt.yaml` for the full list of selector names).
2. Create `src/providers/foo.ts` with a class that extends `BaseProvider` from `src/providers/base.ts`. Implement all abstract methods (`gotoHome`, `isLoggedIn`, `listModels`, `selectModel`, `startNewChat`, `focusInput`, `submitPrompt`, `getLatestResponseHtml`, `getCurrentModel`).
3. Register the provider in `src/service.ts` inside `buildProvider()` and, if applicable, `providerFromConversationUrl()`.
4. Add the provider name to the `ProviderName` type in `src/types.ts`.

## Updating Selectors

When a provider's UI changes and selectors break:

1. Open the provider site in DevTools, find the new selector.
2. Add the new selector as the `primary` and demote the old one to `fallbacks`.
3. Run the relevant tests to verify.

## Running Tests

```bash
npm test
```

Tests use the Node.js built-in test runner (`node --test`). No extra test dependencies are needed. The build step runs automatically before tests.

## PR Process

1. Fork the repo and create a feature branch.
2. Make your changes.
3. Run `npm run build` and `npm test` and confirm they pass.
4. Submit a pull request against `main` with a clear description of what changed and why.

Keep PRs focused on one change. If you are fixing selectors and adding a feature, send separate PRs.
