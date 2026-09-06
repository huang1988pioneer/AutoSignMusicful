import { chromium, firefox } from "playwright";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);
const headed = args.has("--headed") || args.has("--setup");
const setupMode = args.has("--setup");
const exportStateMode = args.has("--export-state");
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const profileArgIndex = rawArgs.findIndex((arg) => arg === "--profile");
const profileArgValue = rawArgs.find((arg) => arg.startsWith("--profile="))?.slice("--profile=".length)
  || (profileArgIndex >= 0 ? rawArgs[profileArgIndex + 1] : "");
const profileName = (profileArgValue || process.env.MUSICFUL_PROFILE_NAME || "").replace(/[^A-Za-z0-9_-]/g, "-");
const browserArgIndex = rawArgs.findIndex((arg) => arg === "--browser");
const browserArgValue = rawArgs.find((arg) => arg.startsWith("--browser="))?.slice("--browser=".length)
  || (browserArgIndex >= 0 ? rawArgs[browserArgIndex + 1] : "");
/** @type {"chrome" | "edge" | "firefox"} */
const browserChoice = normalizeBrowserChoice(browserArgValue || process.env.MUSICFUL_BROWSER || "chrome");
// Keep chrome on the historical profile path; isolate other engines so they never share disk state.
const profileDir = resolveProfileDir(browserChoice, profileName, rootDir);
const logDir = path.join(rootDir, "logs");
const resultDir = process.env.MUSICFUL_RESULT_DIR
  ? path.resolve(process.env.MUSICFUL_RESULT_DIR)
  : path.join(rootDir, "artifacts");
const stateFile = path.join(logDir, "musicful-storage-state.base64");
const numberedStateFile = profileName
  ? path.join(logDir, `musicful-storage-state-${profileName}.base64`)
  : stateFile;
const signInUrl = process.env.MUSICFUL_SIGNIN_URL || "https://tw.musicful.ai/growth-center/";
const fallbackSignInUrl = process.env.MUSICFUL_FALLBACK_SIGNIN_URL || "https://www.musicful.ai/growth-center/";
const chromePathFromEnv = process.env.CHROME_PATH || "";
const edgePathFromEnv = process.env.EDGE_PATH || process.env.MSEDGE_PATH || "";
const firefoxPathFromEnv = process.env.FIREFOX_PATH || "";
const storageStateBase64 = process.env.MUSICFUL_STORAGE_STATE_BASE64 || process.env.MUSICFUL_STORAGE_STATE_BASE64_1;
const storageStateSecretName = process.env.MUSICFUL_ACCOUNT_SECRET_NAME || "MUSICFUL_STORAGE_STATE_BASE64_1";
const accountIndexFromEnv = Number.parseInt(process.env.MUSICFUL_ACCOUNT_INDEX || "", 10);
const accountLabelFromEnv = process.env.MUSICFUL_ACCOUNT_LABEL || "";
const maxAccounts = Number.parseInt(process.env.MUSICFUL_MAX_ACCOUNTS || "115", 10);
const scheduledMode = process.env.MUSICFUL_SCHEDULE_MODE || "all";
const scheduleStartUtc = process.env.MUSICFUL_SCHEDULE_START_UTC || "2026-05-31T05:06:00Z";
const scheduleIntervalMinutes = Number.parseInt(process.env.MUSICFUL_SCHEDULE_INTERVAL_MINUTES || "15", 10);
const exportTimeoutMinutes = Number.parseInt(process.env.MUSICFUL_EXPORT_TIMEOUT_MINUTES || "15", 10);
const rawExportReadyDelaySeconds = Number.parseInt(process.env.MUSICFUL_EXPORT_READY_DELAY_SECONDS || "3", 10);
const exportReadyDelaySeconds = Number.isFinite(rawExportReadyDelaySeconds) && rawExportReadyDelaySeconds >= 0
  ? rawExportReadyDelaySeconds
  : 3;
// Passive renewal: after a successful sign-in, push the cookies the site rotated during
// the visit back into that account's GitHub Secret so the stored state does not age out.
const refreshSecrets = process.env.MUSICFUL_REFRESH_SECRETS === "1" || args.has("--refresh-secrets");
const secretWriteToken = process.env.MUSICFUL_SECRET_WRITE_TOKEN || "";
const secretRepo = process.env.MUSICFUL_SECRET_REPO || process.env.GITHUB_REPOSITORY || "";
const rawMaxSecretBytes = Number.parseInt(process.env.MUSICFUL_MAX_SECRET_BYTES || "48000", 10);
// GitHub rejects an Actions secret larger than 64 KB (65,536 bytes) outright; stay well under
// it by default and skip oversized states instead of failing the write.
const maxSecretBytes = Number.isFinite(rawMaxSecretBytes) && rawMaxSecretBytes > 0 ? rawMaxSecretBytes : 48_000;
const githubSecretLimitBytes = 65_536;

fs.mkdirSync(profileDir, { recursive: true });
fs.mkdirSync(logDir, { recursive: true });
fs.mkdirSync(resultDir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const logFile = path.join(logDir, `musicful-signin-${stamp}.log`);

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  fs.appendFileSync(logFile, `${line}\n`);
}

function extractMetrics(text = "") {
  // Continuous sign-in days (Musicful shows "累計：N 天" / simplified "累计" / "連續簽到").
  const streakDays = text.match(/累[計计]\s*[:：]?\s*(\d+)\s*天/i)?.[1]
    || text.match(/[連连][續续][簽签]到\s*[:：]?\s*(\d+)\s*天?/i)?.[1]
    || text.match(/[連连][續续]\s*[:：]?\s*(\d+)\s*天/i)?.[1]
    || text.match(/streak\s*[:：]?\s*(\d+)\s*(?:day|days)?/i)?.[1]
    || null;
  const growthPoints = text.match(/已獲得成長積分\s*(\d+)/i)?.[1]
    || text.match(/積分\s*[:：]\s*(\d+)/i)?.[1]
    || text.match(/growth\s*points?\s*(\d+)/i)?.[1]
    || null;
  const musicPoints = text.match(/(\d+)\s*\/\s*\d+\s*音樂點/i)?.[1]
    || text.match(/(\d+)\s*\/\s*\d+\s*music\s*points?/i)?.[1]
    || null;

  return {
    streakDays: streakDays != null ? Number(streakDays) : null,
    growthPoints: growthPoints != null ? Number(growthPoints) : null,
    musicPoints: musicPoints != null ? Number(musicPoints) : null
  };
}

function resolveAccountMeta(accountName) {
  const indexFromName = accountName.match(/^MUSICFUL_STORAGE_STATE_BASE64_(\d+)$/)?.[1];
  const account = indexFromName
    ? Number.parseInt(indexFromName, 10)
    : (Number.isFinite(accountIndexFromEnv) ? accountIndexFromEnv : null);

  return {
    account,
    label: labelForIndex(account),
    name: accountName
  };
}

