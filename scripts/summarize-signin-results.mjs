import fs from "node:fs";
import path from "node:path";

const STATUS_ORDER = {
  failed: 0,
  checked_in: 1,
  already_done: 2,
  skipped: 3,
  unknown: 9
};

function walkJsonFiles(rootDir) {
  const files = [];

  function visit(current) {
    if (!fs.existsSync(current)) return;
    const stat = fs.statSync(current);
    if (stat.isFile()) {
      if (current.endsWith(".json") && path.basename(current).includes("signin-result")) {
        files.push(current);
      }
      return;
    }
    if (!stat.isDirectory()) return;
    for (const entry of fs.readdirSync(current)) {
      visit(path.join(current, entry));
    }
  }

  visit(rootDir);
  return files;
}

function loadRows(rootDir) {
  const files = walkJsonFiles(rootDir);
  const rows = [];

  for (const file of files) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      console.warn(`Skip invalid JSON: ${file} (${error.message})`);
      continue;
    }

    const list = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      if (!item.name && item.account == null && !item.label) continue;
      rows.push({
        account: item.account ?? null,
        label: item.label || null,
        name: item.name || (item.account != null ? `MUSICFUL_STORAGE_STATE_BASE64_${item.account}` : "unknown"),
        status: item.status || "unknown",
        message: item.message || "",
        streakDays: item.streakDays ?? null,
        growthPoints: item.growthPoints ?? null,
        musicPoints: item.musicPoints ?? null,
        points: item.points ?? null,
        finishedAt: item.finishedAt || null,
        source: file
      });
    }
  }

  const byKey = new Map();
  for (const row of rows) {
    const key = row.account != null ? `account:${row.account}` : `name:${row.name}`;
    byKey.set(key, row);
  }

  return [...byKey.values()].sort((a, b) => {
    const aNum = a.account ?? Number.MAX_SAFE_INTEGER;
    const bNum = b.account ?? Number.MAX_SAFE_INTEGER;
    if (aNum !== bNum) return aNum - bNum;
    return String(a.name).localeCompare(String(b.name));
  });
}

function fmtNum(value) {
  if (value === null || value === undefined) return "—";
  const num = Number(value);
  return Number.isFinite(num) ? String(num) : "—";
}

function fmtReward(value) {
  if (value === null || value === undefined) return "—";
  const num = Number(value);
  return Number.isFinite(num) ? `+${num}` : "—";
}

function escapeCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function shortLabel(row) {
  const raw = row.label || row.name || "unknown";
  return String(raw)
    .replace(/\s*\(\d+\)\s*$/, "")
    .replace(/-checkin$/i, "")
    .replace(/^MUSICFUL_STORAGE_STATE_BASE64_?/i, "#")
    .trim();
}

function statusBadge(status) {
  switch (status) {
    case "checked_in":
      return "✅ 今日簽到";
    case "already_done":
      return "☑️ 已簽過";
    case "failed":
      return "❌ 失敗";
    case "skipped":
      return "⏭️ 略過";
    default:
      return `❔ ${status || "未知"}`;
  }
}

