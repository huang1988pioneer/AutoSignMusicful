using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace MusicfulFlow;

internal sealed class GitHubActionsService
{
    private const string Workflow = "musicful-auto-sign.yml";

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

    private static async Task<string> RunGhAsync(IEnumerable<string> arguments)
    {
        using var process = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = "gh",
                UseShellExecute = false,
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
        await process.WaitForExitAsync();
        var output = await stdout;
        var error = await stderr;
        if (process.ExitCode == 0) return output;
        throw new InvalidOperationException(string.IsNullOrWhiteSpace(error) ? output.Trim() : error.Trim());
    }
}

internal sealed record RunInfo(long DatabaseId, string Status, string? Conclusion, DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt, string Url);
internal sealed record AccountStreakStatus(int Number, string Alias, int? StreakDays, bool IsConfigured);