function writeSignInResult(result) {
  const payload = {
    account: result.account ?? null,
    label: result.label || null,
    name: result.name || "unknown",
    status: result.status || "unknown",
    message: result.message || "",
    streakDays: result.streakDays ?? null,
    growthPoints: result.growthPoints ?? null,
    musicPoints: result.musicPoints ?? null,
    finishedAt: result.finishedAt || new Date().toISOString(),
    runId: process.env.GITHUB_RUN_ID || null,
    job: process.env.GITHUB_JOB || null
  };

  const fileName = payload.account != null
    ? `signin-result-${payload.account}.json`
    : "signin-result.json";
  const target = path.join(resultDir, fileName);
  // Always also write the canonical name used by CI artifact download.
  const canonical = path.join(resultDir, "signin-result.json");
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  fs.writeFileSync(target, body, "utf8");
  if (target !== canonical) {
    fs.writeFileSync(canonical, body, "utf8");
  }
  const streakLabel = payload.streakDays != null ? `${payload.streakDays} 天` : "—";
  log(
    `Wrote sign-in result: ${path.basename(target)} (${payload.status}); ` +
    `account=${payload.account ?? "—"} streakDays=${streakLabel}`
  );
  return payload;
}

async function visibleText(page) {
  return (await page.locator("body").innerText({ timeout: 10_000 })).replace(/\s+/g, " ");
}

async function visibleCount(locator) {
  const candidates = await locator.all();
  let count = 0;
  for (const candidate of candidates) {
    if (await candidate.isVisible().catch(() => false)) {
      count += 1;
    }
  }
  return count;
}

function logVisibleStatus(accountName, stage, text) {
  const metrics = extractMetrics(text);
  log(
    `[${accountName}] ${stage} status: 連續簽到=${metrics.streakDays ?? "not found"} 天, ` +
    `積分=${metrics.growthPoints ?? "not found"}, 音樂點=${metrics.musicPoints ?? "not found"}.`
  );
}

function logReadableStatus(accountName, stage, text) {
  const metrics = extractMetrics(text);
  log(
    `[${accountName}] ${stage} status: streakDays=${metrics.streakDays ?? "not found"}, ` +
    `growthPoints=${metrics.growthPoints ?? "not found"}, musicPoints=${metrics.musicPoints ?? "not found"}.`
  );
}

async function logPageDiagnostics(page, accountName, stage) {
  const calendarItems = await page.locator(".calendar-box .calendar-item").count().catch(() => 0);
  const luckyDrops = await page.locator(".continuous-check-box .flex-1").count().catch(() => 0);
  const collectAllButtons = await page.locator("button.collect-all-btn").count().catch(() => 0);
  const visibleCalendarItems = await visibleCount(page.locator(".calendar-box .calendar-item")).catch(() => 0);
  const visibleLuckyDrops = await visibleCount(page.locator(".continuous-check-box .flex-1")).catch(() => 0);
  const visibleCollectAllButtons = await visibleCount(page.locator("button.collect-all-btn")).catch(() => 0);
  const text = await visibleText(page).catch(() => "");
  const excerpt = text.slice(0, 420);

  log(`[${accountName}] ${stage} diagnostics: url=${page.url()}, calendarItems=${calendarItems}/${visibleCalendarItems} visible, luckyDrops=${luckyDrops}/${visibleLuckyDrops} visible, collectAllButtons=${collectAllButtons}/${visibleCollectAllButtons} visible.`);
  log(`[${accountName}] ${stage} visible text excerpt: ${excerpt}`);

  return {
    calendarItems,
    luckyDrops,
    collectAllButtons,
    visibleCalendarItems,
    visibleLuckyDrops,
    visibleCollectAllButtons,
    text
  };
}