function compactMessage(message, max = 120) {
  const text = String(message || "").replace(/\s+/g, " ").trim();
  if (!text) return "—";
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function isNoSecretSkip(row) {
  if (row.status !== "skipped") return false;
  const msg = String(row.message || "").toLowerCase();
  return msg.includes("not configured") || msg.includes("no secret") || msg.includes("missing");
}

function isNotSelectedSkip(row) {
  if (row.status !== "skipped") return false;
  const msg = String(row.message || "").toLowerCase();
  return msg.includes("not selected") || msg.includes("workflow_dispatch");
}

function noteForRow(row) {
  if (row.status === "checked_in") return "本次新簽";
  if (row.status === "already_done") return "今日已領";
  if (row.status === "failed") return compactMessage(row.message, 80);
  if (row.status === "skipped") {
    if (isNoSecretSkip(row)) return "未設定 secret";
    if (isNotSelectedSkip(row)) return "本次未選";
    return compactMessage(row.message, 80);
  }
  return compactMessage(row.message, 80);
}

/** Aggregate continuous sign-in day stats for ran (non-skipped) accounts. */
function buildStreakStats(rows) {
  const ranRows = rows.filter((r) => r.status !== "skipped");
  // Do not use Number(null) — it becomes 0 and would falsely count missing streaks.
  const values = [];
  for (const row of ranRows) {
    if (row.streakDays == null || row.streakDays === "") continue;
    const n = Number(row.streakDays);
    if (Number.isFinite(n)) values.push(n);
  }
  const recorded = values.length;
  const missing = ranRows.length - recorded;
  if (recorded === 0) {
    return {
      total: ranRows.length,
      recorded: 0,
      missing: ranRows.length,
      min: null,
      max: null,
      avg: null,
      sum: null
    };
  }
  const sum = values.reduce((acc, n) => acc + n, 0);
  return {
    total: ranRows.length,
    recorded,
    missing,
    min: Math.min(...values),
    max: Math.max(...values),
    avg: Math.round((sum / recorded) * 10) / 10,
    sum
  };
}

function buildMarkdown(rows, meta = {}) {
  const configuredRows = rows.filter((r) => r.status !== "skipped");
  const checkedIn = rows.filter((r) => r.status === "checked_in");
  const alreadyDone = rows.filter((r) => r.status === "already_done");
  const failedRows = rows.filter((r) => r.status === "failed");
  const skippedRows = rows.filter((r) => r.status === "skipped");
  const noSecretRows = skippedRows.filter(isNoSecretSkip);
  const notSelectedRows = skippedRows.filter(isNotSelectedSkip);
  const otherSkipped = skippedRows.filter((r) => !isNoSecretSkip(r) && !isNotSelectedSkip(r));
  const unknownRows = rows.filter(
    (r) => !["checked_in", "already_done", "skipped", "failed"].includes(r.status)
  );

  const streakStats = buildStreakStats(rows);
  const counts = {
    total: rows.length,
    configured: configuredRows.length,
    checked_in: checkedIn.length,
    already_done: alreadyDone.length,
    skipped: skippedRows.length,
    skipped_no_secret: noSecretRows.length,
    skipped_not_selected: notSelectedRows.length,
    failed: failedRows.length,
    unknown: unknownRows.length,
    ok: checkedIn.length + alreadyDone.length,
    streak_recorded: streakStats.recorded,
    streak_missing: streakStats.missing,
    streak_min: streakStats.min,
    streak_max: streakStats.max,
    streak_avg: streakStats.avg,
    streak_sum: streakStats.sum
  };

  const generatedAt = meta.generatedAt || new Date().toISOString();
  const title = meta.title || "Musicful 每日簽到";
  const accountNums = rows.map((r) => r.account).filter((n) => Number.isFinite(n));
  const accountMin = accountNums.length ? Math.min(...accountNums) : null;
  const accountMax = accountNums.length ? Math.max(...accountNums) : null;

  const headline =
    counts.failed === 0 && counts.configured > 0
      ? "✅ 所有已設定帳號皆正常"
      : counts.failed > 0
        ? `⚠️ ${counts.failed} 個帳號需關注`
        : counts.configured === 0
          ? "ℹ️ 沒有已設定的帳號執行"
          : "ℹ️ 摘要";

  const lines = [
    `## ${title}`,
    "",
    `**${headline}**`,
    "",
    "| 項目 | 數量 |",
    "| --- | ---: |",
    `| 已執行（有 secret） | ${counts.configured} |`,
    `| 今日新簽到 | ${counts.checked_in} |`,
    `| 先前已簽到 | ${counts.already_done} |`,
    `| 成功合計 | ${counts.ok} |`,
    `| 失敗 | ${counts.failed} |`,
    `| 略過（未設定 secret） | ${counts.skipped_no_secret} |`,
    counts.skipped_not_selected
      ? `| 略過（本次未選） | ${counts.skipped_not_selected} |`
      : null,
    counts.unknown ? `| 其他 | ${counts.unknown} |` : null,
    counts.configured > 0
      ? `| 已紀錄連續簽到 | ${streakStats.recorded}/${streakStats.total} |`
      : null,
    streakStats.recorded > 0
      ? `| 連續簽到天數（最高 / 最低 / 平均） | ${fmtNum(streakStats.max)} / ${fmtNum(streakStats.min)} / ${fmtNum(streakStats.avg)} |`
      : null,
    "",
    accountMin != null && accountMax != null
      ? `<sub>帳號 ${accountMin}–${accountMax} · ${generatedAt}</sub>`
      : `<sub>${generatedAt}</sub>`,
    meta.runUrl ? "" : null,
    meta.runUrl ? `Workflow 執行：${meta.runUrl}` : null,
    ""
  ].filter((line) => line !== null);

  if (failedRows.length > 0) {
    lines.push("### ⚠️ 需關注", "");
    lines.push("| # | 帳號 | 錯誤 |");
    lines.push("| ---: | --- | --- |");
    for (const row of [...failedRows].sort(
      (a, b) => (a.account ?? 9999) - (b.account ?? 9999)
    )) {
      const no = row.account ?? "—";
      lines.push(
        `| ${no} | ${escapeCell(shortLabel(row))} | ${escapeCell(compactMessage(row.message || "失敗", 160))} |`
      );
    }
    lines.push("", "_各帳號結果 JSON：artifact `signin-result-N` · 每日報告：`signin-daily-summary`。_", "");
  }

  const ranRows = rows.filter((r) => r.status !== "skipped");
  if (ranRows.length > 0) {
    lines.push("### 各帳號結果", "");
    lines.push("| # | 帳號 | 狀態 | 成長點 | 音樂點 | 連續簽到天數 | 積分餘額 | 備註 |");
    lines.push("| ---: | --- | --- | ---: | ---: | ---: | ---: | --- |");
    for (const row of ranRows) {
      const no = row.account ?? "—";
      lines.push(
        `| ${no} | ${escapeCell(shortLabel(row))} | ${statusBadge(row.status)} | ${fmtReward(
          row.growthPoints
        )} | ${fmtNum(row.musicPoints)} | ${fmtNum(row.streakDays)} | ${fmtNum(row.points)} | ${escapeCell(noteForRow(row))} |`
      );
    }
    lines.push("");

    // Always list every ran account so missing streaks stay visible as "—".
    lines.push("### 連續簽到天數", "");
    lines.push(
      `已紀錄 **${streakStats.recorded}/${streakStats.total}** 個帳號` +
        (streakStats.recorded > 0
          ? ` · 最高 **${fmtNum(streakStats.max)}** 天 · 最低 **${fmtNum(streakStats.min)}** 天 · 平均 **${fmtNum(streakStats.avg)}** 天 · 合計 **${fmtNum(streakStats.sum)}** 天`
          : " · 尚無有效天數") +
        (streakStats.missing > 0 ? ` · ${streakStats.missing} 個帳號未擷取到` : ""),
      ""
    );
    lines.push("| # | 帳號 | 連續簽到天數 | 狀態 |");
    lines.push("| ---: | --- | ---: | --- |");
    for (const row of [...ranRows].sort(
      (a, b) =>
        (Number.isFinite(b.streakDays) ? b.streakDays : -1)
        - (Number.isFinite(a.streakDays) ? a.streakDays : -1)
        || (a.account ?? 0) - (b.account ?? 0)
    )) {
      lines.push(
        `| ${row.account ?? "—"} | ${escapeCell(shortLabel(row))} | ${fmtNum(row.streakDays)} | ${statusBadge(row.status)} |`
      );
    }
    lines.push("");

  }

  if (noSecretRows.length > 0 || notSelectedRows.length > 0 || otherSkipped.length > 0) {
    lines.push("### 略過", "");
    if (noSecretRows.length > 0) {
      const ids = noSecretRows.map((r) => r.account ?? "?").join(", ");
      lines.push(`未設定 secret / storage：**#${ids}**`, "");
    }
    if (notSelectedRows.length > 0) {
      const ids = notSelectedRows.map((r) => r.account ?? "?").join(", ");
      lines.push(`本次未選取：**#${ids}**`, "");
    }
    if (otherSkipped.length > 0) {
      for (const row of otherSkipped) {
        lines.push(`- **#${row.account ?? "?"} ${escapeCell(shortLabel(row))}**：${escapeCell(row.message || "略過")}`);
      }
      lines.push("");
    }
  }

  if (counts.configured === 0 && counts.total > 0) {
    lines.push(
      "### 下一步",
      "",
      "請新增 GitHub Secrets `MUSICFUL_STORAGE_STATE_BASE64_N`（先 `npm run setup`，再 `npm run export-state` 匯出）。",
      ""
    );
  }

  lines.push(
    "---",
    "",
    "<sub>狀態說明：`今日簽到` = 本次成功領取 · `已簽過` = 今日稍早已領 · `失敗` = 需重新登入或頁面結構變更</sub>",
    ""
  );

  return { markdown: `${lines.join("\n")}\n`, counts };
}

function printConsoleTable(rows, counts) {
  console.log("\n========== Musicful 每日簽到摘要 ==========");
  console.log(
    `已執行: ${counts.configured} | 今日新簽: ${counts.checked_in} | 先前已簽: ${counts.already_done} | 略過: ${counts.skipped} | 失敗: ${counts.failed}`
  );
  if (counts.configured > 0) {
    console.log(
      `連續簽到: 已紀錄 ${counts.streak_recorded}/${counts.configured}` +
        (counts.streak_recorded > 0
          ? ` | 最高 ${fmtNum(counts.streak_max)} | 最低 ${fmtNum(counts.streak_min)} | 平均 ${fmtNum(counts.streak_avg)} | 合計 ${fmtNum(counts.streak_sum)}`
          : "")
    );
  }
  for (const row of rows) {
    if (row.status === "skipped") continue;
    console.log(
      `- #${row.account ?? "?"} ${shortLabel(row)}: ${statusBadge(row.status)} | 連續簽到 ${fmtNum(row.streakDays)} 天 | 積分餘額 ${fmtNum(row.points)} | 成長 ${fmtNum(row.growthPoints)} | ${row.message}`
    );
  }
  if (counts.skipped_no_secret > 0) {
    console.log(`略過（未設定 secret）: ${counts.skipped_no_secret}`);
  }
  console.log("==========================================\n");
}

function main() {
  const inputDir = process.argv[2] || path.join(process.cwd(), "collected");
  const outDir = process.env.MUSICFUL_SUMMARY_DIR || path.join(process.cwd(), "artifacts");
  const expectedCount = Number(process.env.MUSICFUL_EXPECTED_ACCOUNTS || 33);

  const rows = loadRows(inputDir);
  if (rows.length === 0) {
    const message = `在 ${inputDir} 下找不到簽到結果 JSON`;
    console.error(message);
    if (process.env.GITHUB_STEP_SUMMARY) {
      fs.appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `## Musicful 每日簽到\n\n❌ ${message}\n`,
        "utf8"
      );
    }
    process.exitCode = 1;
    return;
  }

  const serverUrl = process.env.GITHUB_SERVER_URL || "https://github.com";
  const repository = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  const runUrl =
    repository && runId ? `${serverUrl}/${repository}/actions/runs/${runId}` : null;

  const { markdown, counts } = buildMarkdown(rows, {
    title: "Musicful 每日簽到",
    generatedAt: new Date().toISOString(),
    runUrl
  });

  printConsoleTable(rows, counts);

  // Always print markdown for log searchability (same as LitVideo).
  console.log("----- GITHUB SUMMARY (markdown) -----");
  console.log(markdown);
  console.log("----- END GITHUB SUMMARY -----");

  fs.mkdirSync(outDir, { recursive: true });
  const mdPath = path.join(outDir, "signin-daily-summary.md");
  const jsonPath = path.join(outDir, "signin-daily-summary.json");
  const streakPath = path.join(outDir, "signin-streaks.json");
  const generatedAt = new Date().toISOString();
  const streakStats = buildStreakStats(rows);
  const streaks = rows
    .filter((row) => row.status !== "skipped")
    .map((row) => ({
      account: row.account,
      label: shortLabel(row),
      name: row.name,
      status: row.status,
      streakDays: row.streakDays ?? null,
      growthPoints: row.growthPoints ?? null,
      musicPoints: row.musicPoints ?? null,
      points: row.points ?? null,
      finishedAt: row.finishedAt || null
    }));

  fs.writeFileSync(mdPath, markdown, "utf8");
  fs.writeFileSync(
    jsonPath,
    `${JSON.stringify(
      {
        generatedAt,
        runUrl,
        expectedCount: Number.isFinite(expectedCount) ? expectedCount : null,
        counts,
        streakStats,
        rows,
        streaks
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  fs.writeFileSync(
    streakPath,
    `${JSON.stringify(
      {
        generatedAt,
        runUrl,
        expectedCount: Number.isFinite(expectedCount) ? expectedCount : null,
        ...streakStats,
        accounts: streaks
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  console.log(`已寫入 ${mdPath}`);
  console.log(`已寫入 ${jsonPath}`);
  console.log(
    `已寫入 ${streakPath}（${streakStats.recorded}/${streakStats.total} 個帳號已紀錄連續簽到天數` +
      (streakStats.recorded > 0
        ? `；最高 ${streakStats.max} / 最低 ${streakStats.min} / 平均 ${streakStats.avg}`
        : "") +
      "）"
  );

  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown, "utf8");
    console.log(`已寫入 GitHub Job Summary：${process.env.GITHUB_STEP_SUMMARY}`);
  }

  if (counts.failed > 0) {
    console.error(`每日摘要發現問題：${counts.failed} 個帳號失敗`);
    process.exitCode = 1;
  }
}

main();
