import { createHash } from "node:crypto";
import path from "node:path";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import type { ConversationArtifact, ConversationTurn, ModelInfo, ProviderName } from "./types.js";
import { slugify, uniqueTimestampSlug } from "./utils.js";

const turndown = new TurndownService({
  codeBlockStyle: "fenced",
  headingStyle: "atx",
});

turndown.use(gfm);

function extractTextWithBreaks(node: Node): string {
  if (node.nodeType === node.TEXT_NODE) {
    return node.nodeValue ?? "";
  }

  if (node.nodeType !== node.ELEMENT_NODE) {
    return "";
  }

  const element = node as HTMLElement;
  if (element.tagName === "BR") {
    return "\n";
  }

  return Array.from(element.childNodes)
    .map((childNode) => extractTextWithBreaks(childNode))
    .join("");
}

function inferCodeLanguage(label: string): string {
  const normalized = label.trim().toLowerCase();
  const aliases: Record<string, string> = {
    bash: "bash",
    console: "bash",
    javascript: "javascript",
    js: "javascript",
    json: "json",
    python: "python",
    sh: "bash",
    shell: "bash",
    sql: "sql",
    text: "text",
    ts: "typescript",
    typescript: "typescript",
    yaml: "yaml",
    yml: "yaml",
  };

  return aliases[normalized] ?? "";
}

function findCodeBlockLanguage(node: HTMLElement): string {
  const explicitCode = node.querySelector("code[class*='language-'], code[class*='lang-']");
  const className = explicitCode?.getAttribute("class") ?? "";
  const match = className.match(/lang(?:uage)?-([A-Za-z0-9_-]+)/);
  if (match?.[1]) {
    return match[1];
  }

  const candidates = Array.from(node.querySelectorAll("div, span"))
    .map((element) => element.textContent?.trim() ?? "")
    .filter((text) => text.length > 0 && text.length <= 32);

  for (const candidate of candidates) {
    const language = inferCodeLanguage(candidate);
    if (language) {
      return language;
    }
  }

  return "";
}

turndown.addRule("fencedCodeBlock", {
  filter: (node) => node.nodeName === "PRE",
  replacement: (_content, node) => {
    const preNode = node as HTMLElement;
    const codeNode = preNode.querySelector("code");
    const explicitLanguage = findCodeBlockLanguage(preNode);

    if (codeNode && codeNode.parentElement?.tagName === "PRE") {
      const code = codeNode.textContent?.replace(/\n$/, "") ?? "";
      return `\n\n\`\`\`${explicitLanguage}\n${code}\n\`\`\`\n\n`;
    }

    const codeViewerNode = preNode.querySelector(".cm-content");
    if (codeViewerNode) {
      const code = extractTextWithBreaks(codeViewerNode)
        .replace(/\u00a0/g, " ")
        .replace(/\r\n/g, "\n")
        .trimEnd();
      return `\n\n\`\`\`${explicitLanguage}\n${code}\n\`\`\`\n\n`;
    }

    const rawText = extractTextWithBreaks(preNode)
      .replace(/\u00a0/g, " ")
      .replace(/\r\n/g, "\n")
      .trim();
    const lines = rawText.split("\n");
    const firstLine = lines[0]?.trim() ?? "";
    const inferredLanguage = explicitLanguage || inferCodeLanguage(firstLine);
    const language = inferredLanguage;
    const codeLines = inferredLanguage ? lines.slice(1) : lines;
    const code = codeLines.join("\n").replace(/\n$/, "").trimEnd();
    return `\n\n\`\`\`${language}\n${code}\n\`\`\`\n\n`;
  },
});

export function htmlToMarkdown(html: string): string {
  return `${turndown.turndown(html).trim()}\n`;
}

export function buildMarkdownDocument(args: {
  provider: ProviderName;
  model: ModelInfo | null;
  prompt: string;
  body: string;
  chatUrl?: string | null;
}): string {
  const timestamp = new Date().toISOString();
  const model = (args.model?.label ?? "unknown").replace(/\s+/g, " ").trim();
  const modelFamily = args.model?.family?.replace(/\s+/g, " ").trim() ?? null;
  const modelEffort = args.model?.effort?.replace(/\s+/g, " ").trim() ?? null;
  return [
    "---",
    `provider: ${args.provider}`,
    `model: ${JSON.stringify(model)}`,
    ...(modelFamily ? [`model_family: ${JSON.stringify(modelFamily)}`] : []),
    ...(modelEffort ? [`model_effort: ${JSON.stringify(modelEffort)}`] : []),
    `timestamp: ${timestamp}`,
    ...(args.chatUrl ? [`chat_url: ${JSON.stringify(args.chatUrl)}`] : []),
    "---",
    "",
    "# Prompt",
    "",
    args.prompt.trim(),
    "",
    "# Response",
    "",
    args.body.trim(),
    "",
  ].join("\n");
}