async function ensureGrowthCenterControls(page, accountName) {
  let diagnostics = await logPageDiagnostics(page, accountName, "Initial page");
  const hasControls = diagnostics.visibleCalendarItems > 0 || diagnostics.visibleLuckyDrops > 0 || diagnostics.visibleCollectAllButtons > 0;
  const looksLoggedOut = textLooksLikeLoginPrompt(diagnostics.text)
    && !/(已獲得成長積分|累計|音樂點|Growth Points|Streak)/i.test(diagnostics.text);
  if ((hasControls && !looksLoggedOut) || signInUrl === fallbackSignInUrl) {
    return diagnostics;
  }

  log(`[${accountName}] Growth Center is not ready on ${signInUrl}; trying fallback ${fallbackSignInUrl}.`);
  await page.goto(fallbackSignInUrl, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
  await dismissBlockingDialogs(page, accountName);
  diagnostics = await logPageDiagnostics(page, accountName, "Fallback page");
  return diagnostics;
}

/** True when page text looks like a login CTA, not logged-in chrome (e.g. 已登入). */
function textLooksLikeLoginPrompt(text = "") {
  if (!text) return false;
  // "登入" is a substring of "已登入" — never treat logged-in labels as a login prompt.
  if (/(已登入|已登录|Logged\s*in|You\s*are\s*signed\s*in)/i.test(text) &&
      !/(請登入|请登录|立即登入|立即登录|會員登入|会员登录|Log\s*In|Sign\s*Up|使用\s*Google\s*繼續|使用\s*Discord\s*繼續|輸入你的信箱)/i.test(text)) {
    return false;
  }

  return new RegExp([
    "Log\\s*In",
    "(?<![a-z])Login(?![a-z])",
    "Sign\\s*Up",
    "請登入",
    "请登录",
    "立即登入",
    "立即登录",
    "會員登入",
    "会员登录",
    // bare 登入/登录 only when not preceded by 已
    "(?<![已])登入",
    "(?<![已])登录",
    "使用\\s*Google\\s*繼續",
    "使用\\s*Discord\\s*繼續",
    "輸入你的信箱"
  ].join("|"), "i").test(text);
}

function isLoggedOutGrowthCenterPage(page, text) {
  const hasLoginPrompt = textLooksLikeLoginPrompt(text);
  const hasAccountStatus = /(已獲得成長積分|簽到點亮|累計\s*[:：]\s*\d+\s*天|\d+\s*\/\s*\d+\s*音樂點|Earned Growth|Growth Points|Streak)/i.test(text);
  const isHomePage = page.url().includes("/home/");
  return hasLoginPrompt && (isHomePage || !hasAccountStatus);
}

function growthCenterLooksReady(diagnostics) {
  const hasControls = diagnostics.visibleCalendarItems > 0
    || diagnostics.visibleLuckyDrops > 0
    || diagnostics.visibleCollectAllButtons > 0;
  const hasStatus = /(已獲得成長積分|簽到點亮|累計\s*[:：]\s*\d+\s*天|\d+\s*\/\s*\d+\s*音樂點|Earned Growth|Growth Points|Streak)/i.test(diagnostics.text || "");
  return hasControls || hasStatus;
}

/**
 * Wait for the user to finish login without touching the page.
 * Previous Node-side locator polling + Escape dismiss looked like infinite refresh.
 * Now: zero Playwright actions until export; optional in-page auto-detect + Enter key.
 */
function createStdinEnterWaiter(promptLine) {
  if (!process.stdin.isTTY) {
    return {
      promise: new Promise(() => {}),
      cancel() {}
    };
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  let settled = false;
  const promise = new Promise((resolve) => {
    log(promptLine);
    rl.question("", () => {
      if (settled) return;
      settled = true;
      resolve("enter");
    });
  });

  return {
    promise,
    cancel() {
      if (settled) return;
      settled = true;
      try {
        rl.close();
      } catch {
        // ignore
      }
    }
  };
}

async function waitForLoggedInGrowthCenter(page, accountName) {
  log(`[${accountName}] Export mode is open. Log in within ${exportTimeoutMinutes} minute(s). Before and after login, a stable Musicful page will switch to Growth Center after 5 seconds.`);

  let navigationCandidate = "";
  let navigationReadyAt = 0;
  let navigationBusy = false;
  let navigationAttempted = false;
  let navigationStopped = false;
  const growthNavigationTimer = setInterval(async () => {
    if (navigationBusy || navigationStopped) return;
    navigationBusy = true;
    try {
      const currentUrl = page.url();
      const url = new URL(currentUrl);
      const onMusicful = url.hostname === "musicful.ai" || url.hostname.endsWith(".musicful.ai");
      if (onMusicful && /\/growth-center\/?$/i.test(url.pathname)) {
        // Re-arm after reaching the center so a later login redirect can return here too.
        navigationAttempted = false;
        navigationCandidate = "";
        return;
      }
      // Leave third-party sign-in and authorization callbacks alone.
      // Musicful's own login page/dialog no longer blocks the initial redirect.
      if (!onMusicful || /oauth|callback/i.test(url.pathname)) {
        navigationCandidate = "";
        return;
      }
      if (navigationAttempted) return;
      if (navigationCandidate !== currentUrl) {
        navigationCandidate = currentUrl;
        navigationReadyAt = Date.now() + 5_000;
        return;
      }
      if (Date.now() < navigationReadyAt || navigationStopped || page.url() !== currentUrl) return;
      navigationAttempted = true;
      log(`[${accountName}] Opening Growth Center after the 5-second wait.`);
      await page.goto(signInUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    } catch (error) {
      navigationCandidate = "";
      if (navigationAttempted && !navigationStopped) {
        log(`[${accountName}] Automatic navigation failed; open Growth Center manually: ${error.message}`);
      }
    } finally {
      navigationBusy = false;
    }
  }, 250);

  let navCount = 0;
  const onNavigated = (frame) => {
    if (frame !== page.mainFrame()) return;
    navigationCandidate = "";
    navCount += 1;
    if (navCount <= 15 || navCount % 10 === 0) {
      log(`[${accountName}] Main-frame navigation #${navCount}: ${page.url()}`);
    }
    if (navCount === 6) {
      log(`[${accountName}] Warning: many full navigations detected (possible reload loop). Use system Chrome if possible, wait until the page is stable, then press Enter.`);
    }
  };
  page.on("framenavigated", onNavigated);

  const enterWaiter = createStdinEnterWaiter(
    `[${accountName}] When the Growth Center shows your account status, press Enter in this terminal to export.`
  );

  let waitSettled = false;
  // In-page check only (no Playwright locator thrashing / focus steal).
  // Require calendar/lucky-drop controls so a logged-out Growth Center shell
  // ("已獲得成長積分 0" + nav 登入) does not auto-export too early.
  const autoReady = page.waitForFunction(() => {
    const text = (document.body && document.body.innerText) || "";
    const hasStatus = /已獲得成長積分\s*\d+|簽到點亮|累計\s*[:：]\s*\d+\s*天|\d+\s*\/\s*\d+\s*音樂點|Earned Growth|Growth Points|Streak/i.test(text);
    if (!hasStatus) return false;

    const hasLoggedInControls = Boolean(
      document.querySelector(".calendar-box .calendar-item, .continuous-check-box .flex-1")
    );
    if (!hasLoggedInControls) return false;

    const loginNodes = document.querySelectorAll(
      "input[type='email'], input[placeholder*='信箱'], .third-login-text"
    );

    for (const el of loginNodes) {
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
        continue;
      }
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return false;
    }
    return true;
  // Playwright takes an optional page-function argument before its options.
  // Pass `undefined` explicitly so this timeout is not mistaken for that
  // argument and replaced by page.setDefaultTimeout(20_000).
  }, undefined, {
    timeout: exportTimeoutMinutes * 60 * 1000,
    polling: 5_000
  }).then(() => "auto").catch((error) => {
    if (waitSettled) return "cancelled";
    throw error;
  });

  let trigger;
  try {
    trigger = await Promise.race([
      autoReady,
      enterWaiter.promise
    ]);
    waitSettled = true;
    // Swallow late settlement from the other racer (avoids unhandled rejection).
    autoReady.catch(() => {});
  } catch (error) {
    waitSettled = true;
    enterWaiter.cancel();
    page.off("framenavigated", onNavigated);
    throw new Error(
      `Could not export Musicful storage state because the Growth Center never showed a logged-in account: ${error.message}`
    );
  } finally {
    waitSettled = true;
    navigationStopped = true;
    clearInterval(growthNavigationTimer);
    enterWaiter.cancel();
    page.off("framenavigated", onNavigated);
  }

  if (trigger === "cancelled") {
    throw new Error("Could not export Musicful storage state because the Growth Center never showed a logged-in account.");
  }

  log(`[${accountName}] Export trigger: ${trigger}${navCount ? ` (main-frame navigations=${navCount})` : ""}.`);
  if (exportReadyDelaySeconds > 0) {
    log(`[${accountName}] Waiting ${exportReadyDelaySeconds} second(s) before reading storage state.`);
    await page.waitForTimeout(exportReadyDelaySeconds * 1000);
  }
  log(`[${accountName}] Exporting storage state (no page interaction).`);
}

async function hasVisibleLoginForm(page) {
  const selectors = [
    "input[type='email']",
    "input[placeholder*='email' i]",
    "input[placeholder*='信箱']",
    ".third-login-text",
    ".el-overlay input[type='email']",
    ".el-overlay input[placeholder*='email' i]",
    ".el-overlay input[placeholder*='信箱']",
    ".el-overlay [class*='login' i] input",
    ".el-overlay .third-login-text"
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) {
      return true;
    }
  }

  return false;
}

async function hasVisibleLoginPrompt(page, text = "") {
  if (textLooksLikeLoginPrompt(text)) {
    return true;
  }
  return hasVisibleLoginForm(page);
}

async function dismissBlockingDialogs(page, accountName) {
  const dialogs = page.locator(".el-overlay-dialog, .pricing-confirm-dialog, [role='dialog'][aria-modal='true']");
  const visibleDialogs = await dialogs.count().catch(() => 0);
  if (visibleDialogs === 0) return false;

  const firstDialog = dialogs.first();
  if (!(await firstDialog.isVisible().catch(() => false))) return false;

  log(`[${accountName}] Dismissing blocking dialog overlay.`);
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(500);

  if (!(await firstDialog.isVisible().catch(() => false))) return true;

  const closeButtons = page.locator([
    ".el-overlay .el-dialog__headerbtn",
    ".el-overlay .el-dialog__close",
    ".el-overlay button[aria-label='Close']",
    ".el-overlay button[title='Close']",
    ".el-overlay [class*='close']"
  ].join(","));

  const count = await closeButtons.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const closeButton = closeButtons.nth(index);
    if (!(await closeButton.isVisible().catch(() => false))) continue;
    await closeButton.click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(500);
    return true;
  }

  return true;
}

