import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const args = new Set(process.argv.slice(2));
const headed = args.has("--headed") || args.has("--setup");
const setupMode = args.has("--setup");
const exportStateMode = args.has("--export-state");
const rootDir = path.resolve(new URL("..", import.meta.url).pathname);
const profileDir = path.join(rootDir, ".musicful-profile");
const logDir = path.join(rootDir, "logs");
const stateFile = path.join(logDir, "musicful-storage-state.base64");
const signInUrl = process.env.MUSICFUL_SIGNIN_URL || "https://www.musicful.ai/growth-center/";
const chromePath = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const storageStateBase64 = process.env.MUSICFUL_STORAGE_STATE_BASE64;
const maxAccounts = Number.parseInt(process.env.MUSICFUL_MAX_ACCOUNTS || "115", 10);
const scheduledMode = process.env.MUSICFUL_SCHEDULE_MODE || "all";
const scheduleStartUtc = process.env.MUSICFUL_SCHEDULE_START_UTC || "2026-05-31T05:06:00Z";
const scheduleIntervalMinutes = Number.parseInt(process.env.MUSICFUL_SCHEDULE_INTERVAL_MINUTES || "15", 10);

fs.mkdirSync(profileDir, { recursive: true });
fs.mkdirSync(logDir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const logFile = path.join(logDir, `musicful-signin-${stamp}.log`);

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  fs.appendFileSync(logFile, `${line}\n`);
}

async function visibleText(page) {
  return (await page.locator("body").innerText({ timeout: 10_000 })).replace(/\s+/g, " ");
}

async function dismissBlockingDialogs(page, accountName) {
  const dialogs = page.locator(".el-overlay-dialog, [role='dialog'][aria-modal='true']");
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
  const positive = /(簽到|签到|領取|领取|打卡|今日|Check[\s-]?in|Claim|Light up|Sign in to light)/i;
  const negative = /(登入|登录|Log in|Login|Sign up|會員|会员|API)/i;

  for (const selector of selectors) {
    const candidates = await page.locator(selector).all();
    for (const candidate of candidates) {
      if (!(await candidate.isVisible().catch(() => false))) continue;
      const label = await actionLabel(candidate);
      if (!label || !positive.test(label) || negative.test(label)) continue;
      return { locator: candidate, label };
    }
  }

  return null;
}

async function clickWithDialogRetry(page, locator, accountName) {
  try {
    await locator.click({ timeout: 10_000 });
  } catch (error) {
    if (!/intercepts pointer events|element .* intercepts/i.test(error.message)) {
      throw error;
    }
    await dismissBlockingDialogs(page, accountName);
    await locator.click({ timeout: 10_000 });
  }
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
  const positive = /(領取|领取|可領|可领|獲得|获得|收取|Claim|Collect|Redeem|Get)/i;
  const negative = /(立即購買|立即购买|購買|购买|付款|Subscribe|Upgrade|Pricing|API|登入|登录|Log in|Login|Sign up|已領|已领取|已獲得|已获得|已完成|Done|Completed|簽到|签到|Check[\s-]?in)/i;

  for (const selector of selectors) {
    const candidates = await page.locator(selector).all();
    for (const candidate of candidates) {
      if (!(await candidate.isVisible().catch(() => false))) continue;
      const label = await actionLabel(candidate);
      if (!label || !positive.test(label) || negative.test(label)) continue;
      return { locator: candidate, label };
    }
  }

  return null;
}

async function claimAvailableRewards(page, accountName) {
  await dismissBlockingDialogs(page, accountName);
  await clickFreeCreditsNavigation(page, accountName).catch((error) => {
    log(`[${accountName}] Free credits navigation skipped: ${error.message}`);
  });

  let claimed = 0;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await dismissBlockingDialogs(page, accountName);
    const reward = await findRewardAction(page);
    if (!reward) break;

    log(`[${accountName}] Claiming reward: ${reward.label}`);
    await clickWithDialogRetry(page, reward.locator, accountName);
    claimed += 1;
    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(1500);
  }

  log(`[${accountName}] Reward claim scan finished. Claimed ${claimed} reward action(s).`);
}

