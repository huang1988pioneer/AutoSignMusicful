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
      const text = (await candidate.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
      const aria = (await candidate.getAttribute("aria-label").catch(() => "")) || "";
      const title = (await candidate.getAttribute("title").catch(() => "")) || "";
      const label = `${text} ${aria} ${title}`.trim();
      if (!label || !positive.test(label) || negative.test(label)) continue;
      return { locator: candidate, label };
    }
  }

  return null;
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

  let context;
  let browser;
  if (storageStateBase64) {
    const storageState = JSON.parse(Buffer.from(storageStateBase64, "base64").toString("utf8"));
    browser = await chromium.launch(browserOptions);
    context = await browser.newContext({ ...contextOptions, storageState });
    log("Using storage state from MUSICFUL_STORAGE_STATE_BASE64.");
  } else {
    if (fs.existsSync(chromePath)) {
      browserOptions.channel = "chrome";
    }
    context = await chromium.launchPersistentContext(profileDir, {
      ...browserOptions,
      ...contextOptions
    });
    log("Using installed Google Chrome.");
  }

  const page = context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(20_000);

  try {
    await page.goto(signInUrl, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});

    if (setupMode) {
      log("Setup mode is open. Log in if needed, then press Ctrl+C here after the Growth Center shows your account.");
      while (true) {
        await page.waitForTimeout(60_000);
      }
      return;
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
      throw new Error("Musicful is not logged in for this automation profile. Run npm run setup first.");
    }

    if (/(already checked|already signed|已簽到|已签到|今日已|今天已|checked in today)/i.test(beforeText)) {
      log("Already signed in today.");
      return;
    }

    const action = await findAction(page);
    if (!action) {
      const screenshot = path.join(logDir, `musicful-signin-${stamp}.png`);
      await page.screenshot({ path: screenshot, fullPage: true });
      log(`No visible sign-in action was found. Screenshot saved: ${screenshot}`);
      if (/(累計|累计|Total).{0,20}\d+/i.test(beforeText)) {
        log("Growth Center is reachable; it may already be signed in or the button text changed.");
        return;
      }
      throw new Error("Could not find the Musicful sign-in action.");
    }

    log(`Clicking sign-in action: ${action.label}`);
    await action.locator.click({ timeout: 10_000 });
    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(3000);

    const afterText = await visibleText(page);
    const success = /(已簽到|已签到|今日已|今天已|success|signed|checked|累計|累计|Total)/i.test(afterText);
    if (!success) {
      const screenshot = path.join(logDir, `musicful-signin-${stamp}.png`);
      await page.screenshot({ path: screenshot, fullPage: true });
      throw new Error(`Clicked the action, but could not confirm success. Screenshot saved: ${screenshot}`);
    }

    log("Musicful sign-in finished.");
  } finally {
    await context.close();
    if (browser) {
      await browser.close();
    }
  }
}

main().catch((error) => {
  log(`Failed: ${error.message}`);
  process.exitCode = 1;
});
