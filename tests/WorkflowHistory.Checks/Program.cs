using System.Text.Json;
using MusicfulFlow;

var zone = TimeZoneInfo.CreateCustomTimeZone("Taipei", TimeSpan.FromHours(8), "Taipei", "Taipei");
var now = DateTimeOffset.Parse("2026-09-06T12:00:00+08:00");
var checks = 0;
RunInfo Run(int day, string conclusion = "success", string status = "completed", int hour = 8) =>
    new(day * 100 + hour, status, conclusion, new DateTimeOffset(2026, 9, day, hour, 0, 0, TimeSpan.FromHours(8)),
        new DateTimeOffset(2026, 9, day, hour, 0, 0, TimeSpan.FromHours(8)), "https://example.test/run");
WorkflowHistory History(params RunInfo[] runs) => new("owner/repo", now, runs);
void Equal<T>(T expected, T actual, string name)
{
    if (!EqualityComparer<T>.Default.Equals(expected, actual)) throw new Exception($"{name}: expected {expected}, got {actual}");
    checks++;
}
Equal(0, History().Calculate(now, zone).SuccessDays, "empty history");
Equal(3, History(Run(4), Run(6), Run(5), Run(6, hour: 9)).Calculate(now, zone).SuccessDays, "multiple runs count as one day and order does not matter");
Equal(2, History(Run(4), Run(5), Run(6, "", "in_progress")).Calculate(now, zone).SuccessDays, "today pending retains yesterday streak");
Equal(0, History(Run(4)).Calculate(now, zone).SuccessDays, "missing yesterday resets stale streak");
Equal(1, History(Run(6), Run(4)).Calculate(now, zone).SuccessDays, "calendar gap breaks streak");
Equal(0, History(Run(6), Run(6, "failure", hour: 9), Run(5)).Calculate(now, zone).SuccessDays, "success cannot mask same-day failure");
Equal(0, History(Run(6, "cancelled")).Calculate(now, zone).SuccessDays, "cancelled breaks streak");
Equal(0, History(Run(6, "timed_out")).Calculate(now, zone).SuccessDays, "timeout breaks streak");
Equal<DateTimeOffset?>(null, History(Run(6, "cancelled")).Calculate(now, zone).LastFailure, "cancelled is not a failed execution date");
Equal<DateTimeOffset?>(Run(5, "timed_out").UpdatedAt, History(Run(4, "failure"), Run(5, "timed_out"), Run(6)).Calculate(now, zone).LastFailure, "latest failure includes timeout");
var midnight = Run(5) with { UpdatedAt = DateTimeOffset.Parse("2026-09-05T16:01:00Z") };
Equal(2, History(midnight, Run(5)).Calculate(now, zone).SuccessDays, "UTC completion mapped to Taipei date");
var rerun = Run(4) with { UpdatedAt = Run(6).UpdatedAt };
Equal<DateTimeOffset?>(Run(6).UpdatedAt, History(Run(5), rerun).Calculate(now, zone).LastSuccess, "latest success uses completion not creation");
var saved = History(Run(5), Run(6));
var restored = JsonSerializer.Deserialize<WorkflowHistory>(JsonSerializer.Serialize(saved))!;
Equal(saved.Calculate(now, zone), restored.Calculate(now, zone), "saved history roundtrip");
var balances = GitHubActionsService.ParseAccountStatuses("""
- #1 one: ✅ 今日簽到 | 連續簽到 5 天 | 積分餘額 1985 | 成長 10 |
- #2 two: ☑️ 已簽過 | 連續簽到 — 天 | 積分餘額 0 | 成長 10 |
- #3 old: ✅ 今日簽到 | 連續簽到 12 天 | 成長 100 |
| 4 | fallback | ✅ 今日簽到 | +10 | 20 | 7 | 138 | 本次新簽 |
| 5 | legacy | ✅ 今日簽到 | +10 | 20 | 9 | 本次新簽 |
""");
Equal<int?>(1985, balances[0].Points, "console balance");
Equal<int?>(0, balances[1].Points, "zero balance");
Equal<int?>(null, balances[2].Points, "legacy missing balance");
Equal<int?>(12, balances[2].StreakDays, "legacy streak preserved");
Equal<int?>(138, balances[3].Points, "markdown balance fallback");
Equal<int?>(7, balances[3].StreakDays, "balance must not replace streak");
Equal<int?>(null, balances[4].Points, "legacy markdown missing balance");
Console.WriteLine($"PASS: {checks} workflow history and account checks.");

if (args.Length == 2 && args[0] == "--live")
{
    var history = await new GitHubActionsService(Directory.GetCurrentDirectory()).GetHistoryAsync(args[1]);
    Console.WriteLine(JsonSerializer.Serialize(history.Calculate(DateTimeOffset.UtcNow, zone)));
    Console.WriteLine($"Read {history.Runs.Length} real workflow runs.");
}
