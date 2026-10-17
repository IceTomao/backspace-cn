// Read-only Windows display capabilities. Built with the inbox .NET Framework csc.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

internal static class DisplayProbe
{
    // Used by the native player in the same process as its D3D11 swap chain.
    // The current window's actual output decides eligibility on every tick.
    public static bool IsHdrMonitor(IntPtr monitor)
    {
        var info = new MonitorInfo { Size = (uint)Marshal.SizeOf(typeof(MonitorInfo)) };
        if (!GetMonitorInfo(monitor, ref info)) return false;
        int space;
        return OutputColorSpaces().TryGetValue(info.Device, out space) && space == 12;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct Luid { public uint Low; public int High; }
    [StructLayout(LayoutKind.Sequential)]
    private struct DeviceInfoHeader { public uint Type; public uint Size; public Luid Adapter; public uint Id; }
    [StructLayout(LayoutKind.Sequential)]
    private struct AdvancedColorInfo
    {
        public DeviceInfoHeader Header;
        public uint Flags;
        public uint ColorEncoding;
        public uint BitsPerChannel;
    }
    // Windows 11 24H2 distinguishes HDR from wide color gamut. The older
    // advanced-color bit alone must never grant HDR viewing/publication.
    [StructLayout(LayoutKind.Sequential)]
    private struct AdvancedColorInfo2
    {
        public DeviceInfoHeader Header;
        public uint Flags;
        public uint ColorEncoding;
        public uint BitsPerChannel;
        public uint ActiveColorMode;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct MonitorInfo
    {
        public uint Size;
        public Rect Monitor;
        public Rect Work;
        public uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string Device;
    }
    private delegate bool MonitorCallback(IntPtr monitor, IntPtr dc, ref Rect rect, IntPtr data);
    [DllImport("user32.dll")]
    private static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr clip, MonitorCallback callback, IntPtr data);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
    [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    public static void UsePhysicalPixels() { try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { } }
    [DllImport("dxgi.dll")]
    private static extern int CreateDXGIFactory1(ref Guid iid, out IntPtr factory);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int EnumDxgi(IntPtr self, uint index, out IntPtr result);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int GetOutputDesc1(IntPtr self, IntPtr description);

    private static Delegate Method(IntPtr instance, int slot, Type type)
    {
        return Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(Marshal.ReadIntPtr(instance), slot * IntPtr.Size), type);
    }

    private static Dictionary<string, int> OutputColorSpaces()
    {
        var spaces = new Dictionary<string, int>();
        var iid = new Guid("770aae78-f26f-4dba-a829-253c83d1b387"); // IDXGIFactory1
        IntPtr factory;
        if (CreateDXGIFactory1(ref iid, out factory) < 0) return spaces;
        try
        {
            var adapters = (EnumDxgi)Method(factory, 12, typeof(EnumDxgi));
            for (uint ai = 0; ai < 128; ai++)
            {
                IntPtr adapter;
                if (adapters(factory, ai, out adapter) < 0) break;
                try
                {
                    var outputs = (EnumDxgi)Method(adapter, 7, typeof(EnumDxgi));
                    for (uint oi = 0; oi < 128; oi++)
                    {
                        IntPtr output;
                        if (outputs(adapter, oi, out output) < 0) break;
                        try
                        {
                            var output6Id = new Guid("068346e8-aaec-4b84-add7-137f513f77a1");
                            IntPtr output6;
                            if (Marshal.QueryInterface(output, ref output6Id, out output6) < 0) continue;
                            try
                            {
                                // DXGI_OUTPUT_DESC1: WCHAR[32], RECT, BOOL, rotation,
                                // HMONITOR, BitsPerColor, ColorSpace, luminance data.
                                IntPtr desc = Marshal.AllocHGlobal(152);
                                try
                                {
                                    var getDesc = (GetOutputDesc1)Method(output6, 27, typeof(GetOutputDesc1));
                                    if (getDesc(output6, desc) >= 0)
                                    {
                                        int colorSpaceOffset = IntPtr.Size == 8 ? 100 : 96;
                                        spaces[Marshal.PtrToStringUni(desc)] = Marshal.ReadInt32(desc, colorSpaceOffset);
                                    }
                                }
                                finally { Marshal.FreeHGlobal(desc); }
                            }
                            finally { Marshal.Release(output6); }
                        }
                        finally { Marshal.Release(output); }
                    }
                }
                finally { Marshal.Release(adapter); }
            }
        }
        finally { Marshal.Release(factory); }
        return spaces;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct TargetName
    {
        public DeviceInfoHeader Header;
        public uint Flags;
        public uint OutputTechnology;
        public ushort EdidManufacturer;
        public ushort EdidProduct;
        public uint ConnectorInstance;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string FriendlyName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DevicePath;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct SourceName
    {
        public DeviceInfoHeader Header;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string GdiName;
    }

    [DllImport("user32.dll")]
    private static extern int GetDisplayConfigBufferSizes(uint flags, out uint paths, out uint modes);
    [DllImport("user32.dll")]
    private static extern int QueryDisplayConfig(uint flags, ref uint paths, IntPtr pathArray, ref uint modes, IntPtr modeArray, IntPtr topology);
    [DllImport("user32.dll", EntryPoint = "DisplayConfigGetDeviceInfo")]
    private static extern int GetColorInfo(ref AdvancedColorInfo info);
    [DllImport("user32.dll", EntryPoint = "DisplayConfigGetDeviceInfo")]
    private static extern int GetColorInfo2(ref AdvancedColorInfo2 info);
    [DllImport("user32.dll", EntryPoint = "DisplayConfigGetDeviceInfo", CharSet = CharSet.Unicode)]
    private static extern int GetTargetName(ref TargetName name);
    [DllImport("user32.dll", EntryPoint = "DisplayConfigGetDeviceInfo", CharSet = CharSet.Unicode)]
    private static extern int GetSourceName(ref SourceName name);

    private static string Json(string value)
    {
        var result = new StringBuilder("\"");
        foreach (char ch in value ?? "")
        {
            if (ch == '"' || ch == '\\') result.Append('\\').Append(ch);
            else if (ch < 32) result.Append("\\u").Append(((int)ch).ToString("x4"));
            else result.Append(ch);
        }
        return result.Append('"').ToString();
    }

    private static DeviceInfoHeader Header(uint type, int size, Luid adapter, uint id)
    {
        return new DeviceInfoHeader { Type = type, Size = (uint)size, Adapter = adapter, Id = id };
    }

    private static int Main()
    {
        UsePhysicalPixels();
        try
        {
            var colorSpaces = OutputColorSpaces();
            var monitors = new Dictionary<string, string>();
            MonitorCallback callback = delegate(IntPtr monitor, IntPtr dc, ref Rect rect, IntPtr data)
            {
                var info = new MonitorInfo { Size = (uint)Marshal.SizeOf(typeof(MonitorInfo)) };
                if (GetMonitorInfo(monitor, ref info)) monitors[info.Device] = monitor.ToInt64().ToString();
                return true;
            };
            if (!EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, callback, IntPtr.Zero))
                throw new InvalidOperationException("Cannot enumerate active monitors");
            // QDC_ONLY_ACTIVE_PATHS; retry if a display changes during enumeration.
            for (int attempt = 0; attempt < 3; attempt++)
            {
                uint paths, modes;
                int code = GetDisplayConfigBufferSizes(2, out paths, out modes);
                if (code != 0) throw new Win32Exception(code);
                if (paths > 128 || modes > 1024) throw new InvalidOperationException("Unexpected display configuration size");
                IntPtr pathArray = Marshal.AllocHGlobal(checked((int)paths * 72));
                IntPtr modeArray = Marshal.AllocHGlobal(checked((int)modes * 64));
                try
                {
                    code = QueryDisplayConfig(2, ref paths, pathArray, ref modes, modeArray, IntPtr.Zero);
                    if (code == 122) continue; // ERROR_INSUFFICIENT_BUFFER
                    if (code != 0) throw new Win32Exception(code);
                    var displays = new List<string>();
                    for (int index = 0; index < paths; index++)
                    {
                        IntPtr path = IntPtr.Add(pathArray, index * 72);
                        var sourceAdapter = (Luid)Marshal.PtrToStructure(path, typeof(Luid));
                        uint sourceId = (uint)Marshal.ReadInt32(path, 8);
                        var targetAdapter = (Luid)Marshal.PtrToStructure(IntPtr.Add(path, 20), typeof(Luid));
                        uint targetId = (uint)Marshal.ReadInt32(path, 28);
                        var color = new AdvancedColorInfo { Header = Header(9, Marshal.SizeOf(typeof(AdvancedColorInfo)), targetAdapter, targetId) };
                        int colorCode = GetColorInfo(ref color);
                        var hdr = new AdvancedColorInfo2 { Header = Header(15, Marshal.SizeOf(typeof(AdvancedColorInfo2)), targetAdapter, targetId) };
                        int hdrCode = GetColorInfo2(ref hdr);
                        var target = new TargetName { Header = Header(2, Marshal.SizeOf(typeof(TargetName)), targetAdapter, targetId) };
                        int targetCode = GetTargetName(ref target);
                        var source = new SourceName { Header = Header(1, Marshal.SizeOf(typeof(SourceName)), sourceAdapter, sourceId) };
                        int sourceCode = GetSourceName(ref source);
                        string handle;
                        monitors.TryGetValue(sourceCode == 0 ? source.GdiName : "", out handle);
                        long numericHandle;
                        var monitorInfo = new MonitorInfo { Size = (uint)Marshal.SizeOf(typeof(MonitorInfo)) };
                        bool hasSize = long.TryParse(handle, out numericHandle) && GetMonitorInfo(new IntPtr(numericHandle), ref monitorInfo);
                        int dxgiSpace;
                        bool hasDxgiSpace = colorSpaces.TryGetValue(sourceCode == 0 ? source.GdiName : "", out dxgiSpace);
                        // RGB_FULL_G2084_NONE_P2020 (12) is an active HDR output,
                        // unlike a monitor model name or the legacy WCG flag.
                        string hdrActive = hdrCode == 0 ? (hdr.ActiveColorMode == 2 ? "true" : "false")
                            : hasDxgiSpace ? (dxgiSpace == 12 ? "true" : "false") : "null";
                        // Windows' legacy advanced-color flag includes WCG. A positive
                        // result is a preflight hint, not proof of an HDR capture/encode.
                        displays.Add("{\"gdiName\":" + Json(sourceCode == 0 ? source.GdiName : "") +
                            ",\"name\":" + Json(targetCode == 0 ? target.FriendlyName : "") +
                            ",\"hmonitor\":" + (handle == null ? "null" : Json(handle)) +
                            ",\"hdrSupported\":" + (hdrCode != 0 ? "null" : (hdr.Flags & 16) != 0 ? "true" : "false") +
                            ",\"hdrActive\":" + hdrActive +
                            ",\"width\":" + (hasSize ? (monitorInfo.Monitor.Right - monitorInfo.Monitor.Left).ToString() : "null") +
                            ",\"height\":" + (hasSize ? (monitorInfo.Monitor.Bottom - monitorInfo.Monitor.Top).ToString() : "null") +
                            ",\"dxgiColorSpace\":" + (hasDxgiSpace ? dxgiSpace.ToString() : "null") +
                            ",\"advancedColorSupported\":" + (colorCode == 0 && (color.Flags & 1) != 0 ? "true" : "false") +
                            ",\"advancedColorEnabled\":" + (colorCode == 0 && (color.Flags & 2) != 0 ? "true" : "false") +
                            ",\"bitsPerChannel\":" + (colorCode == 0 ? color.BitsPerChannel.ToString() : "null") +
                            ",\"probeError\":" + (colorCode == 0 ? "null" : colorCode.ToString()) + "}");
                    }
                    Console.OutputEncoding = new UTF8Encoding(false);
                    Console.WriteLine("{\"schemaVersion\":2,\"displays\":[" + string.Join(",", displays.ToArray()) + "]}");
                    return 0;
                }
                finally
                {
                    Marshal.FreeHGlobal(pathArray);
                    Marshal.FreeHGlobal(modeArray);
                }
            }
            throw new InvalidOperationException("Display configuration changed repeatedly");
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.Message);
            return 1;
        }
    }
}