function accountSortIndex(name) {
  const match = name.match(/^MUSICFUL_STORAGE_STATE_BASE64(?:_(\d+))?$/);
  return match?.[1] ? Number.parseInt(match[1], 10) : 1;
}

function collectStorageStates() {
  const states = new Map();

  if (storageStateBase64) {
    states.set("MUSICFUL_STORAGE_STATE_BASE64", storageStateBase64);
  }

  if (process.env.MUSICFUL_SECRETS_JSON) {
    const secrets = JSON.parse(process.env.MUSICFUL_SECRETS_JSON);
    for (const [name, value] of Object.entries(secrets)) {
      const match = name.match(/^MUSICFUL_STORAGE_STATE_BASE64(?:_(\d+))?$/);
      if (!match || !value) continue;
      const index = accountSortIndex(name);
      if (index < 1 || index > maxAccounts) continue;
      states.set(name, value);
    }
  }

  return [...states.entries()]
    .map(([name, value]) => ({ name, value, index: accountSortIndex(name) }))
    .sort((a, b) => a.index - b.index);
}

function accountSecretName(index) {
  return index === 1 ? "MUSICFUL_STORAGE_STATE_BASE64" : `MUSICFUL_STORAGE_STATE_BASE64_${index}`;
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
    const state = await context.storageState();
    const encoded = Buffer.from(JSON.stringify(state), "utf8").toString("base64");
    fs.writeFileSync(stateFile, `${encoded}\n`, { mode: 0o600 });
    log(`Storage state exported: ${stateFile}`);
    return;
  }

  const beforeText = await visibleText(page);
  if (/(Log In|Login|登入|登录|Sign Up|會員登入|会员登录)/i.test(beforeText) && !/(Total|累計|累计|Credits|積分|积分)/i.test(beforeText)) {
    throw new Error("Musicful is not logged in for this automation profile. Export a fresh storage state first.");
  }

  if (/(already checked|already signed|已簽到|已签到|今日已|今天已|checked in today)/i.test(beforeText)) {
    log(`[${accountName}] Already signed in today.`);
    await claimAvailableRewards(page, accountName);
    return;
  }

  await dismissBlockingDialogs(page, accountName);

  const action = await findAction(page);
  if (!action) {
    const screenshot = screenshotPath(accountName);
    await page.screenshot({ path: screenshot, fullPage: true });
    log(`[${accountName}] No visible sign-in action was found. Screenshot saved: ${screenshot}`);
    if (/(累計|累计|Total).{0,20}\d+/i.test(beforeText)) {
      log(`[${accountName}] Growth Center is reachable; it may already be signed in or the button text changed.`);
      await claimAvailableRewards(page, accountName);
      return;
    }
    throw new Error("Could not find the Musicful sign-in action.");
  }

  log(`[${accountName}] Clicking sign-in action: ${action.label}`);
  await clickWithDialogRetry(page, action.locator, accountName);
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(3000);

  const afterText = await visibleText(page);
  const success = /(已簽到|已签到|今日已|今天已|success|signed|checked|累計|累计|Total)/i.test(afterText);
  if (!success) {
    const screenshot = screenshotPath(accountName);
    await page.screenshot({ path: screenshot, fullPage: true });
    throw new Error(`Clicked the action, but could not confirm success. Screenshot saved: ${screenshot}`);
  }

  log(`[${accountName}] Musicful sign-in finished.`);
  await claimAvailableRewards(page, accountName);
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
  if (storageStates.length > 0) {
    log(`Found ${storageStates.length} Musicful account storage state(s).`);
    const browser = await chromium.launch(browserOptions);
    let failures = 0;

    try {
      for (const account of storageStates) {
        const context = await browser.newContext({
          ...contextOptions,
          storageState: parseStorageState(account.value, account.name)
        });

        try {
          await signInWithContext(context, account.name);
        } catch (error) {
          failures += 1;
          log(`[${account.name}] Failed: ${error.message}`);
        } finally {
          await context.close();
        }
      }
    } finally {
      await browser.close();
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
    await signInWithContext(context, "local-profile");
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  log(`Failed: ${error.message}`);
  process.exitCode = 1;
});
