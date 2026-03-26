/**
 * Centralized timing constants.
 *
 * Every delay, timeout, and poll interval in the codebase references this file.
 * Grouped by purpose so tuning is deliberate, not a grep-and-pray exercise.
 */

// ---------------------------------------------------------------------------
// Navigation & page load
// ---------------------------------------------------------------------------

/** After goto(), wait for composer or login indicators to appear. */
export const WAIT_FOR_COMPOSER_MS = 8_000;

/** Between navigation retry attempts on ERR_ABORTED. */
export const NAV_RETRY_PAUSE_MS = 1_500;

/** Timeout for a single page.goto() call. */
export const NAV_TIMEOUT_MS = 60_000;

/** Timeout for page.goto() on conversation URLs (read/reload). */
export const CONVERSATION_NAV_TIMEOUT_MS = 120_000;

/** After navigating to a conversation URL, let the page settle before scraping. */
export const CONVERSATION_SETTLE_MS = 8_000;

// ---------------------------------------------------------------------------
// Login detection
// ---------------------------------------------------------------------------

/** Timeout for the isLoggedIn polling loop. */
export const LOGIN_CHECK_TIMEOUT_MS = 5_000;

/** Poll interval inside isLoggedIn. */
export const LOGIN_CHECK_POLL_MS = 250;

/** Poll interval inside waitForComposerOrLogin. */
export const COMPOSER_POLL_MS = 200;

/** Between login reminder lines printed to stdout. */
export const LOGIN_REMINDER_INTERVAL_MS = 15_000;

/** Poll interval while waiting for user to complete login. */
export const LOGIN_WAIT_POLL_MS = 1_500;

// ---------------------------------------------------------------------------
// Model selection (human-like pacing)
// ---------------------------------------------------------------------------

/** After clicking the model picker, wait for the dropdown to render. */
export const MODEL_PICKER_OPEN_MS = 1_000;

/** After clicking the effort/mode picker, wait for options to render. */
export const EFFORT_PICKER_OPEN_MS = 750;

/** After selecting a top-level model family, wait for UI to settle. */
export const MODEL_FAMILY_SETTLE_MS = 1_250;

/** After selecting an effort/mode option, wait for UI to settle. */
export const EFFORT_OPTION_SETTLE_MS = 750;

/** After model selection is done, brief pause before verification. */
export const MODEL_VERIFY_PAUSE_MS = 300;

/** Claude: after clicking a model option, wait for menu to settle. */
export const CLAUDE_MODEL_SETTLE_MS = 1_250;

/** Claude: after toggling extended thinking, wait for state change. */
export const CLAUDE_THINKING_TOGGLE_MS = 750;

/** Claude: brief pause after Escape to dismiss picker. */
export const CLAUDE_PICKER_DISMISS_MS = 300;

/** Claude: after opening the model picker, wait for menu items. */
export const CLAUDE_PICKER_OPEN_MS = 1_000;

// ---------------------------------------------------------------------------
// getCurrentModel passive/active polling
// ---------------------------------------------------------------------------

/** Timeout for passive getCurrentModel polling (fast path, no menu interaction). */
export const CURRENT_MODEL_PASSIVE_TIMEOUT_MS = 1_500;

/** Poll interval for passive getCurrentModel. */
export const CURRENT_MODEL_PASSIVE_POLL_MS = 150;

/** Timeout for active getCurrentModel (opens menus if passive fails). */
export const CURRENT_MODEL_ACTIVE_TIMEOUT_MS = 5_000;

/** Poll interval for active getCurrentModel. */
export const CURRENT_MODEL_ACTIVE_POLL_MS = 250;

// ---------------------------------------------------------------------------
// Prompt submission (human-like pacing)
// ---------------------------------------------------------------------------

/** Pause before typing the prompt (human would read the page). */
export const PRE_TYPE_PAUSE = { min: 200, max: 450 } as const;

/** Pause after typing, before clicking send (human would review). */
export const PRE_SEND_PAUSE = { min: 120, max: 260 } as const;

/** After fill/insertText, brief settle for contenteditable to update. */
export const PROMPT_INSERT_SETTLE_MS = 150;

/** After clipboard paste (large prompt), wait for contenteditable. */
export const CLIPBOARD_PASTE_SETTLE_MS = 500;