async function actionLabel(candidate) {
  const text = (await candidate.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
  const aria = (await candidate.getAttribute("aria-label").catch(() => "")) || "";
  const title = (await candidate.getAttribute("title").catch(() => "")) || "";
  return `${text} ${aria} ${title}`.trim();
}

async function findAction(page) {
  const selectors = [
    "button",
    "[role=button]",
    "a",
    "div[tabindex]",
    "span[tabindex]"
  ];
  const positive = /(簽到|签到|打卡|今日|Check[\s-]?in|Light up|Sign in to light)/i;
  const negative = /(五月\s*簽到|五月\s*签到|主線|主线|每日|領取全部積分|领取全部积分|領取|领取|Claim all|Collect all|登入|登录|Log in|Login|Sign up|會員|会员|API)/i;

  for (const selector of selectors) {
    const candidates = await page.locator(selector).all();
    for (const candidate of candidates) {
      if (!(await candidate.isVisible().catch(() => false))) continue;
      const label = await actionLabel(candidate);
      if (/(主線|每日|六月|January|February|March|April|May|June|July|August|September|October|November|December)/i.test(label)) continue;
      if (!label || !positive.test(label) || negative.test(label)) continue;
      return { locator: candidate, label };
    }
  }

  return null;
}

async function findCalendarSignInAction(page) {
  const candidates = await page.locator(".calendar-box .calendar-item").all();
  for (const candidate of candidates) {
    if (!(await candidate.isVisible().catch(() => false))) continue;
    const disabled = await candidate.locator(".text-white.text-opacity-50").count().catch(() => 0);
    if (disabled > 0) continue;
    return { locator: candidate, label: "current calendar note" };
  }

  return null;
}

async function clickWithDialogRetry(page, locator, accountName) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await locator.click({ timeout: 10_000 });
      return;
    } catch (error) {
      lastError = error;
      if (!/intercepts pointer events|element .* intercepts|dialog|overlay/i.test(error.message)) {
        throw error;
      }
      log(`[${accountName}] Click was blocked by an overlay; dismissing and retrying (${attempt}/3).`);
      await dismissBlockingDialogs(page, accountName);
      await page.waitForTimeout(700);
    }
  }

  throw lastError;
}

async function clickFreeCreditsNavigation(page, accountName) {
  const selectors = ["a", "button", "[role=button]", "div[tabindex]"];
  const positive = /(賺取免費積分|赚取免费积分|免費積分|免费积分|Earn free credits|Free credits)/i;
  const negative = /(API|立即購買|立即购买|購買|购买|Login|Log in|Sign up)/i;

  for (const selector of selectors) {
    const candidates = await page.locator(selector).all();
    for (const candidate of candidates) {
      if (!(await candidate.isVisible().catch(() => false))) continue;
      const label = await actionLabel(candidate);
      if (!label || !positive.test(label) || negative.test(label)) continue;
      log(`[${accountName}] Opening free credits section: ${label}`);
      await clickWithDialogRetry(page, candidate, accountName);
      await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
      await page.waitForTimeout(1000);
      return true;
    }
  }

  return false;
}

async function findRewardAction(page) {
  const selectors = ["button", "[role=button]", "a", "div[tabindex]", "span[tabindex]"];
  const positive = /(領取|领取|可領|可领|獲得|获得|收取|Claim|Collect|Redeem)/i;
  const negative = /(立即購買|立即购买|購買|购买|付款|Subscribe|Upgrade|Pricing|Deal|Get Started|API|登入|登录|Log in|Login|Sign up|已領|已领取|已獲得|已获得|已完成|Done|Completed|簽到|签到|Check[\s-]?in)/i;
  const unsafeTarget = /(order-api|cart|checkout|pricing|subscribe|plan|payment)/i;

  for (const selector of selectors) {
    const candidates = await page.locator(selector).all();
    for (const candidate of candidates) {
      if (!(await candidate.isVisible().catch(() => false))) continue;
      const label = await actionLabel(candidate);
      const href = (await candidate.getAttribute("href").catch(() => "")) || "";
      const className = (await candidate.getAttribute("class").catch(() => "")) || "";
      if (unsafeTarget.test(`${href} ${className}`)) continue;
      if (!label || !positive.test(label) || negative.test(label)) continue;
      return { locator: candidate, label };
    }
  }

  return null;
}

async function findSpecificAction(page, positive, { includePlainDivs = false } = {}) {
  const selectors = includePlainDivs
    ? ["button", "[role=button]", "a", "div", "span[tabindex]"]
    : ["button", "[role=button]", "a", "div[tabindex]", "span[tabindex]"];
  const unsafeTarget = /(order-api|cart|checkout|pricing|subscribe|plan|payment)/i;
  const negative = /(立即購買|立即购买|購買|购买|付款|Subscribe|Upgrade|Pricing|Deal|Get Started|API|登入|登录|Log in|Login|Sign up)/i;

  for (const selector of selectors) {
    const candidates = await page.locator(selector).all();
    for (const candidate of candidates) {
      if (!(await candidate.isVisible().catch(() => false))) continue;
      const label = await actionLabel(candidate);
      const href = (await candidate.getAttribute("href").catch(() => "")) || "";
      const className = (await candidate.getAttribute("class").catch(() => "")) || "";
      if (!label || !positive.test(label) || negative.test(label)) continue;
      if (unsafeTarget.test(`${href} ${className}`)) continue;
      return { locator: candidate, label };
    }
  }

  return null;
}

async function claimLuckyDrop(page, accountName) {
  await dismissBlockingDialogs(page, accountName);
  const milestones = await page.locator(".continuous-check-box .flex-1").all();
  for (const milestone of milestones) {
    if (!(await milestone.isVisible().catch(() => false))) continue;
    const label = await actionLabel(milestone);
    if (!/(\d+\s*天|整月)/i.test(label)) continue;
    log(`[${accountName}] Claiming lucky drop milestone: ${label}`);
    try {
      await clickWithDialogRetry(page, milestone, accountName);
    } catch (error) {
      log(`[${accountName}] Lucky drop milestone skipped after click failure: ${error.message}`);
      return false;
    }
    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(1500);
    return true;
  }

  const action = await findSpecificAction(page, /(幸運掉落|幸运掉落|Lucky drop|2\s*天|7\s*天|14\s*天|21\s*天|整月)/i, {
    includePlainDivs: true
  });

  if (!action) {
    log(`[${accountName}] No lucky drop action found.`);
    return false;
  }

  log(`[${accountName}] Claiming lucky drop: ${action.label}`);
  try {
    await clickWithDialogRetry(page, action.locator, accountName);
  } catch (error) {
    log(`[${accountName}] Lucky drop claim skipped after click failure: ${error.message}`);
    return false;
  }
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(1500);
  return true;
}

async function claimAllPoints(page, accountName) {
  await dismissBlockingDialogs(page, accountName);
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await page.waitForTimeout(500);

  const collectAllButton = page.locator("button.collect-all-btn").first();
  const action = (await collectAllButton.isVisible().catch(() => false))
    ? { locator: collectAllButton, label: await actionLabel(collectAllButton) }
    : await findSpecificAction(page, /(領取全部積分|领取全部积分|Claim all points|Claim all credits|Collect all)/i);
  if (!action) {
    log(`[${accountName}] No claim-all-points action found.`);
    return false;
  }

  log(`[${accountName}] Claiming all points: ${action.label}`);
  try {
    await clickWithDialogRetry(page, action.locator, accountName);
  } catch (error) {
    log(`[${accountName}] Claim-all-points skipped after click failure: ${error.message}`);
    return false;
  }
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(1500);
  return true;
}

async function claimAvailableRewards(page, accountName) {
  log(`[${accountName}] Waiting 10 seconds before lucky drop claim.`);
  await page.waitForTimeout(10_000);
  await claimLuckyDrop(page, accountName);

  log(`[${accountName}] Waiting 20 seconds before claiming all points.`);
  await page.waitForTimeout(20_000);
  await claimAllPoints(page, accountName);
}

