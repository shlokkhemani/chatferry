import type { Page } from "playwright";
import type { ProviderName } from "./types.js";

const FAILURE_PATTERNS: Record<ProviderName, RegExp[]> = {
  chatgpt: [/something went wrong/i, /there was an error/i],
  claude: [/could not be fully generated/i, /something went wrong/i],
};

export async function hasTransientFailure(page: Page, provider: ProviderName): Promise<boolean> {
  for (const pattern of FAILURE_PATTERNS[provider]) {
    const locator = page.getByText(pattern).last();
    if (await locator.isVisible().catch(() => false)) {
      return true;
    }
  }

  return false;
}
