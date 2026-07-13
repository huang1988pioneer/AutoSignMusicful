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
      return "✅ checked_in";
    case "already_done":
      return "☑️ already_done";
    case "failed":
      return "❌ failed";
    case "skipped":
      return "⏭️ skipped";
    default:
      return `❔ ${status || "unknown"}`;
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
  if (row.status === "checked_in") return "new today";
  if (row.status === "already_done") return "claimed earlier";
  if (row.status === "failed") return compactMessage(row.message, 80);
  if (row.status === "skipped") {
    if (isNoSecretSkip(row)) return "no secret";
    if (isNotSelectedSkip(row)) return "not selected";
    return compactMessage(row.message, 80);
  }
  return compactMessage(row.message, 80);
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
    ok: checkedIn.length + alreadyDone.length
  };

  const generatedAt = meta.generatedAt || new Date().toISOString();
  const title = meta.title || "Musicful daily sign-in";
  const accountNums = rows.map((r) => r.account).filter((n) => Number.isFinite(n));
  const accountMin = accountNums.length ? Math.min(...accountNums) : null;
  const accountMax = accountNums.length ? Math.max(...accountNums) : null;

  const headline =
    counts.failed === 0 && counts.configured > 0
      ? "✅ All configured accounts OK"
      : counts.failed > 0
        ? `⚠️ ${counts.failed} account(s) need attention`
        : counts.configured === 0
          ? "ℹ️ No configured accounts ran"
          : "ℹ️ Summary";

  const lines = [
    `## ${title}`,
    "",
    `**${headline}**`,
    "",
    "| Metric | Count |",
    "| --- | ---: |",
    `| Configured (ran) | ${counts.configured} |`,
    `| New check-in | ${counts.checked_in} |`,
    `| Already done | ${counts.already_done} |`,
    `| OK total | ${counts.ok} |`,
    `| Failed | ${counts.failed} |`,
    `| Skipped (no secret) | ${counts.skipped_no_secret} |`,
    counts.skipped_not_selected
      ? `| Skipped (not selected) | ${counts.skipped_not_selected} |`
      : null,
    counts.unknown ? `| Other | ${counts.unknown} |` : null,
    "",
    accountMin != null && accountMax != null
      ? `<sub>Accounts ${accountMin}–${accountMax} · ${generatedAt}</sub>`
      : `<sub>${generatedAt}</sub>`,
    meta.runUrl ? "" : null,
    meta.runUrl ? `Workflow run: ${meta.runUrl}` : null,
    ""
  ].filter((line) => line !== null);

  if (failedRows.length > 0) {
    lines.push("### ⚠️ Needs attention", "");
    lines.push("| # | Account | Error |");
    lines.push("| ---: | --- | --- |");
    for (const row of [...failedRows].sort(
      (a, b) => (a.account ?? 9999) - (b.account ?? 9999)
    )) {
      const no = row.account ?? "—";
      lines.push(
        `| ${no} | ${escapeCell(shortLabel(row))} | ${escapeCell(compactMessage(row.message || "failed", 160))} |`
      );
    }
    lines.push("", "_Per-account result JSON: artifact `signin-result-N` · Daily report: `signin-daily-summary`._", "");
  }

  const ranRows = rows.filter((r) => r.status !== "skipped");
  if (ranRows.length > 0) {
    lines.push("### Account results", "");
    lines.push("| # | Account | Status | Growth | Music | Streak | Note |");
    lines.push("| ---: | --- | --- | ---: | ---: | ---: | --- |");
    for (const row of ranRows) {
      const no = row.account ?? "—";
      lines.push(
        `| ${no} | ${escapeCell(shortLabel(row))} | ${statusBadge(row.status)} | ${fmtReward(
          row.growthPoints
        )} | ${fmtNum(row.musicPoints)} | ${fmtNum(row.streakDays)} | ${escapeCell(noteForRow(row))} |`
      );
    }
    lines.push("");
  }

  if (noSecretRows.length > 0 || notSelectedRows.length > 0 || otherSkipped.length > 0) {
    lines.push("### Skipped", "");
    if (noSecretRows.length > 0) {
      const ids = noSecretRows.map((r) => r.account ?? "?").join(", ");
      lines.push(`No secret / storage: **#${ids}**`, "");
    }
    if (notSelectedRows.length > 0) {
      const ids = notSelectedRows.map((r) => r.account ?? "?").join(", ");
      lines.push(`Not selected this run: **#${ids}**`, "");
    }
    if (otherSkipped.length > 0) {
      for (const row of otherSkipped) {
        lines.push(`- **#${row.account ?? "?"} ${escapeCell(shortLabel(row))}**: ${escapeCell(row.message || "skipped")}`);
      }
      lines.push("");
    }
  }

  if (counts.configured === 0 && counts.total > 0) {
    lines.push(
      "### Next step",
      "",
      "Add GitHub Secrets `MUSICFUL_STORAGE_STATE_BASE64_N` (export via `npm run export-state` after `npm run setup`).",
      ""
    );
  }

  lines.push(
    "---",
    "",
    "<sub>Status: `checked_in` = claimed this run · `already_done` = already claimed today · `failed` = needs re-auth or layout change</sub>",
    ""
  );

  return { markdown: `${lines.join("\n")}\n`, counts };
}

function printConsoleTable(rows, counts) {
  console.log("\n========== Musicful daily sign-in summary ==========");
  console.log(
    `Configured: ${counts.configured} | checked_in: ${counts.checked_in} | already_done: ${counts.already_done} | skipped: ${counts.skipped} | failed: ${counts.failed}`
  );
  for (const row of rows) {
    if (row.status === "skipped") continue;
    console.log(
      `- #${row.account ?? "?"} ${shortLabel(row)}: ${row.status} | streak ${fmtNum(row.streakDays)} | growth ${fmtNum(row.growthPoints)} | ${row.message}`
    );
  }
  if (counts.skipped_no_secret > 0) {
    console.log(`Skipped (no secret): ${counts.skipped_no_secret}`);
  }
  console.log("====================================================\n");
}

function main() {
  const inputDir = process.argv[2] || path.join(process.cwd(), "collected");
  const outDir = process.env.MUSICFUL_SUMMARY_DIR || path.join(process.cwd(), "artifacts");
  const expectedCount = Number(process.env.MUSICFUL_EXPECTED_ACCOUNTS || 33);

  const rows = loadRows(inputDir);
  if (rows.length === 0) {
    const message = `No sign-in result JSON found under ${inputDir}`;
    console.error(message);
    if (process.env.GITHUB_STEP_SUMMARY) {
      fs.appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `## Musicful daily sign-in\n\n❌ ${message}\n`,
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
    title: "Musicful daily sign-in",
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
  fs.writeFileSync(mdPath, markdown, "utf8");
  fs.writeFileSync(
    jsonPath,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        runUrl,
        expectedCount: Number.isFinite(expectedCount) ? expectedCount : null,
        counts,
        rows
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  console.log(`Wrote ${mdPath}`);
  console.log(`Wrote ${jsonPath}`);

  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown, "utf8");
    console.log(`Wrote GitHub Job Summary to ${process.env.GITHUB_STEP_SUMMARY}`);
  }

  if (counts.failed > 0) {
    console.error(`Daily summary detected problems: ${counts.failed} account(s) failed`);
    process.exitCode = 1;
  }
}

main();
