using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class WindowsProcessHelper
{
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

    private static string Escape(string value)
    {
        return (value ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "\\r").Replace("\n", "\\n");
    }

    private static long StartedAt(Process process)
    {
        try { return (long)(process.StartTime.ToUniversalTime() - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds; }
        catch { return 0; }
    }

    public static void Main()
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        while (true)
        {
            try
            {
                uint foregroundPid;
                GetWindowThreadProcessId(GetForegroundWindow(), out foregroundPid);
                Console.WriteLine("{\"type\":\"begin\",\"foregroundPid\":" + foregroundPid + "}");
                foreach (var process in Process.GetProcesses())
                {
                    try
                    {
                        var name = process.ProcessName + ".exe";
                        var executable = "";
                        try { executable = process.MainModule.FileName; } catch { }
                        Console.WriteLine("{\"type\":\"process\",\"pid\":" + process.Id
                            + ",\"name\":\"" + Escape(name)
                            + "\",\"path\":\"" + Escape(executable)
                            + "\",\"startedAt\":" + StartedAt(process)
                            + ",\"hasWindow\":" + (process.MainWindowHandle != IntPtr.Zero ? "true" : "false") + "}");
                    }
                    catch { }
                    finally { process.Dispose(); }
                }
                Console.WriteLine("{\"type\":\"end\"}");
                Console.Out.Flush();
            }
            catch { }
            Thread.Sleep(3000);
        }
    }
}
