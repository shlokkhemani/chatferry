import { randomBytes } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Locator, Page } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function findProjectRoot(startDir: string): string {
  let dir = startDir;
  while (!fs.existsSync(path.join(dir, "package.json"))) {
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`Could not find project root from ${startDir}`);
    }
    dir = parent;
  }
  return dir;
}

export const PROJECT_ROOT = findProjectRoot(__dirname);

export const DATA_ROOT = process.env.CHATFERRY_HOME || path.join(os.homedir(), ".chatferry");

export function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

export function pidIsAlive(pid: number | null): boolean {
  if (!pid || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function ensureDir(dirPath: string): Promise<void> {
  await fsPromises.mkdir(dirPath, { recursive: true });
}

export function timestampSlug(date = new Date()): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}-${hh}${min}${ss}`;
}

export function uniqueTimestampSlug(date = new Date()): string {
  return `${timestampSlug(date)}-${randomBytes(3).toString("hex")}`;
}

export function slugify(text: string, maxWords = 6): string {
  return text
    .split(/\s+/)
    .slice(0, maxWords)
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "chat";
}

export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.tmp-${process.pid}-${uniqueTimestampSlug()}`;
  await fsPromises.writeFile(tempPath, content, "utf8");
  await fsPromises.rename(tempPath, filePath);
}

export async function waitForEnter(message: string): Promise<void> {
  process.stdout.write(`${message}\n`);
  process.stdin.resume();
  await new Promise<void>((resolve) => {
    process.stdin.once("data", () => resolve());
  });
}

async function locatorIsVisible(locator: Locator): Promise<boolean> {
  try {
    return await locator.isVisible();
  } catch {
    return false;
  }
}

export interface VisibleSelectorMatch {
  selector: string;
  locator: Locator;
}

export async function firstVisibleLocator(page: Page, selectors: string[]): Promise<VisibleSelectorMatch | null> {
  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      if (await locatorIsVisible(candidate)) {
        return {
          selector,
          locator: candidate,
        };
      }
    }
  }
  return null;
}

export async function firstVisibleSelector(page: Page, selectors: string[]): Promise<string | null> {
  return (await firstVisibleLocator(page, selectors))?.selector ?? null;
}

export async function firstAttachedSelector(page: Page, selectors: string[]): Promise<string | null> {
  for (const selector of selectors) {
    const count = await page.locator(selector).count().catch(() => 0);
    if (count > 0) {
      return selector;
    }
  }
  return null;
}

export async function clickFirstVisible(page: Page, selectors: string[]): Promise<string> {
  const match = await firstVisibleLocator(page, selectors);
  if (!match) {
    throw new Error(`No visible selector matched: ${selectors.join(", ")}`);
  }
  await match.locator.click();
  return match.selector;
}

export async function saveDebugArtifacts(
  page: Page,
  provider: string,
  label: string,
): Promise<{ htmlPath: string; screenshotPath: string }> {
  const debugDir = path.join(DATA_ROOT, "debug");
  await ensureDir(debugDir);
  const prefix = `${timestampSlug()}-${provider}-${label}`;
  const htmlPath = path.join(debugDir, `${prefix}.html`);
  const screenshotPath = path.join(debugDir, `${prefix}.png`);
  await fsPromises.writeFile(htmlPath, await page.content(), "utf8");
  await page.screenshot({ path: screenshotPath, fullPage: true });
  return { htmlPath, screenshotPath };
}

// --- Shared file lock ---

interface FileLockInfo {
  pid: number;
  acquiredAt: string;
}

async function readFileLockInfo(lockPath: string): Promise<FileLockInfo | null> {
  try {
    const source = await fsPromises.readFile(lockPath, "utf8");
    const parsed = JSON.parse(source) as FileLockInfo;
    if (typeof parsed?.pid !== "number" || typeof parsed?.acquiredAt !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function removeFileLockIfStale(lockPath: string, staleMs: number): Promise<boolean> {
  const info = await readFileLockInfo(lockPath);
  if (!info) {
    await fsPromises.unlink(lockPath).catch(() => undefined);
    return true;
  }

  const ageMs = Date.now() - Date.parse(info.acquiredAt);
  if (!pidIsAlive(info.pid) || ageMs > staleMs) {
    await fsPromises.unlink(lockPath).catch(() => undefined);
    return true;
  }

  return false;
}

export async function acquireFileLock(
  lockPath: string,
  options?: { staleMs?: number; timeoutMs?: number; pollMs?: number },
): Promise<() => Promise<void>> {
  const staleMs = options?.staleMs ?? 30_000;
  const timeoutMs = options?.timeoutMs ?? 30_000;
  const pollMs = options?.pollMs ?? 25;
  const startedAt = Date.now();

  await ensureDir(path.dirname(lockPath));

  while (true) {
    try {
      const handle = await fsPromises.open(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
      const payload: FileLockInfo = {
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
      };
      await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
      await handle.close();
      return async () => {
        await fsPromises.unlink(lockPath).catch(() => undefined);
      };
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "";
      if (code !== "EEXIST") {
        throw error;
      }

      const removed = await removeFileLockIfStale(lockPath, staleMs);
      if (removed) {
        continue;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        const info = await readFileLockInfo(lockPath);
        const holder = info ? `pid=${info.pid} since ${info.acquiredAt}` : "unknown holder";
        throw new Error(`Timed out waiting for lock ${lockPath}. Held by ${holder}.`);
      }

      await sleep(pollMs);
    }
  }
}