export interface PromptResponseSidecar {
  version: 1;
  kind: "prompt_response";
  provider: ProviderName;
  exportedAt: string;
  markdownPath: string;
  chatUrl: string | null;
  markdownSource: "provider_markdown" | "html_to_markdown";
  model: ModelInfo | null;
  prompt: string;
  response: string;
  promptHash: string;
  responseHash: string;
}

export interface ConversationSidecar {
  version: 1;
  kind: "conversation";
  provider: ProviderName;
  exportedAt: string;
  markdownPath: string;
  chatUrl: string;
  turns: number;
  artifacts: number;
  artifactDir: string | null;
  turnHashes: string[];
}

export type ConversationExportSidecar = PromptResponseSidecar | ConversationSidecar;

function contentHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sidecarPathForOutput(outputPath: string): string {
  const parsed = path.parse(outputPath);
  return path.join(parsed.dir, `${parsed.name}.meta.json`);
}

export function buildPromptResponseSidecar(args: {
  provider: ProviderName;
  outputPath: string;
  model: ModelInfo | null;
  prompt: string;
  response: string;
  chatUrl?: string | null;
  markdownSource: "provider_markdown" | "html_to_markdown";
}): PromptResponseSidecar {
  return {
    version: 1,
    kind: "prompt_response",
    provider: args.provider,
    exportedAt: new Date().toISOString(),
    markdownPath: path.basename(args.outputPath),
    chatUrl: args.chatUrl ?? null,
    markdownSource: args.markdownSource,
    model: args.model,
    prompt: args.prompt,
    response: args.response,
    promptHash: contentHash(args.prompt),
    responseHash: contentHash(args.response),
  };
}

function turnToMarkdown(turn: ConversationTurn): string | null {
  if (turn.markdown?.trim()) {
    return turn.markdown.trim();
  }
  if (turn.html.trim()) {
    return htmlToMarkdown(turn.html).trim();
  }
  return null;
}

export function buildConversationDocument(args: {
  provider: ProviderName;
  chatUrl: string;
  turns: ConversationTurn[];
  artifactDir?: string | null;
}): string {
  const capturedAt = new Date().toISOString();
  const artifactCount = args.turns.reduce((count, turn) => count + (turn.artifacts?.length ?? 0), 0);
  const sections = args.turns
    .map((turn) => {
      const markdown = turnToMarkdown(turn);
      if (!markdown) {
        return null;
      }
      const artifactNotes = (turn.artifacts ?? [])
        .map((artifact) => artifact.savedPath)
        .filter((savedPath): savedPath is string => Boolean(savedPath))
        .map((savedPath) => `> Artifact saved: ${savedPath}`);
      return [
        `## ${turn.role === "user" ? "User" : "Assistant"}`,
        "",
        ...artifactNotes,
        ...(artifactNotes.length > 0 ? [""] : []),
        markdown,
        "",
      ].join("\n");
    })
    .filter((section): section is string => section !== null);

  return [
    "---",
    `provider: ${args.provider}`,
    `chat_url: ${JSON.stringify(args.chatUrl)}`,
    `captured_at: ${capturedAt}`,
    `turns: ${sections.length}`,
    `artifacts: ${artifactCount}`,
    ...(args.artifactDir ? [`artifact_dir: ${JSON.stringify(args.artifactDir)}`] : []),
    "---",
    "",
    ...sections,
  ].join("\n");
}

export function buildConversationSidecar(args: {
  provider: ProviderName;
  outputPath: string;
  chatUrl: string;
  turns: ConversationTurn[];
  artifactDir?: string | null;
}): ConversationSidecar {
  return {
    version: 1,
    kind: "conversation",
    provider: args.provider,
    exportedAt: new Date().toISOString(),
    markdownPath: path.basename(args.outputPath),
    chatUrl: args.chatUrl,
    turns: args.turns.length,
    artifacts: args.turns.reduce((count, turn) => count + (turn.artifacts?.length ?? 0), 0),
    artifactDir: args.artifactDir ?? null,
    turnHashes: args.turns.map((turn) => contentHash(`${turn.role}\n${turn.markdown ?? turn.html}`)),
  };
}

export function defaultOutputPath(provider: ProviderName, prompt: string): string {
  return path.join(
    process.cwd(),
    `${uniqueTimestampSlug()}-${slugify(prompt)}.md`,
  );
}

export function defaultReadOutputPath(provider: ProviderName): string {
  return path.join(process.cwd(), `read-${provider}-${uniqueTimestampSlug()}.md`);
}

export function artifactDirectoryForOutput(outputPath: string): string {
  const parsed = path.parse(outputPath);
  return path.join(parsed.dir, `${parsed.name}.artifacts`);
}

export function artifactFileName(
  turnIndex: number,
  artifactIndex: number,
  artifact: ConversationArtifact,
): string {
  const parsed = path.parse(artifact.filename || `artifact-${artifactIndex + 1}.md`);
  const extension = parsed.ext || ".md";
  const baseName = slugify(parsed.name || `artifact-${artifactIndex + 1}`);
  return `${String(turnIndex + 1).padStart(2, "0")}-${String(artifactIndex + 1).padStart(2, "0")}-${baseName}${extension}`;
}
