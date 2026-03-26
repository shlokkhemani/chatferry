import { execSync } from "node:child_process";
import type { Locator, Page } from "playwright";
import {
  CLEAR_EDITOR_PAUSE_MS,
  KEYSTROKE_PAUSE_MS,
  CLIPBOARD_PASTE_SETTLE_MS,
  INSERT_TEXT_SETTLE_MS,
  FILL_SETTLE_MS,
} from "./timing.js";
import { sleep } from "./utils.js";

const MOD = process.platform === "darwin" ? "Meta" : "Control";

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export async function humanPause(minMs: number, maxMs: number): Promise<void> {
  await sleep(randomInt(minMs, maxMs));
}

export function semanticPromptLines(text: string): string[] {
  return text
    .replace(/\u00a0/g, " ")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/g, ""))
    .filter((line) => line.length > 0);
}

async function readEditorText(locator: Locator): Promise<string> {
  return locator.evaluate((element) => {
    const candidate = element as HTMLElement & { value?: string };
    if (typeof candidate.value === "string") {
      return candidate.value;
    }
    return candidate.innerText || candidate.textContent || "";
  });
}

export function promptMatchesEditor(actual: string, expected: string): boolean {
  const actualLines = semanticPromptLines(actual);
  const expectedLines = semanticPromptLines(expected);
  if (actualLines.length !== expectedLines.length) {
    return false;
  }

  return expectedLines.every((line, index) => line === actualLines[index]);
}

/**
 * Lenient length-based verification for large prompts.
 * Exact line-by-line comparison is brittle for large contenteditable content
 * where whitespace normalization differs between insertion methods.
 */
function promptLengthIsClose(actual: string, expected: string): boolean {
  const actualLen = actual.replace(/\s+/g, " ").trim().length;
  const expectedLen = expected.replace(/\s+/g, " ").trim().length;
  if (expectedLen === 0) {
    return actualLen === 0;
  }
  return actualLen >= expectedLen * 0.85 && actualLen <= expectedLen * 1.15;
}

function verifyPrompt(actual: string, expected: string): boolean {
  return promptMatchesEditor(actual, expected) || promptLengthIsClose(actual, expected);
}

/**
 * Insert prompt text into the editor.
 *
 * Short prompts: fill() first (works reliably on both ChatGPT and Claude editors),
 * then clipboard paste as fallback.
 *
 * Long prompts (>5KB): clipboard paste first (fill/insertText freeze ChatGPT's
 * contenteditable for long text), then insertText, then fill as last resort.
 */
export async function insertPromptText(page: Page, locator: Locator, text: string): Promise<void> {
  const strategies = text.length > 5_000
    ? [clipboardPaste, insertText, fill]
    : [fill, insertText, clipboardPaste];

  for (const strategy of strategies) {
    const success = await strategy(page, locator, text);
    if (success) {
      return;
    }
  }

  throw new Error(
    "Prompt insertion failed after all strategies (fill, insertText, clipboard paste).",
  );
}

async function fill(_page: Page, locator: Locator, text: string): Promise<boolean> {
  try {
    await locator.click({ timeout: 5_000 });
    await locator.fill(text);
    await sleep(FILL_SETTLE_MS);
    const observed = await readEditorText(locator).catch(() => "");
    return verifyPrompt(observed, text);
  } catch {
    return false;
  }
}

async function insertText(page: Page, locator: Locator, text: string): Promise<boolean> {
  try {
    await locator.click({ timeout: 5_000 }).catch(() => undefined);
    await page.keyboard.press(`${MOD}+a`).catch(() => undefined);
    await page.keyboard.press("Backspace").catch(() => undefined);
    await sleep(CLEAR_EDITOR_PAUSE_MS);
    await page.keyboard.insertText(text);
    await sleep(INSERT_TEXT_SETTLE_MS);
    const observed = await readEditorText(locator).catch(() => "");
    return verifyPrompt(observed, text);
  } catch {
    return false;
  }
}

function copyToClipboard(text: string): void {
  const cmd = process.platform === "darwin" ? "pbcopy"
    : process.platform === "win32" ? "clip"
    : "xclip -selection clipboard";
  execSync(cmd, { input: text, encoding: "utf-8", timeout: 5_000 });
}

async function clipboardPaste(page: Page, locator: Locator, text: string): Promise<boolean> {
  try {
    copyToClipboard(text);
    await locator.click();
    await sleep(CLEAR_EDITOR_PAUSE_MS);
    await page.keyboard.press(`${MOD}+a`);
    await sleep(KEYSTROKE_PAUSE_MS);
    await page.keyboard.press("Backspace");
    await sleep(CLEAR_EDITOR_PAUSE_MS);
    await page.keyboard.press(`${MOD}+v`);
    await sleep(CLIPBOARD_PASTE_SETTLE_MS);
    const observed = await readEditorText(locator).catch(() => "");
    return verifyPrompt(observed, text);
  } catch {
    return false;
  }
}
