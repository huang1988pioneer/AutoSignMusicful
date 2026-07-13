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
  if (value === null || value === undefined) return "n/a";
  const num = Number(value);
  return Number.isFinite(num) ? String(num) : "n/a";
}

function escapeCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function buildMarkdown(rows, meta = {}) {
  const counts = {
    total: rows.length,
    checked_in: rows.filter((r) => r.status === "checked_in").length,
    already_done: rows.filter((r) => r.status === "already_done").length,
    skipped: rows.filter((r) => r.status === "skipped").length,
    failed: rows.filter((r) => r.status === "failed").length,
    unknown: rows.filter((r) => !["checked_in", "already_done", "skipped", "failed"].includes(r.status)).length
  };

  const generatedAt = meta.generatedAt || new Date().toISOString();
  const title = meta.title || "Musicful daily sign-in summary";

  const lines = [
    `# ${title}`,
    "",
    `- Generated at: \`${generatedAt}\``,
    meta.runUrl ? `- Workflow run: ${meta.runUrl}` : null,
    `- Accounts reported: **${counts.total}**`,
    `- checked_in: **${counts.checked_in}** | already_done: **${counts.already_done}** | skipped: **${counts.skipped}** | failed: **${counts.failed}**${counts.unknown ? ` | other: **${counts.unknown}**` : ""}`,
    "",
    `| # | Label | Secret | Status | Streak | Growth pts | Music pts | Detail |`,
    `| ---: | --- | --- | --- | ---: | ---: | ---: | --- |`,
    ...rows.map((row) => {
      const no = row.account ?? "-";
      const label = row.label || "-";
      return `| ${no} | ${escapeCell(label)} | ${escapeCell(row.name)} | ${escapeCell(row.status)} | ${fmtNum(
        row.streakDays
      )} | ${fmtNum(row.growthPoints)} | ${fmtNum(row.musicPoints)} | ${escapeCell(row.message)} |`;
    }),
    ""
  ].filter((line) => line !== null);

  const failedRows = rows
    .filter((r) => r.status === "failed")
    .sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9));

  if (failedRows.length > 0) {
    lines.push("## Failed accounts", "");
    for (const row of failedRows) {
      const who = row.label || row.name;
      lines.push(`- **${escapeCell(who)}** (\`${escapeCell(row.name)}\`): ${escapeCell(row.message)}`);
    }
    lines.push("");
  }

  const skippedRows = rows.filter((r) => r.status === "skipped");
  if (skippedRows.length > 0) {
    lines.push("## Skipped accounts", "");
    for (const row of skippedRows) {
      const who = row.label || row.name;
      lines.push(`- **${escapeCell(who)}**: ${escapeCell(row.message || "skipped")}`);
    }
    lines.push("");
  }

  return { markdown: `${lines.join("\n")}\n`, counts };
}

function printConsoleTable(rows, counts) {
  console.log("\n========== Musicful daily sign-in summary ==========");
  console.log(
    `Total: ${counts.total} | checked_in: ${counts.checked_in} | already_done: ${counts.already_done} | skipped: ${counts.skipped} | failed: ${counts.failed}`
  );
  for (const row of rows) {
    console.log(
      `- #${row.account ?? "?"} ${row.label || row.name}: ${row.status} | streak ${fmtNum(row.streakDays)} | growth ${fmtNum(row.growthPoints)} | ${row.message}`
    );
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
        `# Musicful daily sign-in summary\n\n❌ ${message}\n`,
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
    title: "Musicful daily sign-in summary",
    generatedAt: new Date().toISOString(),
    runUrl
  });

  printConsoleTable(rows, counts);

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
  }

  if (counts.failed > 0) {
    console.error(`Daily summary detected problems: ${counts.failed} account(s) failed`);
    process.exitCode = 1;
  }
}

main();