/** After keyboard.insertText (large prompt), wait for contenteditable. */
export const INSERT_TEXT_SETTLE_MS = 800;

/** After fill (large prompt fallback), wait for contenteditable. */
export const FILL_SETTLE_MS = 500;

/** Between Cmd+a/Backspace steps in large prompt clearing. */
export const CLEAR_EDITOR_PAUSE_MS = 100;

/** Between keystrokes in the clear-then-paste flow. */
export const KEYSTROKE_PAUSE_MS = 50;

// ---------------------------------------------------------------------------
// Completion detection
// ---------------------------------------------------------------------------

/** Poll interval inside waitForCompletion. */
export const COMPLETION_POLL_MS = 1_000;

/** After completion is detected, brief settle before capturing. */
export const COMPLETION_SETTLE_MS = 1_000;

/** Poll interval inside waitForSubmissionAcceptance. */
export const ACCEPTANCE_POLL_MS = 500;

// ---------------------------------------------------------------------------
// Conversation read/scroll
// ---------------------------------------------------------------------------

/** After scrolling, wait for lazy-loaded content to render. */
export const SCROLL_MOVED_SETTLE_MS = 1_250;

/** After scrolling (didn't move), brief pause before next check. */
export const SCROLL_IDLE_SETTLE_MS = 750;

/** Poll interval in the post-scroll settled-signature check. */
export const SCROLL_SETTLED_POLL_MS = 1_000;

/** Max passes in the scroll loop. */
export const SCROLL_MAX_PASSES = 24;

/** Max passes in the post-scroll settled check. */
export const SETTLED_MAX_PASSES = 6;

// ---------------------------------------------------------------------------
// Selector wait / retry
// ---------------------------------------------------------------------------

/** Poll interval inside waitForAttachedNamedLocator. */
export const ATTACHED_LOCATOR_POLL_MS = 500;

/** Default timeout for waitForAttachedNamedLocator. */
export const ATTACHED_LOCATOR_TIMEOUT_MS = 20_000;

/** Claude: timeout for waiting for conversation messages in latestAssistantTurn. */
export const CLAUDE_MESSAGES_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Browser lifecycle
// ---------------------------------------------------------------------------

/** Timeout for context.close() before force-killing. */
export const CONTEXT_CLOSE_TIMEOUT_MS = 5_000;

/** Timeout for browser.close() after context close failed. */
export const BROWSER_CLOSE_TIMEOUT_MS = 3_000;

/** After startNewChat click, wait for composer to reappear. */
export const NEW_CHAT_SETTLE_MS = 3_000;

// ---------------------------------------------------------------------------
// Soak test
// ---------------------------------------------------------------------------

/** Minimum cooldown between soak prompts for the same provider. */
export const SOAK_INTER_PROMPT_COOLDOWN_MS = 30_000;

// ---------------------------------------------------------------------------
// Daemon lifecycle
// ---------------------------------------------------------------------------

/** Browser file lock stale timeout. */
export const BROWSER_LOCK_STALE_MS = 12 * 60 * 60 * 1_000;

/** Browser file lock acquisition timeout. */
export const BROWSER_LOCK_TIMEOUT_MS = 30 * 60 * 1_000;

/** Daemon launch lock stale timeout. */
export const DAEMON_LAUNCH_LOCK_STALE_MS = 30_000;

/** Daemon launch lock acquisition timeout. */
export const DAEMON_LAUNCH_LOCK_TIMEOUT_MS = 20_000;

/** Wait for daemon to become healthy after spawning. */
export const DAEMON_STARTUP_TIMEOUT_MS = 15_000;

/** Grace period for SIGTERM before SIGKILL. */
export const DAEMON_SIGTERM_GRACE_MS = 5_000;

/** Grace period after SIGKILL. */
export const DAEMON_SIGKILL_GRACE_MS = 2_000;

/** Run lock stale and acquisition timeout. */
export const RUN_LOCK_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Provider-specific
// ---------------------------------------------------------------------------

/** Claude: focus input retry pause after Escape. */
export const CLAUDE_FOCUS_RETRY_MS = 300;

/** Download timeout for Claude artifact downloads. */
export const ARTIFACT_DOWNLOAD_TIMEOUT_MS = 15_000;
