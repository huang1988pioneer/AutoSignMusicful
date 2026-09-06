import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parsePoints } from "../scripts/musicful-points.mjs";

test("pricing balance excludes growth rewards and plan prices", () => {
  assert.equal(parsePoints("積分：138\nNT$227\n28000"), 138);
  assert.equal(parsePoints("積分：\n1,985"), 1985);
  assert.equal(parsePoints("積分：0"), 0);
  assert.equal(parsePoints("已獲得成長積分：7670\n6000\n積分明細"), null);
  assert.equal(parsePoints("積分：載入中"), null);
});

test("summary preserves balance, zero and missing values in all artifacts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicful-points-"));
  try {
    fs.writeFileSync(path.join(dir, "signin-result.json"), JSON.stringify([
      { account: 1, name: "one", status: "checked_in", streakDays: 5, points: 1985 },
      { account: 2, name: "two", status: "already_done", points: 0 },
      { account: 3, name: "old", status: "already_done" }
    ]));
    const run = spawnSync(process.execPath, ["scripts/summarize-signin-results.mjs", dir], {
      encoding: "utf8", env: { ...process.env, MUSICFUL_SUMMARY_DIR: dir, GITHUB_STEP_SUMMARY: path.join(dir, "job.md") }
    });
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(fs.readFileSync(path.join(dir, "signin-daily-summary.json")));
    assert.deepEqual(report.rows.map(r => r.points), [1985, 0, null]);
    const streaks = JSON.parse(fs.readFileSync(path.join(dir, "signin-streaks.json")));
    assert.deepEqual(streaks.accounts.map(r => r.points), [1985, 0, null]);
    assert.match(run.stdout, /積分餘額 1985/);
    assert.match(run.stdout, /積分餘額 0/);
    assert.match(run.stdout, /積分餘額 —/);
    assert.match(fs.readFileSync(path.join(dir, "job.md"), "utf8"), /\| 5 \| 1985 \|/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
