// A Windows HDR-only player. Compile together with DisplayProbe.cs using inbox
// csc /platform:x64 /main:HdrPlayer /r:System.Windows.Forms.dll
// /r:System.Drawing.dll /r:System.Web.Extensions.dll.
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal sealed class HdrPlayer : Form
{
    private const string Library = "libmpv-2.dll";
    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)] private static extern IntPtr mpv_create();
    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)] private static extern int mpv_initialize(IntPtr ctx);
    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)] private static extern int mpv_set_option_string(IntPtr ctx, byte[] name, byte[] value);
    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)] private static extern IntPtr mpv_get_property_string(IntPtr ctx, byte[] name);
    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)] private static extern int mpv_get_property(IntPtr ctx, byte[] name, int format, out long value);
    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)] private static extern int mpv_command(IntPtr ctx, IntPtr[] args);
    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)] private static extern void mpv_free(IntPtr ptr);
    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)] private static extern void mpv_terminate_destroy(IntPtr ctx);
    [DllImport("user32.dll")] private static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);
    [StructLayout(LayoutKind.Sequential)] private struct WindowRect { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out WindowRect rectangle);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int CheckColorSpace(IntPtr self, int space, out uint support);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int SetColorSpace(IntPtr self, int space);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int GetDesc1(IntPtr self, IntPtr description);

    private readonly JavaScriptSerializer json = new JavaScriptSerializer();
    private readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
    private IntPtr player;
    private DateTime deadline;
    private bool ready;
    private bool closed;
    private string liveUrl;
    private string lastVideoPts;
    private DateTime lastVideoFrame;
    private readonly string fixture;

    private static byte[] Utf8(string value) { return Encoding.UTF8.GetBytes(value + "\0"); }
    private static void Emit(string type, string reason)
    {
        Console.WriteLine(new JavaScriptSerializer().Serialize(new { type = type, reason = reason }));
        Console.Out.Flush();
    }

    [STAThread]
    private static int Main(string[] args)
    {
        DisplayProbe.UsePhysicalPixels();
        Console.OutputEncoding = new UTF8Encoding(false);
        if (args.Length == 1 && args[0] == "--check-runtime")
        {
            IntPtr check = IntPtr.Zero;
            try { check = mpv_create(); if (check == IntPtr.Zero) return 1; Configure(check); Emit("runtime-ok", "options_only_not_hdr_acceptance"); return 0; }
            catch { Emit("failed", "native_runtime_incompatible"); return 1; }
            finally { if (check != IntPtr.Zero) mpv_terminate_destroy(check); }
        }
        long ownerWindow = 0;
        if (args.Length < 1 || args.Length > 2 || !File.Exists(args[0]) || (args.Length == 2 && !long.TryParse(args[1], out ownerWindow))) { Emit("failed", "missing_hdr_probe"); return 1; }
        try
        {
            Application.EnableVisualStyles();
            Application.Run(new HdrPlayer(Path.GetFullPath(args[0]), ownerWindow));
            return 0;
        }
        catch { Emit("failed", "native_player_failed"); return 1; }
    }

    private HdrPlayer(string probe, long ownerWindow)
    {
        fixture = probe;
        Text = "HDR";
        ClientSize = new System.Drawing.Size(960, 540);
        BackColor = System.Drawing.Color.Black;
        StartPosition = FormStartPosition.CenterScreen;
        WindowRect owner;
        if (ownerWindow != 0 && GetWindowRect(new IntPtr(ownerWindow), out owner))
        {
            StartPosition = FormStartPosition.Manual;
            Location = new System.Drawing.Point(owner.Left + (owner.Right - owner.Left - Width) / 2, owner.Top + (owner.Bottom - owner.Top - Height) / 2);
        }
        timer.Interval = 500;
        timer.Tick += delegate { CheckOutput(); };
        Shown += delegate
        {
            try { StartPlayer(); }
            catch { Fail("native_player_failed"); }
        };
        FormClosed += delegate
        {
            closed = true;
            timer.Stop();
            if (player != IntPtr.Zero) { mpv_terminate_destroy(player); player = IntPtr.Zero; }
            Emit("stopped", null);
        };
    }

    private void Set(string key, string value)
    {
        if (mpv_set_option_string(player, Utf8(key), Utf8(value)) < 0) throw new InvalidOperationException(key);
    }
    private static void Configure(IntPtr handle)
    {
        var options = new Dictionary<string, string> {
            {"config", "no"}, {"load-scripts", "no"}, {"input-default-bindings", "no"}, {"input-vo-keyboard", "no"},
            {"terminal", "no"}, {"osc", "no"}, {"vo", "gpu-next"}, {"gpu-api", "d3d11"}, {"gpu-context", "d3d11"},
            {"d3d11-warp", "no"}, {"d3d11-output-format", "rgb10_a2"}, {"d3d11-output-csp", "pq"},
            {"target-colorspace-hint", "yes"}, {"hwdec", "d3d11va"}, {"hwdec-codecs", "hevc"},
            {"hwdec-software-fallback", "no"}, {"audio", "no"}, {"mute", "yes"}, {"volume-max", "400"}, {"cache", "no"}, {"demuxer-max-bytes", "8MiB"}, {"loop-file", "inf"}
        };
        foreach (var option in options)
            if (mpv_set_option_string(handle, Utf8(option.Key), Utf8(option.Value)) < 0) throw new InvalidOperationException(option.Key);
    }
    private string Get(string key)
    {
        IntPtr result = mpv_get_property_string(player, Utf8(key));
        if (result == IntPtr.Zero) return null;
        try
        {
            int length = 0;
            while (length < 65536 && Marshal.ReadByte(result, length) != 0) length++;
            if (length == 65536) return null;
            byte[] data = new byte[length];
            Marshal.Copy(result, data, 0, length);
            return Encoding.UTF8.GetString(data);
        }
        finally { mpv_free(result); }
    }
    private void Command(params string[] words)
    {
        var pointers = new IntPtr[words.Length + 1];
        try
        {
            for (int i = 0; i < words.Length; i++)
            {
                byte[] data = Utf8(words[i]);
                pointers[i] = Marshal.AllocHGlobal(data.Length);
                Marshal.Copy(data, 0, pointers[i], data.Length);
            }
            if (mpv_command(player, pointers) < 0) throw new InvalidOperationException("player command failed");
        }
        finally { foreach (IntPtr ptr in pointers) if (ptr != IntPtr.Zero) Marshal.FreeHGlobal(ptr); }
    }

    private void StartPlayer()
    {
        if (!DisplayProbe.IsHdrMonitor(MonitorFromWindow(Handle, 0))) { Fail("output_hdr_disabled"); return; }
        player = mpv_create();
        if (player == IntPtr.Zero) throw new InvalidOperationException("player unavailable");
        Configure(player);
        Set("wid", Handle.ToInt64().ToString());
        if (mpv_initialize(player) < 0) throw new InvalidOperationException("HDR renderer unavailable");
        Command("loadfile", fixture);
        deadline = DateTime.UtcNow.AddSeconds(15);
        timer.Start();
        var reader = new Thread(ReadCommands);
        reader.IsBackground = true;
        reader.Start();
    }

    private void ReadCommands()
    {
        try
        {
            string line;
            while ((line = Console.ReadLine()) != null)
            {
                if (line.Length > 65536) break;
                var command = json.Deserialize<Dictionary<string, object>>(line);
                if (closed) return;
                BeginInvoke((Action)delegate
                {
                    if (closed) return;
                    try
                    {
                        object action;
                        if (!command.TryGetValue("action", out action)) throw new InvalidOperationException();
                        if ((string)action == "stop") { Close(); return; }
                        if ((string)action == "audio")
                        {
                            double volume = Convert.ToDouble(command["volume"], System.Globalization.CultureInfo.InvariantCulture);
                            if (double.IsNaN(volume) || double.IsInfinity(volume) || volume < 0 || volume > 400 || !(command["muted"] is bool)) throw new InvalidOperationException();
                            Command("set", "volume", volume.ToString(System.Globalization.CultureInfo.InvariantCulture));
                            Command("set", "mute", (bool)command["muted"] ? "yes" : "no"); return;
                        }
                        object raw;
                        if ((string)action != "load" || !ready || !command.TryGetValue("url", out raw)) throw new InvalidOperationException();
                        Uri url;
                        if (!Uri.TryCreate((string)raw, UriKind.Absolute, out url) || url.Scheme != "http" ||
                            url.Host != "127.0.0.1" || url.UserInfo != "" || url.Query != "" || url.Fragment != "" ||
                            !System.Text.RegularExpressions.Regex.IsMatch(url.AbsolutePath, "^/[a-f0-9]{64}$")) throw new InvalidOperationException();
                        object audioRaw; Uri audioUrl = null;
                        if (command.TryGetValue("audioUrl", out audioRaw) && audioRaw != null)
                        {
                            if (!Uri.TryCreate((string)audioRaw, UriKind.Absolute, out audioUrl) || audioUrl.Scheme != "http" ||
                                audioUrl.Host != "127.0.0.1" || audioUrl.Port != url.Port || audioUrl.UserInfo != "" || audioUrl.Query != "" || audioUrl.Fragment != "" ||
                                !System.Text.RegularExpressions.Regex.IsMatch(audioUrl.AbsolutePath, "^/[a-f0-9]{64}$")) throw new InvalidOperationException();
                        }
                        ready = false;
                        liveUrl = url.AbsoluteUri; lastVideoPts = null; lastVideoFrame = DateTime.UtcNow;
                        Command("set", "loop-file", "no");
                        if (audioUrl == null) Command("loadfile", url.AbsoluteUri);
                        else Command("loadfile", url.AbsoluteUri, "replace", "-1", "audio=auto,audio-files=" + audioUrl.AbsoluteUri);
                        deadline = DateTime.UtcNow.AddSeconds(15);
                    }
                    catch { Fail("invalid_player_command"); }
                });
            }
        }
        catch { }
        if (!closed) { try { BeginInvoke((Action)delegate { Close(); }); } catch { } }
    }

    private void CheckOutput()
    {
        if (closed) return;
        try
        {
            // Do this even while waiting for decoder configuration or data.
            if (!DisplayProbe.IsHdrMonitor(MonitorFromWindow(Handle, 0))) { Fail("output_hdr_disabled"); return; }
            if (liveUrl != null && (Get("path") != liveUrl || Get("file-format") != "mpegts"))
            { if (DateTime.UtcNow > deadline) Fail("hdr_stream_unavailable"); return; }
            if (Get("vo-configured") != "yes" || Get("hwdec-current") != "d3d11va")
            { if (DateTime.UtcNow > deadline) Fail("hdr_decode_unavailable"); return; }
            if (Get("current-gpu-context") != "d3d11") { Fail("hdr_renderer_unavailable"); return; }
            if (Get("video-params/primaries") == null)
            { if (DateTime.UtcNow > deadline) Fail("hdr_decode_unavailable"); return; }
            string matrix = Get("video-params/colormatrix"), format = Get("video-params/hw-pixelformat");
            if (Get("video-params/primaries") != "bt.2020" || Get("video-params/gamma") != "pq" ||
                (matrix != "bt.2020-nc" && matrix != "bt.2020-ncl") || (format != "p010" && format != "p010le"))
            { Fail("incompatible_hdr_bitstream"); return; }
            long address;
            if (mpv_get_property(player, Utf8("display-swapchain"), 4, out address) < 0 || address == 0)
            { Fail("hdr_swapchain_unavailable"); return; }
            IntPtr unknown = new IntPtr(address), chain;
            Guid iid = new Guid("94d99bdb-f1f8-4ab0-b236-7da0170edab1"); // IDXGISwapChain3
            if (Marshal.QueryInterface(unknown, ref iid, out chain) < 0) { Fail("hdr_swapchain_unavailable"); return; }
            try
            {
                IntPtr table = Marshal.ReadIntPtr(chain);
                var check = (CheckColorSpace)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(table, 37 * IntPtr.Size), typeof(CheckColorSpace));
                var set = (SetColorSpace)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(table, 38 * IntPtr.Size), typeof(SetColorSpace));
                uint support;
                if (check(chain, 12, out support) < 0 || (support & 1) == 0 || set(chain, 12) < 0)
                { Fail("hdr_presentation_unavailable"); return; }
                IntPtr desc = Marshal.AllocHGlobal(48);
                try
                {
                    var get = (GetDesc1)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(table, 18 * IntPtr.Size), typeof(GetDesc1));
                    if (get(chain, desc) < 0 || Marshal.ReadInt32(desc, 8) != 24) // R10G10B10A2_UNORM
                    { Fail("hdr_output_not_10bit"); return; }
                }
                finally { Marshal.FreeHGlobal(desc); }
            }
            finally { Marshal.Release(chain); }
            if (liveUrl != null)
            {
                string pts = Get("video-pts");
                if (pts != null && pts != lastVideoPts) { lastVideoPts = pts; lastVideoFrame = DateTime.UtcNow; }
                if (DateTime.UtcNow - lastVideoFrame > TimeSpan.FromSeconds(10)) { Fail("hdr_video_stalled"); return; }
            }
            if (!ready) { ready = true; Emit("ready", null); }
        }
        catch { Fail("hdr_capability_unconfirmed"); }
    }

    private void Fail(string reason)
    {
        if (closed) return;
        Emit("failed", reason);
        Close();
    }
}
