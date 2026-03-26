import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { ProviderName, ProviderSelectorConfig, SelectorEntry } from "./types.js";
import { PROJECT_ROOT } from "./utils.js";

export async function loadProviderConfig(provider: ProviderName): Promise<ProviderSelectorConfig> {
  const filePath = path.join(PROJECT_ROOT, "selectors", `${provider}.yaml`);
  const source = await fs.readFile(filePath, "utf8");
  const parsed = YAML.parse(source) as ProviderSelectorConfig;
  if (!parsed || parsed.provider !== provider) {
    throw new Error(`Invalid selector config for ${provider}`);
  }
  return parsed;
}

export function selectorCandidates(entry: SelectorEntry): string[] {
  return [entry.primary, ...(entry.fallbacks ?? [])];
}
