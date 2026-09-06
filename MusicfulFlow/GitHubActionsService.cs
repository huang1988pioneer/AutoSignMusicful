using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace MusicfulFlow;

internal sealed class GitHubActionsService
{
    private const string Workflow = "musicful-auto-sign.yml";
    // GitHub rejects an Actions secret larger than 64 KB outright.
    private const int GitHubSecretLimitBytes = 65_536;
    private readonly string _workspace;

    public GitHubActionsService(string workspace) => _workspace = workspace;

    public async Task UpdateSecretAsync(string repository, string secretName, string value)
    {
        if (string.IsNullOrWhiteSpace(value)) throw new InvalidOperationException("登入狀態是空的，請重新登入並匯出。");
        var valueBytes = Encoding.UTF8.GetByteCount(value);
        if (valueBytes > GitHubSecretLimitBytes)
            throw new InvalidOperationException(
                $"登入狀態為 {valueBytes:N0} bytes，超過 GitHub Secret 的 {GitHubSecretLimitBytes:N0} bytes 上限。請重新執行「開始登入並匯出」（匯出時會自動移除分析與歌曲快取資料）。");
        await RunGhAsync(["secret", "set", secretName, "--repo", repository, "--app", "actions"], value);
    }

    public async Task TriggerAsync(string repository, int? account)
    {
        var args = new List<string> { "workflow", "run", Workflow, "--repo", repository, "--ref", "main" };
        if (account is not null) args.AddRange(["-f", $"account_index={account}"]);
        await RunGhAsync(args);
    }

    public async Task<RunInfo?> GetLatestAsync(string repository)
    {
        var output = await RunGhAsync(["run", "list", "--workflow", Workflow, "--repo", repository, "--limit", "1", "--json", "databaseId,status,conclusion,createdAt,updatedAt,url"]);
        return JsonSerializer.Deserialize<List<RunInfo>>(output, new JsonSerializerOptions { PropertyNameCaseInsensitive = true })?.FirstOrDefault();
    }

    public async Task<AccountStreakStatus[]> GetAccountStreakStatusesAsync(string repository, long runId)
    {
        var output = await RunGhAsync(["run", "view", runId.ToString(), "--repo", repository, "--log"]);
        var byNumber = new Dictionary<int, AccountStreakStatus>();

        // Console summary lines, e.g.
        // - #1 goldshoot0720: ✅ 今日簽到 | 連續簽到 12 天 | 成長 100 | ...
        // Also accepts older "連續 12" form without "簽到/天".
        foreach (Match match in Regex.Matches(
                     output,
                     @"-\s*#(?<number>\d+)\s+(?<alias>[^:\r\n]+):\s*(?<badge>[✅☑️❌⏭️❔][^\|]*?)\|\s*連續(?:簽到)?\s+(?<days>\d+|—|-)\s*(?:天\s*)?\|",
                     RegexOptions.Multiline))
        {
            if (!int.TryParse(match.Groups["number"].Value, out var number)) continue;
            var daysText = match.Groups["days"].Value.Trim();
            int? days = int.TryParse(daysText, out var parsed) ? parsed : null;
            var badge = match.Groups["badge"].Value;
            var ran = badge.Contains("✅", StringComparison.Ordinal)
                || badge.Contains("☑️", StringComparison.Ordinal)
                || badge.Contains("❌", StringComparison.Ordinal);
            byNumber[number] = new AccountStreakStatus(
                number,
                match.Groups["alias"].Value.Trim(),
                days,
                ran || days is not null);
        }

        // Markdown table rows as a fallback:
        // | 1 | label | ✅ 今日簽到 | +10 | 20 | 12 | 本次新簽 |
        foreach (Match match in Regex.Matches(
                     output,
                     @"\|\s*(?<number>\d+)\s*\|\s*(?<alias>[^|\r\n]+?)\s*\|\s*(?<status>[^|\r\n]+?)\s*\|\s*[^|\r\n]*\|\s*[^|\r\n]*\|\s*(?<days>\d+|—|-)\s*\|",
                     RegexOptions.Multiline))
        {
            if (!int.TryParse(match.Groups["number"].Value, out var number)) continue;
            if (byNumber.ContainsKey(number)) continue;
            var status = match.Groups["status"].Value;
            if (status.Contains("略過", StringComparison.Ordinal) || status.Contains("⏭️", StringComparison.Ordinal)) continue;
            var daysText = match.Groups["days"].Value.Trim();
            int? days = int.TryParse(daysText, out var parsed) ? parsed : null;
            byNumber[number] = new AccountStreakStatus(
                number,
                match.Groups["alias"].Value.Trim(),
                days,
                true);
        }

        return Enumerable.Range(1, 33)
            .Select(number => byNumber.GetValueOrDefault(number)
                ?? new AccountStreakStatus(number, $"account_{number}", null, false))
            .ToArray();
    }

    public async Task<string> GetRepositoryAsync() => (await RunGhAsync(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"])).Trim();

    private async Task<string> RunGhAsync(IEnumerable<string> arguments, string? input = null)
    {
        using var process = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = "gh",
                WorkingDirectory = _workspace,
                UseShellExecute = false,
                RedirectStandardInput = input is not null,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
                CreateNoWindow = true
            }
        };
        foreach (var argument in arguments) process.StartInfo.ArgumentList.Add(argument);
        if (!process.Start()) throw new InvalidOperationException("無法啟動 GitHub CLI (gh)。請先安裝並執行 gh auth login。");
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        if (input is not null)
        {
            try { await process.StandardInput.WriteAsync(input); }
            finally { process.StandardInput.Close(); }
        }
        await process.WaitForExitAsync();
        var output = await stdout;
        var error = await stderr;
        if (process.ExitCode == 0) return output;

        var detail = (string.IsNullOrWhiteSpace(error) ? output : error).Trim();
        if (input is null) throw new InvalidOperationException(detail);

        // Secret writes go in on stdin, so gh's own message is the only clue about what failed
        // (size limit, missing login, missing permission). Never swallow it.
        var hint = detail.Contains("too large", StringComparison.OrdinalIgnoreCase)
            || detail.Contains("larger than", StringComparison.OrdinalIgnoreCase)
            || detail.Contains("exceeds", StringComparison.OrdinalIgnoreCase)
                ? "登入狀態超過 GitHub Secret 的 64 KB 上限。請清除該瀏覽器設定檔的 musicful.ai 網站資料後重新登入並匯出。"
                : "請確認 gh auth login 已登入，且具有此儲存庫的 Secrets 寫入權限，再重試。";
        throw new InvalidOperationException(
            string.IsNullOrWhiteSpace(detail)
                ? $"GitHub Secret 更新失敗。{hint}"
                : $"GitHub Secret 更新失敗。{hint} (gh: {detail})");
    }
}

internal sealed record RunInfo(long DatabaseId, string Status, string? Conclusion, DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt, string Url);
internal sealed record AccountStreakStatus(int Number, string Alias, int? StreakDays, bool IsConfigured);