function accountSortIndex(name) {
  const match = name.match(/^MUSICFUL_STORAGE_STATE_BASE64_(\d+)$/);
  return match?.[1] ? Number.parseInt(match[1], 10) : 1;
}

function loadAccountLabels() {
  const raw = process.env.MUSICFUL_ACCOUNT_LABELS_JSON;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    log(`MUSICFUL_ACCOUNT_LABELS_JSON is invalid JSON: ${error.message}`);
    return {};
  }
}

const accountLabels = loadAccountLabels();

function labelForIndex(index) {
  if (index == null) return accountLabelFromEnv || null;
  return accountLabels[String(index)] || accountLabels[index] || accountLabelFromEnv || null;
}

function accountFilterIndex() {
  const raw = process.env.MUSICFUL_ACCOUNT_FILTER || process.env.MUSICFUL_ACCOUNT_INDEX || "all";
  if (!raw || raw === "all") return null;
  const index = Number.parseInt(String(raw), 10);
  return Number.isFinite(index) && index > 0 ? index : null;
}

function collectStorageStates() {
  const states = new Map();

  // LitVideo-style: pick up MUSICFUL_STORAGE_STATE_BASE64_1..N from env.
  for (let index = 1; index <= maxAccounts; index += 1) {
    const name = accountSecretName(index);
    const value = process.env[name];
    if (value) states.set(name, value);
  }

  // Single-account alias used by local runs / older matrix workflow.
  if (storageStateBase64) {
    states.set(storageStateSecretName, storageStateBase64);
  }

  if (process.env.MUSICFUL_SECRETS_JSON) {
    const secrets = JSON.parse(process.env.MUSICFUL_SECRETS_JSON);
    for (const [name, value] of Object.entries(secrets)) {
      const match = name.match(/^MUSICFUL_STORAGE_STATE_BASE64_(\d+)$/);
      if (!match || !value) continue;
      const index = accountSortIndex(name);
      if (index < 1 || index > maxAccounts) continue;
      states.set(name, value);
    }
  }

  let accounts = [...states.entries()]
    .map(([name, value]) => ({
      name,
      value,
      index: accountSortIndex(name),
      label: labelForIndex(accountSortIndex(name))
    }))
    .sort((a, b) => a.index - b.index);

  const onlyIndex = accountFilterIndex();
  if (onlyIndex != null) {
    accounts = accounts.filter((account) => account.index === onlyIndex);
  }

  return accounts;
}

function writeMissingSlotResults(ranIndexes) {
  if (process.env.MUSICFUL_REPORT_ALL_SLOTS === "0") return;

  const ran = new Set(ranIndexes);
  const onlyIndex = accountFilterIndex();

  for (let index = 1; index <= maxAccounts; index += 1) {
    if (ran.has(index)) continue;

    const name = accountSecretName(index);
    const label = labelForIndex(index);

    if (onlyIndex != null && index !== onlyIndex) {
      writeSignInResult({
        account: index,
        label,
        name,
        status: "skipped",
        message: "Account not selected for this workflow_dispatch run"
      });
      continue;
    }

    writeSignInResult({
      account: index,
      label,
      name,
      status: "skipped",
      message: `Secret ${name} is not configured`
    });
  }
}

function runDailySummary() {
  const summaryScript = path.join(rootDir, "scripts", "summarize-signin-results.mjs");
  if (!fs.existsSync(summaryScript)) {
    log("Summary script not found; skipping daily summary.");
    return 0;
  }

  log("Building daily sign-in summary (LitVideo-style Job Summary)...");
  const result = spawnSync(process.execPath, [summaryScript, resultDir], {
    env: {
      ...process.env,
      MUSICFUL_SUMMARY_DIR: process.env.MUSICFUL_SUMMARY_DIR || resultDir,
      MUSICFUL_EXPECTED_ACCOUNTS: String(maxAccounts)
    },
    encoding: "utf8",
    stdio: "inherit"
  });
  return result.status ?? 1;
}

function randomDelayMs() {
  const min = Number.parseInt(process.env.MUSICFUL_DELAY_MIN_MS || "5000", 10);
  const max = Number.parseInt(process.env.MUSICFUL_DELAY_MAX_MS || "15000", 10);
  const lo = Number.isFinite(min) ? Math.max(0, min) : 5000;
  const hi = Number.isFinite(max) ? Math.max(lo, max) : 15000;
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

function accountSecretName(index) {
  return `MUSICFUL_STORAGE_STATE_BASE64_${index}`;
}

function scheduledAccountIndex(now = new Date()) {
  const start = new Date(scheduleStartUtc);
  if (Number.isNaN(start.getTime())) {
    throw new Error(`Invalid MUSICFUL_SCHEDULE_START_UTC: ${scheduleStartUtc}`);
  }

  const intervalMs = scheduleIntervalMinutes * 60 * 1000;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error(`Invalid MUSICFUL_SCHEDULE_INTERVAL_MINUTES: ${scheduleIntervalMinutes}`);
  }

  const elapsedSlots = Math.floor((now.getTime() - start.getTime()) / intervalMs);
  const normalizedSlot = ((elapsedSlots % maxAccounts) + maxAccounts) % maxAccounts;
  return normalizedSlot + 1;
}

function selectScheduledStorageState(storageStates) {
  if (scheduledMode !== "rolling") {
    return storageStates;
  }

  const targetIndex = process.env.MUSICFUL_ACCOUNT_INDEX
    ? Number.parseInt(process.env.MUSICFUL_ACCOUNT_INDEX, 10)
    : scheduledAccountIndex();
  const targetName = accountSecretName(targetIndex);
  const target = storageStates.find((account) => account.name === targetName);

  if (!target) {
    log(`Scheduled account ${targetName} is not configured; skipping this run.`);
    return [];
  }

  log(`Scheduled rolling mode selected ${targetName}.`);
  return [target];
}

/**
 * localStorage keys that are analytics or app cache, never sign-in state (auth lives in
 * cookies). Musicful's song cache alone can add ~18 KB, which pushes the encoded state past
 * GitHub's 64 KB secret limit and makes `gh secret set` fail.
 */
const disposableLocalStoragePatterns = [
  /^ai-music-generator:songs:/,
  /^__mpq_/,
  /^mp_[0-9a-f]+_mixpanel$/,
  /^_uetsid/,
  /^_uetvid/,
  /^_gcl_/,
  /^lastExternalReferrer/
];

function isDisposableLocalStorageKey(name) {
  return disposableLocalStoragePatterns.some((pattern) => pattern.test(name));
}

/** Drop analytics/cache localStorage entries; cookies and everything else are kept as-is. */
function pruneStorageState(state) {
  if (!state?.origins?.length) return state;
  return {
    ...state,
    origins: state.origins.map((origin) => {
      if (!Array.isArray(origin.localStorage)) return origin;
      return {
        ...origin,
        localStorage: origin.localStorage.filter((item) => !isDisposableLocalStorageKey(item.name))
      };
    })
  };
}

/** Prune, then base64 — the single place a storage state becomes a secret value. */
function encodeStorageState(state) {
  return Buffer.from(JSON.stringify(pruneStorageState(state)), "utf8").toString("base64");
}

/**
 * Base64 of the context's current cookies/localStorage/indexedDB, or null when the
 * export failed or came back without cookies (never overwrite a good secret with that).
 */
