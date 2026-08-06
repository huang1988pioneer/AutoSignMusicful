import { chromium, firefox } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const profileIndex = args.findIndex((arg) => arg === "--profile");
const profile = (args.find((arg) => arg.startsWith("--profile="))?.slice(10)
  || (profileIndex >= 0 ? args[profileIndex + 1] : ""))
  .replace(/[^A-Za-z0-9_-]/g, "-");
const browserIndex = args.findIndex((arg) => arg === "--browser");
const browserRaw = (args.find((arg) => arg.startsWith("--browser="))?.slice("--browser=".length)
  || (browserIndex >= 0 ? args[browserIndex + 1] : "")
  || process.env.MUSICFUL_BROWSER
  || "chrome").trim().toLowerCase();

/** @type {"chrome" | "edge" | "firefox" | null} */
const browserChoice =
  browserRaw === "firefox" || browserRaw === "ff"
    ? "firefox"
    : (["edge", "msedge", "microsoft-edge", "microsoftedge", "microsoft_edge"].includes(browserRaw)
      ? "edge"
      : (["chrome", "chromium", "google-chrome", "googlechrome", "google_chrome"].includes(browserRaw)
        ? "chrome"
        : null));
if (!browserChoice) {
  throw new Error(`Unsupported browser "${browserRaw}". Use chrome (default), edge, or firefox.`);
}
const stateFile = path.join(rootDir, "logs", `musicful-storage-state-${profile}.base64`);

function readMatch(text, pattern) {
  const match = text.match(pattern);
  return match ? Number(match[1]) : null;
}

if (!profile || !fs.existsSync(stateFile)) {
  throw new Error("找不到此帳號的登入狀態。請先在桌面工具執行「開始登入並匯出」。");
}

const storageState = JSON.parse(Buffer.from(fs.readFileSync(stateFile, "utf8").trim(), "base64").toString("utf8"));
const launcher = browserChoice === "firefox" ? firefox : chromium;
/** @type {import("playwright").LaunchOptions} */
const launchOptions = { headless: true };
if (browserChoice === "edge") {
  launchOptions.channel = "msedge";
}
const browser = await launcher.launch(launchOptions);
try {
  const context = await browser.newContext({ storageState, locale: "zh-TW", timezoneId: "Asia/Taipei" });
  const page = await context.newPage();
  await page.goto("https://tw.musicful.ai/growth-center/", { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(2_500);
  const text = await page.locator("body").innerText();
  const result = {
    growthPoints: readMatch(text, /已獲得成長積分\s*(\d+)/),
    musicPoints: readMatch(text, /(\d+)\s*\/\s*\d+\s*音樂點/),
    musicPointsMax: readMatch(text, /\d+\s*\/\s*(\d+)\s*音樂點/),
    points: readMatch(text, /(?<!成長)積分[\s：:]*(\d+)/),
    streakDays: readMatch(text, /累[計计]\s*[：:]?\s*(\d+)\s*天/)
      ?? readMatch(text, /[連连][續续][簽签]到\s*[：:]?\s*(\d+)/)
      ?? readMatch(text, /streak\s*[：:]?\s*(\d+)/i),
    fetchedAt: new Date().toISOString()
  };
  if (Object.values(result).slice(0, 5).every((value) => value === null)) {
    throw new Error("未在成長中心找到積分資料；登入狀態可能已過期。");
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  await context.close();
} finally {
  await browser.close();
}
