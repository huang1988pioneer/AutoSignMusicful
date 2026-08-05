using System.Diagnostics;
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

    public async Task<StreakSummary?> GetStreakSummaryAsync(string repository, long runId)
    {
        var output = await RunGhAsync(["run", "view", runId.ToString(), "--repo", repository, "--log"]);
        var values = Regex.Matches(output, @"- #\d+ .*?\|\s*連續\s+(\d+)\s*\|")
            .Select(match => int.TryParse(match.Groups[1].Value, out var days) ? days : 0)
            .Where(days => days > 0)
            .ToArray();
        return values.Length == 0 ? null : new StreakSummary(values.Max(), values.Sum(), values.Length);
    }

    public async Task<string> GetRepositoryAsync() => (await RunGhAsync(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"])).Trim();

    private static async Task<string> RunGhAsync(IEnumerable<string> arguments)
    {
        using var process = new Process { StartInfo = new ProcessStartInfo { FileName = "gh", UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true } };
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
internal sealed record StreakSummary(int LongestDays, int TotalDays, int AccountCount);