async function captureStorageState(context, accountName) {
  try {
    const state = await context.storageState({ indexedDB: true });
    if (!state?.cookies?.length) {
      log(`[${accountName}] Skipping secret refresh: exported state has no cookies.`);
      return null;
    }
    return encodeStorageState(state);
  } catch (error) {
    log(`[${accountName}] Could not export storage state for refresh: ${error.message}`);
    return null;
  }
}

/** Short digest for logs — the state itself is never logged. */
function shortStateHash(encoded) {
  return crypto.createHash("sha256").update(encoded).digest("hex").slice(0, 8);
}

/**
 * Write refreshed states back with `gh secret set`, once every account has finished:
 * spawnSync inside runAccount would stall the other concurrent sign-ins.
 * @param {{ name: string, encoded: string, hash: string }[]} updates
 */
function pushSecretUpdates(updates) {
  if (updates.length === 0) {
    log("Secret refresh: no account state changed; nothing to write back.");
    return;
  }
  if (!secretWriteToken) {
    log(`Secret refresh: ${updates.length} state(s) changed but MUSICFUL_SECRET_WRITE_TOKEN is unset; secrets left untouched.`);
    return;
  }
  if (!secretRepo) {
    log("Secret refresh: target repository is unknown (set MUSICFUL_SECRET_REPO); secrets left untouched.");
    return;
  }

  let updated = 0;
  for (const update of updates) {
    const bytes = Buffer.byteLength(update.encoded, "utf8");
    if (bytes > maxSecretBytes) {
      log(`Secret refresh: ${update.name} is ${bytes} bytes (limit ${maxSecretBytes}); skipped.`);
      continue;
    }

    // The value goes in on stdin so it never lands in a command line or process list.
    const result = spawnSync("gh", ["secret", "set", update.name, "--repo", secretRepo], {
      input: update.encoded,
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, GH_TOKEN: secretWriteToken, GITHUB_TOKEN: secretWriteToken }
    });

    if (result.error) {
      log(`Secret refresh: ${update.name} could not run gh: ${result.error.message}`);
      continue;
    }
    if (result.status !== 0) {
      log(`Secret refresh: ${update.name} failed (exit ${result.status}): ${(result.stderr || "").trim()}`);
      continue;
    }

    updated += 1;
    log(`Secret refresh: ${update.name} updated (${bytes} bytes, sha ${update.hash}).`);
  }

  log(`Secret refresh: updated ${updated}/${updates.length} secret(s).`);
}

function parseStorageState(encoded, name) {
  try {
    return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  } catch (error) {
    throw new Error(`${name} is not valid base64 storage state: ${error.message}`);
  }
}

function screenshotPath(accountName) {
  const safeName = accountName.replace(/[^A-Za-z0-9_-]/g, "-");
  return path.join(logDir, `musicful-signin-${stamp}-${safeName}.png`);
}

function copyToClipboard(value) {
  const command = process.platform === "win32"
    ? "clip.exe"
    : process.platform === "darwin"
      ? "pbcopy"
      : null;

  if (!command) {
    return false;
  }

  const result = spawnSync(command, [], {
    input: value,
    encoding: "utf8",
    windowsHide: true
  });

  return result.status === 0;
}

