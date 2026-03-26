import type { Locator, Page } from "playwright";

export type ProviderName = "chatgpt" | "claude";

export interface SelectorEntry {
  description: string;
  primary: string;
  fallbacks?: string[];
}

export interface ProviderSelectorConfig {
  version: number;
  provider: ProviderName;
  url: string;
  selectors: Record<string, SelectorEntry>;
}

export interface ModelOption {
  label: string;
  rawText: string;
  selected: boolean;
}

export interface ModelInput {
  id: string;
  label: string;
  selected: boolean;
  family: string;
  familyId: string;
  effort: string | null;
  effortId: string | null;
}

export interface ProviderModelCatalog {
  provider: ProviderName;
  current: ModelInfo | null;
  inputs: ModelInput[];
}

export interface ModelInfo {
  label: string | null;
  family: string | null;
  familyId: string | null;
  effort: string | null;
  effortId: string | null;
}

export interface PromptSubmission {
  baselineResponseCount: number;
  conversationUrlBeforeSend: string;
}

export interface ConversationTurn {
  role: "user" | "assistant";
  html: string;
  markdown?: string;
  artifacts?: ConversationArtifact[];
}

export interface ConversationArtifact {
  filename: string;
  content: string;
  savedPath?: string;
}

export interface ProviderAdapter {
  readonly name: ProviderName;
  readonly config: ProviderSelectorConfig;
  gotoHome(page: Page): Promise<void>;
  isLoggedIn(page: Page): Promise<boolean>;
  listModels(page: Page): Promise<ProviderModelCatalog>;
  selectModel(page: Page, requestedModel: string): Promise<ModelInfo>;
  startNewChat(page: Page): Promise<void>;
  focusInput(page: Page): Promise<Locator>;
  submitPrompt(page: Page, prompt: string): Promise<PromptSubmission>;
  getLatestResponseMarkdown(page: Page): Promise<string | null>;
  getLatestResponseHtml(page: Page): Promise<string>;
  getCurrentModel(page: Page): Promise<ModelInfo | null>;
  getCurrentModelLabel(page: Page): Promise<string | null>;
  prepareConversationForRead(page: Page): Promise<void>;
  extractConversation(page: Page): Promise<ConversationTurn[]>;
}
