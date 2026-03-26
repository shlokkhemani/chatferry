import path from "node:path";

const RUN_ID_RE = /^run_[a-z0-9-]+_[a-f0-9]{6}$/;

function hasControlChars(value: string): boolean {
  return /[\x00-\x1f\x7f]/.test(value);
}

export function validateRunId(value: string): string {
  if (hasControlChars(value)) {
    throw new Error("run id must not contain control characters");
  }
  const trimmed = value.trim();
  if (!RUN_ID_RE.test(trimmed)) {
    throw new Error(`Invalid run id: ${value}`);
  }
  return trimmed;
}

export function validateCliPath(value: string, field = "path"): string {
  if (hasControlChars(value)) {
    throw new Error(`${field} must not contain control characters`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${field} is empty`);
  }
  const normalized = path.normalize(trimmed);
  const parts = normalized.split(path.sep);
  if (!path.isAbsolute(normalized) && parts.includes("..")) {
    throw new Error(`${field} must not escape the current working directory`);
  }
  return trimmed;
}

export function validateConversationUrl(value: string): string {
  if (hasControlChars(value)) {
    throw new Error("conversation url must not contain control characters");
  }
  const parsed = new URL(value);
  if (!["https:", "http:"].includes(parsed.protocol)) {
    throw new Error("conversation url must use http or https");
  }
  return parsed.toString();
}

export function cliSchema(command?: string): Record<string, unknown> {
  const commands: Record<string, unknown> = {
    setup: {
      interactive: true,
      usage: "chatferry setup [provider]",
      description: "Guided first-run setup for one provider or both providers",
    },
    login: {
      interactive: true,
      usage: "chatferry login <provider>",
      description: "Open a headed browser and auto-detect manual login completion",
    },
    models: {
      interactive: false,
      usage: "chatferry models <provider> [--json]",
      description: "List visible models for a logged-in provider",
    },
    "daemon-status": {
      interactive: false,
      usage: "chatferry daemon-status [provider] [--json]",
      description: "Show whether provider daemons are running",
    },
    ask: {
      interactive: false,
      usage: "chatferry ask <provider> [prompt...] [--file PATH] [--model NAME] [--output PATH] [--no-wait] [--json]",
      description: "Send a prompt and get the markdown export (use --no-wait for async)",
    },
    status: {
      interactive: false,
      usage: "chatferry status <runId> [--json]",
      description: "Inspect the current state of a run",
    },
    wait: {
      interactive: false,
      usage: "chatferry wait <runId> [--timeout N] [--json]",
      description: "Wait for a run to complete",
    },
    result: {
      interactive: false,
      usage: "chatferry result <runId> [--json]",
      description: "Return the output path for a completed run",
    },
    runs: {
      interactive: false,
      usage: "chatferry runs [--provider chatgpt|claude] [--status STATUS] [--limit N] [--json]",
      description: "List recent runs",
    },
    cancel: {
      interactive: false,
      usage: "chatferry cancel <runId> [--json]",
      description: "Cancel a queued or in-flight run",
    },
    read: {
      interactive: false,
      usage: "chatferry read <url> [--output PATH] [--json]",
      description: "Extract a full multi-turn conversation from a private Claude or ChatGPT URL",
    },
    reload: {
      interactive: false,
      usage: "chatferry reload <source> [--output PATH] [--json]",
      description: "Reopen a saved chat URL from an existing markdown export and refresh that export",
    },
  };

  const payload: Record<string, unknown> = {
    cli: "chatferry",
    description: "Browser automation CLI for ChatGPT and Claude with durable runs",
    default_exit_codes: {
      0: "success",
      1: "invalid input or safe branch condition",
      2: "error",
    },
    runtime_contract: ["json_output", "stable_exit_codes", "input_hardening"],
    introspection_usage: "chatferry schema [command] [--json]",
    commands,
  };

  if (command) {
    const detail = commands[command];
    if (!detail) {
      return {
        cli: "chatferry",
        status: "invalid_command",
        error: `Unknown command: ${command}`,
        known: Object.keys(commands),
      };
    }
    return {
      cli: "chatferry",
      default_exit_codes: payload.default_exit_codes,
      command,
      details: detail,
    };
  }

  return payload;
}

export function jsonErrorPayload(message: string): string {
  return `${JSON.stringify({ error: message }, null, 2)}\n`;
}
