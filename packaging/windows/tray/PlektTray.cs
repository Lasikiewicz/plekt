using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Net.Http;
using System.ServiceProcess;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Win32;

internal static class Program
{
    private const string ServiceName = "Plekt";
    private const int DefaultPort = 5056;
    private const string PortRegistryPath = @"HKEY_LOCAL_MACHINE\SOFTWARE\Plekt";
    private static readonly string DashboardUrl = BuildDashboardUrl();
    private const string StartupSubKey = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
    private const string StartupValueName = "Plekt";
    private const string StartupShortcutName = "Plekt notification area.lnk";
    private static readonly HttpClient Http = new HttpClient
    {
        Timeout = TimeSpan.FromSeconds(3),
    };

    private static NotifyIcon trayIcon;
    private static Icon trayIconImage;
    private static ToolStripMenuItem statusItem;
    private static ToolStripMenuItem startupItem;
    private static Mutex singleInstance;

    private static string BuildDashboardUrl()
    {
        int port = DefaultPort;
        try
        {
            object configuredPort = Registry.GetValue(PortRegistryPath, "Port", null);
            int parsedPort;
            if (configuredPort != null
                && Int32.TryParse(Convert.ToString(configuredPort), out parsedPort)
                && parsedPort >= 1
                && parsedPort <= 65535)
            {
                port = parsedPort;
            }
        }
        catch
        {
            // The default URL keeps the tray useful if the installer setting is unavailable.
        }

        return "http://127.0.0.1:" + port;
    }

    [STAThread]
    private static void Main(string[] args)
    {
        if (args.Length > 0 && string.Equals(args[0], "--open", StringComparison.OrdinalIgnoreCase))
        {
            WaitForHealthyService(TimeSpan.FromSeconds(15));
            Open(DashboardUrl);
            return;
        }

        bool createdNew;
        singleInstance = new Mutex(true, "Local\\Plekt.NotificationArea", out createdNew);
        if (!createdNew)
        {
            return;
        }

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        string baseDirectory = AppDomain.CurrentDomain.BaseDirectory;
        trayIconImage = new Icon(Path.Combine(baseDirectory, "plekt.ico"));
        statusItem = new ToolStripMenuItem("Status: checking...")
        {
            Enabled = false,
        };

        ContextMenuStrip menu = new ContextMenuStrip();
        menu.Items.Add("Open Plekt", null, delegate { Open(DashboardUrl); });
        menu.Items.Add(statusItem);
        menu.Items.Add("Refresh status", null, delegate { UpdateStatus(); });
        menu.Items.Add("Stop server", null, delegate { StopServer(); });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Open data folder", null, delegate { Open(GetDataDirectory()); });
        menu.Items.Add("Open logs folder", null, delegate { Open(Path.Combine(GetDataDirectory(), "logs")); });
        menu.Items.Add(new ToolStripSeparator());
        startupItem = new ToolStripMenuItem("Start Plekt when I sign in")
        {
            CheckOnClick = true,
            Checked = IsStartupEnabled(),
        };
        startupItem.Click += delegate { SetStartup(startupItem.Checked); };
        menu.Items.Add(startupItem);
        menu.Items.Add("Exit notification area icon", null, delegate { Application.Exit(); });

        trayIcon = new NotifyIcon
        {
            ContextMenuStrip = menu,
            Icon = trayIconImage,
            Text = "Plekt",
            Visible = true,
        };
        trayIcon.DoubleClick += delegate { Open(DashboardUrl); };

        var timer = new System.Windows.Forms.Timer { Interval = 30000 };
        timer.Tick += delegate { UpdateStatus(); };
        timer.Start();

        Application.ApplicationExit += delegate
        {
            timer.Stop();
            timer.Dispose();
            if (trayIcon != null)
            {
                trayIcon.Visible = false;
                trayIcon.Dispose();
            }
            if (trayIconImage != null)
            {
                trayIconImage.Dispose();
            }
            if (singleInstance != null)
            {
                singleInstance.ReleaseMutex();
                singleInstance.Dispose();
            }
        };

        UpdateStatus();
        Application.Run();
    }

