import fs from "node:fs/promises";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { BROWSER_CLOSE_TIMEOUT_MS, BROWSER_LOCK_STALE_MS, BROWSER_LOCK_TIMEOUT_MS, CONTEXT_CLOSE_TIMEOUT_MS } from "./timing.js";
import { DATA_ROOT, acquireFileLock, ensureDir, sleep } from "./utils.js";

const PROFILE_ROOT = path.join(DATA_ROOT, "profiles");
const LOCK_ROOT = path.join(PROFILE_ROOT, ".locks");
const SHARED_PROFILE = path.join(PROFILE_ROOT, "shared");

let sharedContext: BrowserContext | null = null;

async function migrateToSharedProfile(): Promise<void> {
  const sharedExists = await fs.stat(SHARED_PROFILE).then(() => true).catch(() => false);
  if (sharedExists) {
    return;
  }

  for (const legacy of ["chatgpt", "claude"]) {
    const legacyDir = path.join(PROFILE_ROOT, legacy);
    const exists = await fs.stat(legacyDir).then(() => true).catch(() => false);
    if (exists) {
      try {
        await fs.cp(legacyDir, SHARED_PROFILE, { recursive: true });
        console.error(`Migrated ${legacy} browser profile to shared. You may need to re-login to other providers.`);
        return;
      } catch (error) {
        // Clean up partial copy
        await fs.rm(SHARED_PROFILE, { recursive: true, force: true }).catch(() => undefined);
        console.error(`Failed to migrate ${legacy} profile: ${error instanceof Error ? error.message : error}`);
      }
    }
  }
}

async function launchContext(
  profileDir: string,
  channel?: "chrome",
): Promise<BrowserContext> {
  return chromium.launchPersistentContext(profileDir, {
    ...(channel ? { channel } : {}),
    headless: false,
    viewport: { width: 1440, height: 900 },
    args: ["--disable-blink-features=AutomationControlled"],
  });
}

export async function getSharedContext(): Promise<BrowserContext> {
  if (sharedContext) {
    try {
      sharedContext.pages();
      return sharedContext;
    } catch {
      sharedContext = null;
    }
  }

  await migrateToSharedProfile();
  await ensureDir(SHARED_PROFILE);

  try {
    sharedContext = await launchContext(SHARED_PROFILE, "chrome");
  } catch {
    sharedContext = await launchContext(SHARED_PROFILE);
  }

  // Close any startup-restored pages (Chromium may restore last session)
  for (const page of sharedContext.pages()) {
    if (!page.isClosed()) {
      await page.close({ runBeforeUnload: false }).catch(() => undefined);
    }
  }

  return sharedContext;
}

/**
 * Returns a new page (tab) in the shared browser.
 * The browser launches on first call and is reused across providers.
 * Callers that only need a page should use this — it does not expose the shared context.
 */
export async function launchPage(): Promise<Page> {
  const context = await getSharedContext();
  return context.newPage();
}


/**
 * Close the shared browser and release its resources.
 * Call this when the process is done with all browser work.
 */
export async function closeBrowser(): Promise<void> {
  if (!sharedContext) {
    return;
  }
  const context = sharedContext;
  sharedContext = null;

  const browser = context.browser();
  const closedContext = await Promise.race([
    context.close().then(() => true).catch(() => true),
    sleep(CONTEXT_CLOSE_TIMEOUT_MS).then(() => false),
  ]);
  if (closedContext) {
    return;
  }

  for (const page of context.pages()) {
    await page.close({ runBeforeUnload: false }).catch(() => undefined);
  }

  if (!browser) {
    return;
  }

  const closedBrowser = await Promise.race([
    browser.close().then(() => true).catch(() => true),
    sleep(BROWSER_CLOSE_TIMEOUT_MS).then(() => false),
  ]);
  if (closedBrowser) {
    return;
  }

  const browserProcess = (browser as unknown as { process?: () => { kill: (signal: string) => void } | null }).process?.();
  browserProcess?.kill("SIGKILL");
}

let browserLockHeld = false;

/**
 * Acquire exclusive access to the shared browser.
 * Reentrant within the same process.
 */
export async function withBrowserLock<T>(
  fn: () => Promise<T>,
  timeoutMs?: number,
): Promise<T> {
  if (browserLockHeld) {
    return fn();
  }

  await ensureDir(LOCK_ROOT);
  const lockPath = path.join(LOCK_ROOT, "browser.lock");
  const release = await acquireFileLock(lockPath, {
    staleMs: BROWSER_LOCK_STALE_MS,
    timeoutMs: timeoutMs ?? BROWSER_LOCK_TIMEOUT_MS,
    pollMs: 1_000,
  });
  let released = false;
  const safeRelease = async () => {
    if (released) {
      return;
    }
    released = true;
    browserLockHeld = false;
    await release();
  };
  const handleSignal = (signal: NodeJS.Signals) => {
    void safeRelease().finally(() => {
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  };

  browserLockHeld = true;
  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);
  process.once("SIGHUP", handleSignal);
  try {
    return await fn();
  } finally {
    process.removeListener("SIGINT", handleSignal);
    process.removeListener("SIGTERM", handleSignal);
    process.removeListener("SIGHUP", handleSignal);
    await safeRelease();
  }
}

