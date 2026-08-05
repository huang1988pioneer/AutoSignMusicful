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

    public async Task<AccountMonthlyStatus[]> GetAccountMonthlyStatusesAsync(string repository, long runId)
    {
        var output = await RunGhAsync(["run", "view", runId.ToString(), "--repo", repository, "--log"]);
        var matches = Regex.Matches(
                output,
                @"-\s*#(?<number>\d+)\s+(?<alias>[^:\r\n]+):\s*✅.*?\|\s*連續\s+(?<days>\d+)\s*\|",
                RegexOptions.Multiline)
            .Select(match => new AccountMonthlyStatus(
                int.Parse(match.Groups["number"].Value),
                match.Groups["alias"].Value.Trim(),
                int.Parse(match.Groups["days"].Value),
                true))
            .ToDictionary(status => status.Number);

        return Enumerable.Range(1, 33)
            .Select(number => matches.GetValueOrDefault(number)
                ?? new AccountMonthlyStatus(number, $"account_{number}", null, false))
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
internal sealed record AccountMonthlyStatus(int Number, string Alias, int? Days, bool IsConfigured);
