import { chromium } from "playwright";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
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
const profileDir = profileName
  ? path.join(rootDir, `.musicful-profile-${profileName}`)
  : path.join(rootDir, ".musicful-profile");
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
const chromePath = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
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
  const streakDays = text.match(/累計\s*[:：]\s*(\d+)\s*天/i)?.[1]
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
  log(`Wrote sign-in result: ${canonical} (${payload.status})`);
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
  const streak = text.match(/累計\s*[:：]\s*(\d+)\s*天/i)?.[1];
  const growthPoints = text.match(/已獲得成長積分\s*(\d+)/i)?.[1]
    || text.match(/積分\s*[:：]\s*(\d+)/i)?.[1];
  const musicPoints = text.match(/(\d+)\s*\/\s*\d+\s*音樂點/i)?.[1];

  log(`[${accountName}] ${stage} status: 累計=${streak || "not found"} 天, 積分=${growthPoints || "not found"}, 音樂點=${musicPoints || "not found"}.`);
}

function logReadableStatus(accountName, stage, text) {
  const streak = text.match(/累計\s*[:：]\s*(\d+)\s*天/i)?.[1]
    || text.match(/streak\s*[:：]?\s*(\d+)\s*(?:day|days)?/i)?.[1];
  const growthPoints = text.match(/已獲得成長積分\s*(\d+)/i)?.[1]
    || text.match(/積分\s*[:：]\s*(\d+)/i)?.[1]
    || text.match(/growth\s*points?\s*(\d+)/i)?.[1];
  const musicPoints = text.match(/(\d+)\s*\/\s*\d+\s*音樂點/i)?.[1]
    || text.match(/(\d+)\s*\/\s*\d+\s*music\s*points?/i)?.[1];

  log(`[${accountName}] ${stage} status: streakDays=${streak || "not found"}, growthPoints=${growthPoints || "not found"}, musicPoints=${musicPoints || "not found"}.`);
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
  const looksLoggedOut = /(Log In|Login|登入|註冊|Sign Up)/i.test(diagnostics.text)
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

function isLoggedOutGrowthCenterPage(page, text) {
  const hasLoginPrompt = /(Log In|Login|登入|註冊|Sign Up)/i.test(text);
  const hasAccountStatus = /(已獲得成長積分|簽到點亮|累計\s*[:：]\s*\d+\s*天|\d+\s*\/\s*\d+\s*音樂點|Earned Growth|Growth Points|Streak)/i.test(text);
  const isHomePage = page.url().includes("/home/");
  return hasLoginPrompt && (isHomePage || !hasAccountStatus);
}

async function waitForLoggedInGrowthCenter(page, accountName) {
  log(`[${accountName}] Export mode is open. Log in and open the Growth Center within ${exportTimeoutMinutes} minute(s); this will export after the account status is visible.`);
  log(`[${accountName}] Export wait is passive (no Escape / dialog dismiss) to avoid focus steal and UI flicker while you log in.`);

  const pollMs = 4000;
  const deadline = Date.now() + exportTimeoutMinutes * 60 * 1000;
  let lastLoginPromptLogAt = 0;

  while (Date.now() < deadline) {
    await page.waitForTimeout(pollMs);

    // Passive poll only: never press Escape or click close while the user may still be
    // logging in. Aggressive dismiss was causing visible flicker / closing login UI.
    if (await hasVisibleLoginPrompt(page)) {
      if (Date.now() - lastLoginPromptLogAt > 15_000) {
        log(`[${accountName}] Login prompt is visible; leaving focus alone while you finish login.`);
        lastLoginPromptLogAt = Date.now();
      }
      continue;
    }

    const diagnostics = await logPageDiagnostics(page, accountName, "Export check");
    const hasControls = diagnostics.visibleCalendarItems > 0 || diagnostics.visibleLuckyDrops > 0 || diagnostics.visibleCollectAllButtons > 0;
    const hasStatus = /(已獲得成長積分|簽到點亮|累計\s*[:：]\s*\d+\s*天|\d+\s*\/\s*\d+\s*音樂點|Earned Growth|Growth Points|Streak)/i.test(diagnostics.text);
    const loginPromptVisible = await hasVisibleLoginPrompt(page, diagnostics.text);
    if (loginPromptVisible) {
      if (Date.now() - lastLoginPromptLogAt > 15_000) {
        log(`[${accountName}] Login prompt is still visible; waiting for login to finish.`);
        lastLoginPromptLogAt = Date.now();
      }
      continue;
    }
    if ((hasControls || hasStatus) && !isLoggedOutGrowthCenterPage(page, diagnostics.text)) {
      // Dismiss only once after login is confirmed, so a leftover pricing modal does not
      // hide status during the ready delay — still avoids the every-poll Escape flicker.
      await dismissBlockingDialogs(page, accountName);
      log(`[${accountName}] Logged-in Growth Center state detected; waiting ${exportReadyDelaySeconds} second(s) before export.`);
      await page.waitForTimeout(exportReadyDelaySeconds * 1000);
      const finalText = await visibleText(page).catch(() => "");
      if (await hasVisibleLoginPrompt(page, finalText)) {
        log(`[${accountName}] Login prompt reappeared after the ready delay; waiting for login to finish.`);
        continue;
      }
      log(`[${accountName}] Logged-in Growth Center state detected; exporting storage state.`);
      return;
    }
  }

  throw new Error("Could not export Musicful storage state because the Growth Center never showed a logged-in account.");
}

async function hasVisibleLoginPrompt(page, text = "") {
  const loginTextPattern = new RegExp([
    "Log In",
    "Login",
    "Sign Up",
    "\\u767b\\u5165",
    "\\u4f7f\\u7528\\s*Google\\s*\\u7e7c\\u7e8c",
    "\\u4f7f\\u7528\\s*Discord\\s*\\u7e7c\\u7e8c",
    "\\u8f38\\u5165\\u4f60\\u7684\\u4fe1\\u7bb1"
  ].join("|"), "i");

  if (loginTextPattern.test(text)) {
    return true;
  }

  const selectors = [
    "input[type='email']",
    "input[placeholder*='email' i]",
    "input[placeholder*='信箱']",
    ".third-login-text",
    ".el-overlay input",
    ".el-overlay [class*='login' i]"
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) {
      return true;
    }
  }

  return false;
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
  const page = context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(20_000);

  await page.goto(signInUrl, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});

  if (setupMode) {
    log("Setup mode is open. Log in if needed, then press Ctrl+C here after the Growth Center shows your account.");
    while (true) {
      await page.waitForTimeout(60_000);
    }
  }

  if (exportStateMode) {
    await waitForLoggedInGrowthCenter(page, accountName);
    const state = await context.storageState({ indexedDB: true });
    const encoded = Buffer.from(JSON.stringify(state), "utf8").toString("base64");
    fs.writeFileSync(stateFile, `${encoded}\n`, { mode: 0o600 });
    if (numberedStateFile !== stateFile) {
      fs.writeFileSync(numberedStateFile, `${encoded}\n`, { mode: 0o600 });
    }
    log(`Storage state exported: ${stateFile}`);
    if (numberedStateFile !== stateFile) {
      log(`Numbered storage state exported: ${numberedStateFile}`);
    }
    if (copyToClipboard(encoded)) {
      log("Storage state copied to clipboard.");
    } else {
      log("Storage state was not copied to clipboard; copy it from the exported file.");
    }
    return;
  }

  await dismissBlockingDialogs(page, accountName);
  const diagnostics = await ensureGrowthCenterControls(page, accountName);
  const beforeText = diagnostics.text || await visibleText(page);
  logReadableStatus(accountName, "Before automation", beforeText);
  if (isLoggedOutGrowthCenterPage(page, beforeText)) {
    throw new Error("Musicful storage state is logged out or expired. Export a fresh storage state after logging in, then update this account secret.");
  }
  if (/(Log In|Login|登入|登录|Sign Up|會員登入|会员登录)/i.test(beforeText) && !/(Total|累計|累计|Credits|積分|积分)/i.test(beforeText)) {
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

async function main() {
  log(`Opening ${signInUrl}`);
  const browserOptions = {
    headless: !headed,
    args: [
      "--disable-crash-reporter",
      "--disable-crashpad"
    ]
  };
  const contextOptions = {
    viewport: { width: 1440, height: 1000 },
    locale: "zh-TW",
    timezoneId: "Asia/Taipei"
  };

  const storageStates = selectScheduledStorageState(collectStorageStates());
  if (storageStates.length > 0 || process.env.GITHUB_ACTIONS === "true" || process.env.MUSICFUL_AUTO_SUMMARY === "1") {
    log(`Found ${storageStates.length} Musicful account storage state(s).`);
    const browser = storageStates.length > 0 ? await chromium.launch(browserOptions) : null;
    let failures = 0;
    /** @type {ReturnType<typeof writeSignInResult>[]} */
    const results = [];

    try {
      for (let i = 0; i < storageStates.length; i += 1) {
        const account = storageStates[i];
        const meta = resolveAccountMeta(account.name);
        if (meta.account == null && account.index != null) {
          meta.account = account.index;
        }
        if (account.label && !meta.label) {
          meta.label = account.label;
        }

        log(`\n=== Account ${meta.account ?? "?"}: ${meta.label || account.name} ===`);

        const context = await browser.newContext({
          ...contextOptions,
          storageState: parseStorageState(account.value, account.name)
        });

        try {
          const outcome = await signInWithContext(context, account.name);
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
          await context.close();
        }

        if (i < storageStates.length - 1) {
          const delay = randomDelayMs();
          log(`Waiting ${Math.round(delay / 1000)} second(s) before the next account.`);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    } finally {
      if (browser) await browser.close();
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
    if (fs.existsSync(chromePath)) {
      browserOptions.channel = "chrome";
    }
    context = await chromium.launchPersistentContext(profileDir, {
      ...browserOptions,
      ...contextOptions
    });
    log("Using installed Google Chrome.");
  }

  try {
    const meta = resolveAccountMeta("local-profile");
    const outcome = await signInWithContext(context, "local-profile");
    writeSignInResult({
      ...meta,
      ...outcome
    });
  } catch (error) {
    writeSignInResult({
      ...resolveAccountMeta("local-profile"),
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
