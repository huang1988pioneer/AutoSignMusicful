using System.Diagnostics;
using System.Text.Json;
using Avalonia.Controls;
using Avalonia.Input.Platform;
using Avalonia.Interactivity;

namespace MusicfulFlow;

public partial class MainWindow : Window
{
    private const int AccountCount = 33;
    private readonly string _workspace = FindWorkspace();
    private readonly GitHubActionsService _github;
    private readonly Dictionary<int, TextBox> _aliasInputs = [];
    private readonly Dictionary<int, string> _aliases = LoadAliases();

    public MainWindow()
    {
        _github = new GitHubActionsService(_workspace);
        InitializeComponent();
        AccountComboBox.ItemsSource = Enumerable.Range(1, AccountCount).Select(i => $"帳號 {i:00}").ToArray();
        BrowserComboBox.ItemsSource = new[]
        {
            "Chrome / Chromium（建議）",
            "Microsoft Edge（備案）",
            "Firefox（備案）"
        };
        BrowserComboBox.SelectedIndex = 0;
        BuildAliasList();
        ConfiguredMetric.Text = $"{_aliases.Count} 個";
        UpdateAccountDisplay();
    }

    private int AccountNumber => AccountComboBox.SelectedIndex + 1;
    private string ProfileName => $"musicful-{AccountNumber:00}";
    private string BrowserName => BrowserComboBox.SelectedIndex switch
    {
        1 => "edge",
        2 => "firefox",
        _ => "chrome"
    };
    private string StateFile => Path.Combine(_workspace, "logs", $"musicful-storage-state-{ProfileName}.base64");
    private string SecretName => $"MUSICFUL_STORAGE_STATE_BASE64_{AccountNumber}";
    private static string AliasFile => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "MusicfulFlow", "account-aliases.json");

    private void DashboardNavButton_OnClick(object? sender, RoutedEventArgs e) => ShowView(DashboardView);
    private void AccountsNavButton_OnClick(object? sender, RoutedEventArgs e) => ShowView(AccountsView);
    private void LoginNavButton_OnClick(object? sender, RoutedEventArgs e) => ShowView(LoginView);
    private void AccountComboBox_OnSelectionChanged(object? sender, SelectionChangedEventArgs e) => UpdateAccountDisplay();

    private void ShowView(Control view)
    {
        DashboardView.IsVisible = view == DashboardView;
        AccountsView.IsVisible = view == AccountsView;
        LoginView.IsVisible = view == LoginView;
        view.BringIntoView();
    }

    private void UpdateAccountDisplay()
    {
        if (AccountComboBox is null || AccountComboBox.SelectedIndex < 0) return;
        var label = _aliases.GetValueOrDefault(AccountNumber);
        SecretNameText.Text = SecretName;
        AccountAliasText.Text = label ?? string.Empty;
        CopyStateButton.IsEnabled = File.Exists(StateFile);
        UpdateSecretButton.IsEnabled = StartLoginButton.IsEnabled && File.Exists(StateFile);
    }

    private async void StartLoginButton_OnClick(object? sender, RoutedEventArgs e)
    {
        StartLoginButton.IsEnabled = false;
        CopyStateButton.IsEnabled = false;
        UpdateSecretButton.IsEnabled = false;
        AccountComboBox.IsEnabled = BrowserComboBox.IsEnabled = false;
        try
        {
            LoginStatus.Text = BrowserName switch
            {
                "firefox" => "正在確認 Node.js 相依套件與 Firefox…",
                "edge" => "正在確認 Node.js 相依套件與 Microsoft Edge…",
                _ => "正在確認 Node.js 相依套件與 Chromium…"
            };
            await RunProcessAsync("npm", ["install"]);
            // Edge uses the system Microsoft Edge via Playwright channel=msedge (no separate browser download required).
            // Still ensure chromium is present as Playwright core dependency for chromium-family launches.
            if (BrowserName == "firefox")
            {
                await RunProcessAsync("npx", ["playwright", "install", "firefox"]);
            }
            else
            {
                await RunProcessAsync("npx", ["playwright", "install", "chromium"]);
            }
            LoginStatus.Text = BrowserName switch
            {
                "firefox" => "Firefox 已開啟（備案）。登入後，頁面穩定 5 秒且登入視窗關閉後，會自動切換到「成長中心」並偵測匯出；請勿關閉瀏覽器。",
                "edge" => "Microsoft Edge 已開啟（備案）。登入後，頁面穩定 5 秒且登入視窗關閉後，會自動切換到「成長中心」並偵測匯出；請勿關閉瀏覽器。",
                _ => "瀏覽器已開啟。登入後，頁面穩定 5 秒且登入視窗關閉後，會自動切換到「成長中心」並偵測匯出；請勿關閉瀏覽器。"
            };
            await RunProcessAsync("npm", ["run", "export-state", "--", "--profile", ProfileName, "--browser", BrowserName]);
            if (!File.Exists(StateFile)) throw new InvalidOperationException("未找到匯出的登入狀態檔。請確認你已在瀏覽器中登入 Musicful。");
            LoginStatus.Text = $"完成。已建立 {Path.GetFileName(StateFile)}；可複製後貼到 GitHub Secret {SecretName}。";
            CopyStateButton.IsEnabled = true;
        }
        catch (Exception ex) { LoginStatus.Text = $"登入狀態更新失敗：{ex.Message}"; }
        finally
        {
            StartLoginButton.IsEnabled = true;
            AccountComboBox.IsEnabled = BrowserComboBox.IsEnabled = true;
            UpdateAccountDisplay();
        }
    }

    private async void UpdateSecretButton_OnClick(object? sender, RoutedEventArgs e)
    {
        var stateFile = StateFile;
        var secretName = SecretName;
        UpdateSecretButton.IsEnabled = StartLoginButton.IsEnabled = false;
        AccountComboBox.IsEnabled = false;
        try
        {
            if (!File.Exists(stateFile)) throw new InvalidOperationException("目前帳號尚未匯出登入狀態，請先開始登入並匯出。");
            var value = (await File.ReadAllTextAsync(stateFile)).Trim();
            if (string.IsNullOrWhiteSpace(value)) throw new InvalidOperationException("登入狀態是空的，請重新登入並匯出。");
            LoginStatus.Text = $"正在更新 GitHub Secret {secretName}…";
            var repository = await _github.GetRepositoryAsync();
            await _github.UpdateSecretAsync(repository, secretName, value);
            LoginStatus.Text = $"已更新 {repository} 的 {secretName}。";
        }
        catch (Exception ex) { LoginStatus.Text = $"更新失敗：{ex.Message}"; }
        finally
        {
            StartLoginButton.IsEnabled = AccountComboBox.IsEnabled = true;
            UpdateAccountDisplay();
        }
    }

    private async void CopyStateButton_OnClick(object? sender, RoutedEventArgs e)
    {
        if (!File.Exists(StateFile)) { LoginStatus.Text = "目前帳號尚未有可複製的登入狀態。"; return; }
        var text = (await File.ReadAllTextAsync(StateFile)).Trim();
        if (Clipboard is { } clipboard) await clipboard.SetTextAsync(text);
        LoginStatus.Text = $"已複製 {text.Length:N0} 字元的 Base64；請貼到 {SecretName}。";
    }

    private async void CopySecretButton_OnClick(object? sender, RoutedEventArgs e)
    {
        if (Clipboard is { } clipboard) await clipboard.SetTextAsync(SecretName);
        LoginStatus.Text = $"已複製 {SecretName}。";
    }

    private async void ReadPointsButton_OnClick(object? sender, RoutedEventArgs e)
    {
        ReadPointsButton.IsEnabled = false;
        try
        {
            PointsStatus.Text = "正在讀取 Musicful 成長中心…";
            var output = await RunProcessCaptureAsync("node", ["scripts/musicful-read-points.mjs", "--profile", ProfileName, "--browser", BrowserName]);
            var points = JsonSerializer.Deserialize<PointsSnapshot>(output.Trim(), new JsonSerializerOptions { PropertyNameCaseInsensitive = true })
                ?? throw new InvalidOperationException("積分資料格式無法解析。");
            var music = points.MusicPoints is null ? "—" : points.MusicPointsMax is null ? points.MusicPoints.ToString() : $"{points.MusicPoints} / {points.MusicPointsMax}";
            PointsStatus.Text = $"成長積分 {Display(points.GrowthPoints)} · 音樂點 {music} · 積分 {Display(points.Points)} · 連續簽到 {Display(points.StreakDays)} 天";
        }
        catch (Exception ex) { PointsStatus.Text = $"讀取積分失敗：{ex.Message}"; }
        finally { ReadPointsButton.IsEnabled = true; }
    }

    private async void TriggerButton_OnClick(object? sender, RoutedEventArgs e)
    {
        await WithDashboardBusy(async () =>
        {
            DashboardStatus.Text = "正在觸發 Musicful Auto Sign…";
            var repository = await _github.GetRepositoryAsync();
            await _github.TriggerAsync(repository, null);
            DashboardStatus.Text = "已送出簽到工作；稍後重新整理即可查看結果。";
        });
    }

    private async void RefreshButton_OnClick(object? sender, RoutedEventArgs e)
    {
        await WithDashboardBusy(async () =>
        {
            DashboardStatus.Text = "正在讀取 GitHub Actions…";
            var repository = await _github.GetRepositoryAsync();
            var run = await _github.GetLatestAsync(repository);
            if (run is null) { RunMetric.Text = "尚無執行紀錄"; MonthlyStreakMetric.Text = "—"; RunTimeMetric.Text = "—"; DashboardStatus.Text = "尚未找到 Musicful Auto Sign 執行紀錄。"; return; }
            RunMetric.Text = string.IsNullOrWhiteSpace(run.Conclusion) ? run.Status : run.Conclusion;
            RunTimeMetric.Text = TimeZoneInfo.ConvertTime(run.UpdatedAt, GetTaipeiZone()).ToString("MM/dd HH:mm");
            var accounts = await _github.GetAccountStreakStatusesAsync(repository, run.DatabaseId);
            var configured = accounts.Count(account => account.IsConfigured);
            var withStreak = accounts.Count(account => account.StreakDays is not null);
            MonthlyStreakMetric.Text = $"{withStreak} 有天數 · {configured} 已執行";
            RenderStreakAccounts(accounts);
            DashboardStatus.Text = $"最近執行：{run.Url}";
        });
    }

    private async Task WithDashboardBusy(Func<Task> action)
    {
        TriggerButton.IsEnabled = RefreshButton.IsEnabled = false;
        try { await action(); }
        catch (Exception ex) { DashboardStatus.Text = $"GitHub Actions 操作失敗：{ex.Message}"; }
        finally { TriggerButton.IsEnabled = RefreshButton.IsEnabled = true; }
    }

    private void RenderStreakAccounts(IEnumerable<AccountStreakStatus> accounts)
    {
        MonthlyAccountsPanel.Children.Clear();
        foreach (var account in accounts)
        {
            var row = new Grid { ColumnDefinitions = new ColumnDefinitions("68,*,120") };
            row.Children.Add(new TextBlock { Text = $"#{account.Number:00}", FontWeight = Avalonia.Media.FontWeight.SemiBold });
            var alias = new TextBlock { Text = account.Alias, TextTrimming = Avalonia.Media.TextTrimming.CharacterEllipsis };
            Grid.SetColumn(alias, 1);
            row.Children.Add(alias);
            var state = new TextBlock
            {
                Text = account.IsConfigured
                    ? (account.StreakDays is null ? "連續 — 天" : $"連續 {account.StreakDays} 天")
                    : "未設定",
                Foreground = account.IsConfigured
                    ? (account.StreakDays is null ? Avalonia.Media.Brushes.DarkOrange : Avalonia.Media.Brushes.SeaGreen)
                    : Avalonia.Media.Brushes.Gray,
                HorizontalAlignment = Avalonia.Layout.HorizontalAlignment.Right
            };
            Grid.SetColumn(state, 2);
            row.Children.Add(state);
            MonthlyAccountsPanel.Children.Add(row);
        }
    }

    private void BuildAliasList()
    {
        for (var i = 1; i <= AccountCount; i++)
        {
            var box = new TextBox { Width = 350, Text = _aliases.GetValueOrDefault(i), PlaceholderText = "帳號名稱（僅本機顯示）" };
            _aliasInputs[i] = box;
            var row = new StackPanel { Orientation = Avalonia.Layout.Orientation.Horizontal, Spacing = 12 };
            row.Children.Add(new TextBlock { Text = $"帳號 {i:00}", Width = 72, VerticalAlignment = Avalonia.Layout.VerticalAlignment.Center });
            row.Children.Add(box);
            AliasPanel.Children.Add(row);
        }
    }

    private async void SaveAliasesButton_OnClick(object? sender, RoutedEventArgs e)
    {
        foreach (var (number, input) in _aliasInputs) if (string.IsNullOrWhiteSpace(input.Text)) _aliases.Remove(number); else _aliases[number] = input.Text.Trim();
        Directory.CreateDirectory(Path.GetDirectoryName(AliasFile)!);
        await File.WriteAllTextAsync(AliasFile, JsonSerializer.Serialize(_aliases));
        UpdateAccountDisplay();
        LoginStatus.Text = "已儲存帳號別名。";
    }

    private async Task RunProcessAsync(string command, IEnumerable<string> args)
    {
        _ = await RunProcessCaptureAsync(command, args);
    }

    private async Task<string> RunProcessCaptureAsync(string command, IEnumerable<string> args)
    {
        // Use the system installation explicitly. When a project happens to contain an
        // npm shim under node_modules, Windows can otherwise resolve that shim first.
        var executable = NodeCommandPath(command);
        using var process = new Process { StartInfo = new ProcessStartInfo { FileName = executable, WorkingDirectory = _workspace, UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = false } };
        foreach (var arg in args) process.StartInfo.ArgumentList.Add(arg);
        if (!process.Start()) throw new InvalidOperationException($"無法啟動 {command}。");
        var outputTask = process.StandardOutput.ReadToEndAsync();
        var errorTask = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync();
        var output = await outputTask; var error = await errorTask;
        if (process.ExitCode != 0) throw new InvalidOperationException((string.IsNullOrWhiteSpace(error) ? output : error).Trim().Truncate(900));
        return output;
    }

    private static Dictionary<int, string> LoadAliases()
    {
        var aliases = new Dictionary<int, string>
        {
            [1] = "goldshoot0720",
            [2] = "abuhg17",
            [3] = "fengtuprinfo",
            [4] = "feng33feng35feng3",
            [5] = "chbondg2",
            [6] = "huang1988pioneer",
            [7] = "chbondg_outloook",
            [8] = "gaokaolevel3iptopscorer_outlook",
            [9] = "huang1988pioneer_outloook",
            [10] = "fengtuta_tuta",
            [11] = "fengfence_fence",
            [12] = "samafengtu",
            [13] = "fengtusama",
            [14] = "fengwithting0831",
            [15] = "fengwithfeng1127",
            [16] = "fengwithtu1127",
            [17] = "akaonda333",
            [18] = "fbussinesseng",
            [19] = "engdictatorf",
            [20] = "flottojackpoteng",
            [21] = "tushenbyfengbro"
        };
        try
        {
            if (!File.Exists(AliasFile)) return aliases;
            var saved = JsonSerializer.Deserialize<Dictionary<int, string>>(File.ReadAllText(AliasFile)) ?? [];
            foreach (var (number, name) in saved) aliases[number] = name;
            return aliases;
        }
        catch (JsonException) { return aliases; }
    }
    private static string FindWorkspace()
    {
        string? workspace = null;
        foreach (var start in new[] { AppContext.BaseDirectory, Environment.CurrentDirectory })
            for (var dir = new DirectoryInfo(start); dir is not null; dir = dir.Parent)
                if (File.Exists(Path.Combine(dir.FullName, "package.json")) &&
                    File.Exists(Path.Combine(dir.FullName, "scripts", "musicful-signin.mjs")))
                    workspace = dir.FullName;
        return workspace ?? Environment.CurrentDirectory;
    }
    private static TimeZoneInfo GetTaipeiZone()
    {
        try { return TimeZoneInfo.FindSystemTimeZoneById("Taipei Standard Time"); }
        catch { return TimeZoneInfo.FindSystemTimeZoneById("Asia/Taipei"); }
    }

    private static string NodeCommandPath(string command)
    {
        if (!OperatingSystem.IsWindows()) return command;
        if (command == "node")
        {
            var nodeExecutable = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe");
            return File.Exists(nodeExecutable) ? nodeExecutable : "node";
        }
        var systemCommand = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
            "nodejs",
            $"{command}.cmd");
        return File.Exists(systemCommand) ? systemCommand : $"{command}.cmd";
    }

    private static string Display(int? value) => value?.ToString() ?? "—";
}

internal sealed record PointsSnapshot(int? GrowthPoints, int? MusicPoints, int? MusicPointsMax, int? Points, int? StreakDays, DateTimeOffset FetchedAt);

internal static class StringExtensions
{
    public static string Truncate(this string value, int max) => value.Length <= max ? value : value[..max] + "…";
}