async function signInWithContext(context, accountName) {
  log(`[${accountName}] Opening ${signInUrl}`);
  // Prefer a single clean tab for export/setup to avoid restored tabs fighting for focus.
  const existingPages = context.pages();
  const page = existingPages[0] || await context.newPage();
  if (exportStateMode || setupMode) {
    for (let i = 1; i < existingPages.length; i += 1) {
      await existingPages[i].close().catch(() => {});
    }
  }
  page.setDefaultTimeout(20_000);

  await page.goto(signInUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  // SPAs often never reach networkidle; waiting for it can sit on a busy/reloading page for 30s.
  if (!exportStateMode && !setupMode) {
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
  } else {
    await page.waitForTimeout(1_500).catch(() => {});
  }

  if (setupMode) {
    log("Setup mode is open. Log in if needed, then press Ctrl+C here after the Growth Center shows your account.");
    while (true) {
      await page.waitForTimeout(60_000);
    }
  }

  if (exportStateMode) {
    await waitForLoggedInGrowthCenter(page, accountName);
    const state = await context.storageState({ indexedDB: true });
    const encoded = encodeStorageState(state);
    const encodedBytes = Buffer.byteLength(encoded, "utf8");
    if (encodedBytes > githubSecretLimitBytes) {
      throw new Error(
        `Exported storage state is ${encodedBytes} bytes, over GitHub's ${githubSecretLimitBytes}-byte secret limit. `
        + "Clear this browser profile's site data for musicful.ai, log in again, and export before generating songs."
      );
    }
    fs.writeFileSync(stateFile, `${encoded}\n`, { mode: 0o600 });
    if (numberedStateFile !== stateFile) {
      fs.writeFileSync(numberedStateFile, `${encoded}\n`, { mode: 0o600 });
    }
    log(`Storage state exported: ${stateFile} (${encodedBytes} bytes, limit ${githubSecretLimitBytes}).`);
    if (numberedStateFile !== stateFile) {
      log(`Numbered storage state exported: ${numberedStateFile}`);
    }
    if (copyToClipboard(encoded)) {
      log("Storage state copied to clipboard.");
    } else {
      log("Storage state was not copied to clipboard; copy it from the exported file.");
    }
    return {
      status: "exported",
      message: `Storage state exported to ${path.basename(stateFile)}`
    };
  }

  await dismissBlockingDialogs(page, accountName);
  const diagnostics = await ensureGrowthCenterControls(page, accountName);
  const beforeText = diagnostics.text || await visibleText(page);
  logReadableStatus(accountName, "Before automation", beforeText);
  if (isLoggedOutGrowthCenterPage(page, beforeText)) {
    throw new Error("Musicful storage state is logged out or expired. Export a fresh storage state after logging in, then update this account secret.");
  }
  if (textLooksLikeLoginPrompt(beforeText) && !/(Total|累計|累计|Credits|積分|积分|已登入|已登录)/i.test(beforeText)) {
    throw new Error("Musicful is not logged in for this automation profile. Export a fresh storage state first.");
  }

  if (/(already checked|already signed|已簽到|已签到|今日已|今天已|checked in today)/i.test(beforeText)) {
    log(`[${accountName}] Already signed in today.`);
    await claimAvailableRewards(page, accountName);
    const afterText = await visibleText(page);
    logReadableStatus(accountName, "After automation", afterText);
    return {
      status: "already_done",
      message: "Already signed in today",
      ...extractMetrics(afterText)
    };
  }

  await dismissBlockingDialogs(page, accountName);

  let action = await findAction(page);
  if (!action) {
    action = await findCalendarSignInAction(page);
  }
  if (!action) {
    const screenshot = screenshotPath(accountName);
    await page.screenshot({ path: screenshot, fullPage: true });
    log(`[${accountName}] No visible sign-in action was found. Screenshot saved: ${screenshot}`);
    if (/(累計|累计|Total).{0,20}\d+/i.test(beforeText)) {
      log(`[${accountName}] Growth Center is reachable; it may already be signed in or the button text changed.`);
      await claimAvailableRewards(page, accountName);
      const afterText = await visibleText(page);
      logReadableStatus(accountName, "After automation", afterText);
      return {
        status: "already_done",
        message: "No sign-in button; Growth Center reachable (likely already signed in)",
        ...extractMetrics(afterText)
      };
    }
    throw new Error("Could not find the Musicful sign-in action.");
  }

  log(`[${accountName}] Clicking sign-in action: ${action.label}`);
  await clickWithDialogRetry(page, action.locator, accountName);
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(3000);

  const afterClickText = await visibleText(page);
  const success = /(已簽到|已签到|今日已|今天已|success|signed|checked|累計|累计|Total)/i.test(afterClickText);
  if (!success) {
    const screenshot = screenshotPath(accountName);
    await page.screenshot({ path: screenshot, fullPage: true });
    log(`[${accountName}] Clicked the sign-in action, but could not confirm success. Screenshot saved: ${screenshot}`);
  }

  log(`[${accountName}] Musicful sign-in finished.`);
  await claimAvailableRewards(page, accountName);
  const finalText = await visibleText(page);
  logReadableStatus(accountName, "After automation", finalText);
  return {
    status: success ? "checked_in" : "checked_in",
    message: success
      ? `Clicked sign-in action: ${action.label}`
      : `Clicked sign-in action (${action.label}) but success text was unclear`,
    ...extractMetrics(finalText)
  };
}

/**
 * @param {string} raw
 * @returns {"chrome" | "edge" | "firefox"}
 */
function normalizeBrowserChoice(raw) {
  const value = String(raw || "chrome").trim().toLowerCase();
  if (value === "firefox" || value === "ff") return "firefox";
  if (
    value === "edge"
    || value === "msedge"
    || value === "microsoft-edge"
    || value === "microsoftedge"
    || value === "microsoft_edge"
  ) {
    return "edge";
  }
  if (
    value === "chrome"
    || value === "chromium"
    || value === "google-chrome"
    || value === "googlechrome"
    || value === "google_chrome"
  ) {
    return "chrome";
  }
  throw new Error(`Unsupported browser "${raw}". Use chrome (default), edge, or firefox.`);
}

/**
 * @param {"chrome" | "edge" | "firefox"} choice
 * @param {string} name
 * @param {string} root
 */
function resolveProfileDir(choice, name, root) {
  if (choice === "firefox") {
    return name
      ? path.join(root, `.musicful-profile-firefox-${name}`)
      : path.join(root, ".musicful-profile-firefox");
  }
  if (choice === "edge") {
    return name
      ? path.join(root, `.musicful-profile-edge-${name}`)
      : path.join(root, ".musicful-profile-edge");
  }
  // chrome keeps the historical path for existing profiles
  return name
    ? path.join(root, `.musicful-profile-${name}`)
    : path.join(root, ".musicful-profile");
}

function resolveInstalledChrome() {
  if (chromePathFromEnv && fs.existsSync(chromePathFromEnv)) {
    return { executablePath: chromePathFromEnv, label: chromePathFromEnv };
  }

  if (process.platform === "darwin") {
    const macChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    if (fs.existsSync(macChrome)) {
      return { channel: "chrome", label: "Google Chrome (macOS channel)" };
    }
  }

  if (process.platform === "win32") {
    const candidates = [
      path.join(process.env.PROGRAMFILES || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
      path.join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
      path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe")
    ];
    for (const candidate of candidates) {
      if (candidate && fs.existsSync(candidate)) {
        // channel lets Playwright pick the installed Chrome without path quirks
        return { channel: "chrome", label: candidate };
      }
    }
  }

  if (process.platform === "linux") {
    const linuxCandidates = [
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium-browser",
      "/usr/bin/chromium"
    ];
    for (const candidate of linuxCandidates) {
      if (fs.existsSync(candidate)) {
        return { executablePath: candidate, label: candidate };
      }
    }
  }

  return null;
}

function resolveInstalledEdge() {
  if (edgePathFromEnv && fs.existsSync(edgePathFromEnv)) {
    return { executablePath: edgePathFromEnv, label: edgePathFromEnv };
  }

  if (process.platform === "darwin") {
    const macEdge = "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
    if (fs.existsSync(macEdge)) {
      return { channel: "msedge", label: "Microsoft Edge (macOS channel)" };
    }
  }

  if (process.platform === "win32") {
    const candidates = [
      path.join(process.env.PROGRAMFILES || "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(process.env.LOCALAPPDATA || "", "Microsoft", "Edge", "Application", "msedge.exe")
    ];
    for (const candidate of candidates) {
      if (candidate && fs.existsSync(candidate)) {
        return { channel: "msedge", label: candidate };
      }
    }
  }

  if (process.platform === "linux") {
    const linuxCandidates = [
      "/usr/bin/microsoft-edge",
      "/usr/bin/microsoft-edge-stable",
      "/usr/bin/microsoft-edge-beta",
      "/usr/bin/microsoft-edge-dev"
    ];
    for (const candidate of linuxCandidates) {
      if (fs.existsSync(candidate)) {
        return { executablePath: candidate, label: candidate };
      }
    }
  }

  // Playwright can still try the msedge channel when the binary path is unknown.
  return { channel: "msedge", label: "Microsoft Edge (Playwright channel: msedge)" };
}

function resolveInstalledFirefox() {
  if (firefoxPathFromEnv && fs.existsSync(firefoxPathFromEnv)) {
    return { executablePath: firefoxPathFromEnv, label: firefoxPathFromEnv };
  }

  if (process.platform === "darwin") {
    const macFirefox = "/Applications/Firefox.app/Contents/MacOS/firefox";
    if (fs.existsSync(macFirefox)) {
      return { channel: "firefox", label: "Firefox (macOS channel)" };
    }
  }

  if (process.platform === "win32") {
    const candidates = [
      path.join(process.env.PROGRAMFILES || "C:\\Program Files", "Mozilla Firefox", "firefox.exe"),
      path.join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Mozilla Firefox", "firefox.exe"),
      path.join(process.env.LOCALAPPDATA || "", "Mozilla Firefox", "firefox.exe")
    ];
    for (const candidate of candidates) {
      if (candidate && fs.existsSync(candidate)) {
        return { channel: "firefox", label: candidate };
      }
    }
  }

  if (process.platform === "linux") {
    const linuxCandidates = [
      "/usr/bin/firefox",
      "/usr/bin/firefox-esr",
      "/snap/bin/firefox"
    ];
    for (const candidate of linuxCandidates) {
      if (fs.existsSync(candidate)) {
        return { executablePath: candidate, label: candidate };
      }
    }
  }

  return null;
}

/**
 * Chromium-family launch args (Chrome / Edge). Not applied to Firefox.
 * @param {import("playwright").LaunchOptions} options
 */
function applyChromiumFamilyLaunchArgs(options) {
  options.args.push("--disable-crash-reporter", "--disable-crashpad");
  // Headed login/export: avoid --enable-automation chrome banner / extra bot signals.
  if (headed || setupMode || exportStateMode) {
    options.ignoreDefaultArgs = ["--enable-automation"];
    options.args.push("--disable-blink-features=AutomationControlled");
  }
}

/**
 * Build Playwright launcher + options for the selected engine.
 * Chrome remains the recommended default; Edge and Firefox are opt-in fallbacks.
 * @param {"chrome" | "edge" | "firefox"} choice
 */
function resolveBrowserEngine(choice) {
  /** @type {import("playwright").LaunchOptions} */
  const options = {
    headless: !headed,
    args: []
  };

  if (choice === "firefox") {
    const installed = resolveInstalledFirefox();
    if (installed?.channel) {
      options.channel = installed.channel;
    } else if (installed?.executablePath) {
      options.executablePath = installed.executablePath;
    }
    return {
      choice: "firefox",
      launcher: firefox,
      options,
      installed,
      fallbackLabel: "Playwright Firefox (system Firefox not found)"
    };
  }

  applyChromiumFamilyLaunchArgs(options);

  if (choice === "edge") {
    const installed = resolveInstalledEdge();
    if (installed?.channel) {
      options.channel = installed.channel;
    } else if (installed?.executablePath) {
      options.executablePath = installed.executablePath;
    }
    return {
      choice: "edge",
      launcher: chromium,
      options,
      installed,
      fallbackLabel: "Microsoft Edge (channel msedge; install Edge if launch fails)"
    };
  }

  const installed = resolveInstalledChrome();
  if (installed?.channel) {
    options.channel = installed.channel;
  } else if (installed?.executablePath) {
    options.executablePath = installed.executablePath;
  }

  return {
    choice: "chrome",
    launcher: chromium,
    options,
    installed,
    fallbackLabel: "Playwright Chromium (system Chrome not found)"
  };
}

/**
 * @param {"chrome" | "edge" | "firefox"} choice
 */
function browserEngineLogLabel(choice) {
  if (choice === "firefox") return "Firefox (fallback)";
  if (choice === "edge") return "Microsoft Edge (fallback)";
  return "Chrome/Chromium (default)";
}

function describeBrowserEngine(engine) {
  if (engine.installed) {
    return engine.installed.label;
  }
  return engine.fallbackLabel;
}

async function applyStealthInit(context) {
  // Reduce obvious automation signals that some sites treat as bot (reload/challenge loops).
  await context.addInitScript(() => {
    try {
      Object.defineProperty(navigator, "webdriver", {
        get: () => undefined
      });
    } catch {
      // ignore
    }
  });
}

async function main() {
  log(`Opening ${signInUrl}`);
  const engine = resolveBrowserEngine(browserChoice);
  const browserOptions = engine.options;
  log(`Browser engine: ${browserEngineLogLabel(engine.choice)}`);
  if (engine.choice === "firefox" || engine.choice === "edge") {
    log(`Note: ${engine.choice === "edge" ? "Edge" : "Firefox"} is a backup option. Re-export login state with the same browser you use for sign-in when possible.`);
  }

  const contextOptions = {
    viewport: { width: 1440, height: 1000 },
    locale: "zh-TW",
    timezoneId: "Asia/Taipei"
  };

  const storageStates = selectScheduledStorageState(collectStorageStates());
  if (storageStates.length > 0 || process.env.GITHUB_ACTIONS === "true" || process.env.MUSICFUL_AUTO_SUMMARY === "1") {
    log(`Found ${storageStates.length} Musicful account storage state(s).`);
    if (refreshSecrets) {
      log(secretWriteToken
        ? `Secret refresh is on; changed states will be written back to ${secretRepo || "(unknown repo)"}.`
        : "Secret refresh is on but no write token is configured; changes will only be reported.");
    }
    log(`Browser: ${describeBrowserEngine(engine)}`);
    const browser = storageStates.length > 0 ? await engine.launcher.launch(browserOptions) : null;
    let failures = 0;
    /** @type {ReturnType<typeof writeSignInResult>[]} */
    const results = [];
    /** @type {{ name: string, encoded: string, hash: string }[]} */
    const pendingSecretUpdates = [];

    try {
      // Start every account in its own context.  The offsets are cumulative, so
      // account N begins 5–15 seconds after account N-1 without waiting for the
      // prior sign-in to finish.
      let cumulativeStartDelayMs = 0;
      const accountTasks = storageStates.map((account, position) => {
        if (position > 0) cumulativeStartDelayMs += randomDelayMs();
        return runAccount(account, cumulativeStartDelayMs);
      });

      async function runAccount(account, startDelayMs) {
        const meta = resolveAccountMeta(account.name);
        if (meta.account == null && account.index != null) {
          meta.account = account.index;
        }
        if (account.label && !meta.label) {
          meta.label = account.label;
        }

        if (startDelayMs > 0) {
          log(`[${account.name}] Scheduled to start in ${Math.round(startDelayMs / 1000)} second(s).`);
          await new Promise((resolve) => setTimeout(resolve, startDelayMs));
        }

        log(`\n=== Account ${meta.account ?? "?"}: ${meta.label || account.name} ===`);
        let context;
        try {
          context = await browser.newContext({
            ...contextOptions,
            storageState: parseStorageState(account.value, account.name)
          });
          await applyStealthInit(context);
          const outcome = await signInWithContext(context, account.name);
          if (refreshSecrets) {
            // Only reached when sign-in succeeded; a failure throws before this point.
            const encoded = await captureStorageState(context, account.name);
            if (encoded && encoded !== String(account.value).trim()) {
              const hash = shortStateHash(encoded);
              pendingSecretUpdates.push({ name: account.name, encoded, hash });
              log(`[${account.name}] Storage state changed; queued secret refresh (sha ${hash}).`);
            }
          }
          results.push(writeSignInResult({
            ...meta,
            ...outcome
          }));
        } catch (error) {
          failures += 1;
          log(`[${account.name}] Failed: ${error.message}`);
          results.push(writeSignInResult({
            ...meta,
            status: "failed",
            message: error.message
          }));
        } finally {
          await context?.close();
        }
      }

      await Promise.all(accountTasks);
    } finally {
      if (browser) await browser.close();
    }

    if (refreshSecrets) {
      pushSecretUpdates(pendingSecretUpdates);
    }

    const ranIndexes = results
      .map((row) => row.account)
      .filter((value) => value != null);
    writeMissingSlotResults(ranIndexes);

    const autoSummary =
      process.env.MUSICFUL_AUTO_SUMMARY === "1"
      || process.env.GITHUB_ACTIONS === "true"
      || Boolean(process.env.GITHUB_STEP_SUMMARY);
    if (autoSummary) {
      const summaryCode = runDailySummary();
      if (summaryCode !== 0 && failures === 0) {
        process.exitCode = summaryCode;
      }
    }

    if (failures > 0) {
      throw new Error(`${failures} Musicful account(s) failed.`);
    }
    return;
  }

  let context;
  if (!storageStateBase64) {
    log(`Using browser: ${describeBrowserEngine(engine)}`);
    if (engine.choice === "chrome" && !engine.installed) {
      log("Tip: install Google Chrome for more stable headed login/export, or pass --browser edge / --browser firefox as a fallback.");
    }
    context = await engine.launcher.launchPersistentContext(profileDir, {
      ...browserOptions,
      ...contextOptions
    });
    await applyStealthInit(context);
  }

  try {
    const localAccountName = profileName || "local-profile";
    const meta = resolveAccountMeta(localAccountName);
    const outcome = await signInWithContext(context, localAccountName);
    writeSignInResult({
      ...meta,
      ...outcome
    });
  } catch (error) {
    writeSignInResult({
      ...resolveAccountMeta(profileName || "local-profile"),
      status: "failed",
      message: error.message
    });
    throw error;
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  log(`Failed: ${error.message}`);
  // Ensure CI still gets a result row when setup fails before per-account handling.
  try {
    const resultPath = path.join(resultDir, "signin-result.json");
    if (!fs.existsSync(resultPath)) {
      writeSignInResult({
        ...resolveAccountMeta(storageStateSecretName),
        status: "failed",
        message: error.message
      });
    }
  } catch {
    // ignore secondary write errors
  }
  process.exitCode = 1;
});