    private static void UpdateStatus()
    {
        bool serviceInstalled = false;
        bool serviceAccessDenied = false;
        bool healthy = false;
        try
        {
            using (var service = new ServiceController(ServiceName))
            {
                serviceInstalled = true;
                if (service.Status == ServiceControllerStatus.Running)
                {
                    healthy = IsHealthy();
                }
            }
        }
        catch (InvalidOperationException error)
        {
            if (IsAccessDenied(error))
            {
                serviceInstalled = true;
                serviceAccessDenied = true;
                healthy = IsHealthy();
            }
        }
        catch (System.ComponentModel.Win32Exception error)
        {
            if (IsAccessDenied(error))
            {
                serviceInstalled = true;
                serviceAccessDenied = true;
                healthy = IsHealthy();
            }
        }

        string status;
        if (!serviceInstalled)
        {
            status = "Not installed";
        }
        else if (healthy)
        {
            status = "Running";
        }
        else if (serviceAccessDenied)
        {
            status = "Installed (administrator access required)";
        }
        else
        {
            status = "Starting or unavailable";
        }

        if (statusItem != null)
        {
            statusItem.Text = "Status: " + status;
        }
        if (trayIcon != null)
        {
            trayIcon.Text = "Plekt - " + status;
        }
    }

    private static bool IsHealthy()
    {
        try
        {
            using (HttpResponseMessage response = Http.GetAsync(DashboardUrl + "/health").ConfigureAwait(false).GetAwaiter().GetResult())
            {
                return response.IsSuccessStatusCode;
            }
        }
        catch (HttpRequestException)
        {
            return false;
        }
        catch (TaskCanceledException)
        {
            return false;
        }
    }

