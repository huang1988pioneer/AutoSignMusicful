namespace MusicfulFlow;

internal sealed record WorkflowHistory(string Repository, DateTimeOffset FetchedAt, RunInfo[] Runs)
{
    public WorkflowStatistics Calculate(DateTimeOffset now, TimeZoneInfo zone)
    {
        var completed = Runs.Where(run => run.Status == "completed").ToArray();
        var lastSuccess = completed.Where(run => run.Conclusion == "success")
            .MaxBy(run => run.UpdatedAt)?.UpdatedAt;
        var lastFailure = completed.Where(run => run.Conclusion is "failure" or "timed_out" or "startup_failure")
            .MaxBy(run => run.UpdatedAt)?.UpdatedAt;
        var days = completed.GroupBy(run => DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(run.UpdatedAt, zone).DateTime))
            .ToDictionary(group => group.Key, group => group.All(run => run.Conclusion == "success"));
        var day = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(now, zone).DateTime);
        // An unfinished today does not invalidate yesterday's streak.
        if (!days.ContainsKey(day)) day = day.AddDays(-1);
        var streak = 0;
        while (days.TryGetValue(day, out var successful) && successful)
        {
            streak++;
            day = day.AddDays(-1);
        }
        return new WorkflowStatistics(lastSuccess, lastFailure, streak);
    }
}

internal sealed record WorkflowStatistics(DateTimeOffset? LastSuccess, DateTimeOffset? LastFailure, int SuccessDays);
