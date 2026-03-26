import fs from "node:fs/promises";
import path from "node:path";
import { sidecarPathForOutput, type PromptResponseSidecar } from "./extract.js";
import type { ProviderName } from "./types.js";

export interface SavedChatDocument {
  sourcePath: string;
  metadataPath: string;
  provider: ProviderName;
  model: string | null;
  prompt: string;
  response: string;
  chatUrl: string | null;
}

async function readPromptResponseSidecar(markdownPath: string): Promise<PromptResponseSidecar> {
  const metadataPath = sidecarPathForOutput(markdownPath);
  const source = await fs.readFile(metadataPath, "utf8");
  const parsed = JSON.parse(source) as PromptResponseSidecar;
  if (
    parsed?.version !== 1 ||
    parsed.kind !== "prompt_response" ||
    (parsed.provider !== "chatgpt" && parsed.provider !== "claude") ||
    typeof parsed.prompt !== "string" ||
    typeof parsed.response !== "string"
  ) {
    throw new Error(`Invalid prompt/response sidecar at ${metadataPath}`);
  }
  return parsed;
}

export async function readSavedChatDocument(filePath: string): Promise<SavedChatDocument> {
  const sourcePath = path.resolve(filePath);
  const sidecar = await readPromptResponseSidecar(sourcePath);
  return {
    sourcePath,
    metadataPath: sidecarPathForOutput(sourcePath),
    provider: sidecar.provider,
    model: sidecar.model?.label ?? null,
    prompt: sidecar.prompt,
    response: sidecar.response,
    chatUrl: sidecar.chatUrl,
  };
}