    private static void WaitForHealthyService(TimeSpan timeout)
    {
        DateTime deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            if (IsHealthy())
            {
                return;
            }
            Thread.Sleep(500);
        }
    }

    private static void StopServer()
    {
        DialogResult confirmation = MessageBox.Show(
            "Stop the Plekt server? The dashboard and background synchronisation will be unavailable until the service is started again.",
            "Stop Plekt server",
            MessageBoxButtons.YesNo,
            MessageBoxIcon.Warning,
            MessageBoxDefaultButton.Button2);
        if (confirmation != DialogResult.Yes)
        {
            return;
        }

        try
        {
            bool stoppedWithElevation = false;
            using (var service = new ServiceController(ServiceName))
            {
                try
                {
                    service.Refresh();
                    if (service.Status == ServiceControllerStatus.Stopped)
                    {
                        UpdateStatus();
                        return;
                    }

                    service.Stop();
                }
                catch (Exception error)
                {
                    // ServiceController reports an access-denied service handle as
                    // InvalidOperationException with a Win32Exception inner error.
                    // Fall back to an elevated Service Control Manager command for
                    // both wrapped and direct access-denied responses.
                    if (!IsAccessDenied(error))
                    {
                        throw;
                    }

                    // Standard users may need to approve a UAC prompt to stop the service.
                    if (!RunElevatedServiceCommand("stop"))
                    {
                        return;
                    }
                    stoppedWithElevation = true;
                }

                if (!stoppedWithElevation)
                {
                    service.WaitForStatus(ServiceControllerStatus.Stopped, TimeSpan.FromSeconds(30));
                }
            }

            UpdateStatus();
        }
        catch (InvalidOperationException error)
        {
            if (IsAccessDenied(error))
            {
                if (RunElevatedServiceCommand("stop"))
                {
                    UpdateStatus();
                }
                return;
            }

            ShowWarning(
                "Plekt could not find its Windows service. It may not be installed yet.",
                error);
        }
        catch (System.ComponentModel.Win32Exception error)
        {
            if (IsAccessDenied(error))
            {
                if (RunElevatedServiceCommand("stop"))
                {
                    UpdateStatus();
                }
                return;
            }

            ShowWarning(
                "Plekt could not stop its Windows service. Windows may require administrator approval.",
                error);
        }
        catch (Exception error)
        {
            ShowWarning("Plekt could not stop its Windows service.", error);
        }
    }

    private static bool IsAccessDenied(Exception error)
    {
        for (Exception current = error; current != null; current = current.InnerException)
        {
            if (current is UnauthorizedAccessException)
            {
                return true;
            }

            var win32 = current as System.ComponentModel.Win32Exception;
            if (win32 != null && (win32.NativeErrorCode == 5 || win32.NativeErrorCode == 1314))
            {
                return true;
            }
        }

        return false;
    }

    private static bool RunElevatedServiceCommand(string command)
    {
        try
        {
            using (Process process = Process.Start(new ProcessStartInfo
            {
                FileName = Path.Combine(Environment.SystemDirectory, "sc.exe"),
                Arguments = command + " \"" + ServiceName + "\"",
                UseShellExecute = true,
                Verb = "runas",
                WindowStyle = ProcessWindowStyle.Hidden,
            }))
            {
                if (process == null)
                {
                    return false;
                }

                process.WaitForExit();
                return process.ExitCode == 0 || (command == "stop" && process.ExitCode == 1062);
            }
        }
        catch (System.ComponentModel.Win32Exception error)
        {
            // ERROR_CANCELLED: the user dismissed the UAC prompt.
            if (error.NativeErrorCode == 1223)
            {
                return false;
            }

            throw;
        }
    }

    private static void ShowWarning(string message, Exception error)
    {
        MessageBox.Show(
            message + "\r\n\r\n" + error.Message,
            "Plekt",
            MessageBoxButtons.OK,
            MessageBoxIcon.Warning);
    }

    private static string GetDataDirectory()
    {
        return Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
            "Plekt");
    }

    private static bool IsStartupEnabled()
    {
        try
        {
            if (File.Exists(StartupShortcutPath())) return true;
            using (RegistryKey key = Registry.CurrentUser.OpenSubKey(StartupSubKey, false))
            {
                string value = key == null ? null : key.GetValue(StartupValueName) as string;
                return !string.IsNullOrWhiteSpace(value)
                    && value.IndexOf(Application.ExecutablePath, StringComparison.OrdinalIgnoreCase) >= 0;
            }
        }
        catch (Exception)
        {
            return false;
        }
    }

    private static void SetStartup(bool enabled)
    {
        try
        {
            UpdateStartup(enabled, Application.ExecutablePath);
        }
        catch (Exception error)
        {
            startupItem.Checked = !enabled;
            MessageBox.Show(
                "Plekt could not update its sign-in setting.\r\n\r\n" + error.Message,
                "Plekt",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
        }
    }

    private static string StartupShortcutPath()
    {
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Startup), StartupShortcutName);
    }

    private static void UpdateStartup(bool enabled, string executablePath)
    {
        string shortcutPath = StartupShortcutPath();
        if (enabled)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(shortcutPath));
            object shell = null;
            object shortcut = null;
            try
            {
                Type shellType = Type.GetTypeFromProgID("WScript.Shell", true);
                shell = Activator.CreateInstance(shellType);
                shortcut = shellType.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { shortcutPath });
                Type shortcutType = shortcut.GetType();
                string directory = Path.GetDirectoryName(executablePath);
                shortcutType.InvokeMember("TargetPath", BindingFlags.SetProperty, null, shortcut, new object[] { executablePath });
                shortcutType.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, shortcut, new object[] { directory });
                shortcutType.InvokeMember("IconLocation", BindingFlags.SetProperty, null, shortcut, new object[] { Path.Combine(directory, "plekt.ico") });
                shortcutType.InvokeMember("Description", BindingFlags.SetProperty, null, shortcut, new object[] { "Start Plekt in the notification area at sign-in" });
                shortcutType.InvokeMember("Save", BindingFlags.InvokeMethod, null, shortcut, null);
            }
            finally
            {
                if (shortcut != null) Marshal.FinalReleaseComObject(shortcut);
                if (shell != null) Marshal.FinalReleaseComObject(shell);
            }
        }
        else
        {
            File.Delete(shortcutPath);
        }
        // Migrate the former Run mechanism and avoid two startup registrations.
        using (RegistryKey key = Registry.CurrentUser.OpenSubKey(StartupSubKey, true))
        {
            if (key != null) key.DeleteValue(StartupValueName, false);
        }
    }

    private static void Open(string target)
    {
        try
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = target,
                UseShellExecute = true,
            });
        }
        catch (Exception error)
        {
            MessageBox.Show(
                "Plekt could not open the requested location.\r\n\r\n" + error.Message,
                "Plekt",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
        }
    }
}
