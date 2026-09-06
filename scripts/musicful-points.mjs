// Match the pricing-page balance label, never growth rewards or plan amounts.
export function parsePoints(text) {
  const match = text.match(/(?:^|\n)\s*(?:積分|积分|Credits|Points)\s*[:：]\s*(\d{1,3}(?:,\d{3})+|\d+)(?![\d,.])/i);
  return match ? Number(match[1].replaceAll(",", "")) : null;
}

export async function readPoints(context) {
  const page = await context.newPage();
  try {
    await page.goto("https://tw.musicful.ai/pricing/", { waitUntil: "domcontentloaded", timeout: 60_000 });
    const deadline = Date.now() + 15_000;
    do {
      const points = parsePoints(await page.locator("body").innerText());
      if (points !== null) return points;
      await page.waitForTimeout(500);
    } while (Date.now() < deadline);
    return null;
  } finally {
    await page.close();
  }
}
