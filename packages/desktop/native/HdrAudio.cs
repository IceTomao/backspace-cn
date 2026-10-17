// WASAPI render-endpoint loopback only: never opens a microphone or creates video.
// PCM leaves this owned process on stdout; its format and failures use stderr.
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;

internal static class HdrAudio
{
    [DllImport("ole32.dll")] private static extern int CoInitializeEx(IntPtr reserved, uint flags);
    [DllImport("ole32.dll")] private static extern void CoUninitialize();
    [DllImport("ole32.dll")] private static extern int CoCreateInstance(ref Guid clsid, IntPtr outer, uint context, ref Guid iid, out IntPtr value);
    [DllImport("kernel32.dll")] private static extern bool QueryPerformanceCounter(out long value);
    [DllImport("kernel32.dll")] private static extern bool QueryPerformanceFrequency(out long value);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int DefaultEndpoint(IntPtr self, int flow, int role, out IntPtr value);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int Activate(IntPtr self, ref Guid iid, uint context, IntPtr parameters, out IntPtr value);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int MixFormat(IntPtr self, out IntPtr format);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int Initialize(IntPtr self, int mode, uint flags, long duration, long period, IntPtr format, IntPtr session);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int Service(IntPtr self, ref Guid iid, out IntPtr value);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int Call(IntPtr self);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int NextPacket(IntPtr self, out uint frames);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int GetBuffer(IntPtr self, out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong qpcPosition);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int ReleaseBuffer(IntPtr self, uint frames);

    private static Delegate Method(IntPtr instance, int slot, Type type)
    { return Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(Marshal.ReadIntPtr(instance), slot * IntPtr.Size), type); }
    private static void Check(int result) { if (result < 0) Marshal.ThrowExceptionForHR(result); }
    private static void Emit(object value) { Console.Error.WriteLine(new JavaScriptSerializer().Serialize(value)); Console.Error.Flush(); }

    [MTAThread]
    private static int Main()
    {
        IntPtr enumerator = IntPtr.Zero, endpoint = IntPtr.Zero, client = IntPtr.Zero, capture = IntPtr.Zero, format = IntPtr.Zero;
        bool initialized = false, started = false;
        try
        {
            Check(CoInitializeEx(IntPtr.Zero, 0)); initialized = true;
            Guid clsid = new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E"), iid = new Guid("A95664D2-9614-4F35-A746-DE8DB63617E6");
            Check(CoCreateInstance(ref clsid, IntPtr.Zero, 23, ref iid, out enumerator));
            Check(((DefaultEndpoint)Method(enumerator, 4, typeof(DefaultEndpoint)))(enumerator, 0, 1, out endpoint));
            iid = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
            Check(((Activate)Method(endpoint, 3, typeof(Activate)))(endpoint, ref iid, 23, IntPtr.Zero, out client));
            Check(((MixFormat)Method(client, 8, typeof(MixFormat)))(client, out format));
            int tag = (ushort)Marshal.ReadInt16(format, 0), channels = (ushort)Marshal.ReadInt16(format, 2);
            int sampleRate = Marshal.ReadInt32(format, 4), align = (ushort)Marshal.ReadInt16(format, 12), bits = (ushort)Marshal.ReadInt16(format, 14);
            bool floating = tag == 3;
            if (tag == 65534)
            {
                if ((ushort)Marshal.ReadInt16(format, 16) < 22) throw new InvalidOperationException();
                Guid subformat = (Guid)Marshal.PtrToStructure(IntPtr.Add(format, 24), typeof(Guid));
                floating = subformat == new Guid("00000003-0000-0010-8000-00aa00389b71");
                if (!floating && subformat != new Guid("00000001-0000-0010-8000-00aa00389b71")) throw new InvalidOperationException();
            }
            else if (tag != 1 && tag != 3) throw new InvalidOperationException();
            string pcm = floating && bits == 32 ? "f32le" : !floating && bits == 16 ? "s16le" : !floating && bits == 24 ? "s24le" : !floating && bits == 32 ? "s32le" : null;
            if (pcm == null || channels < 1 || channels > 8 || sampleRate < 8000 || sampleRate > 192000 || align != channels * bits / 8) throw new InvalidOperationException();
            Check(((Initialize)Method(client, 3, typeof(Initialize)))(client, 0, 0x20000, 1000000, 0, format, IntPtr.Zero));
            iid = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");
            Check(((Service)Method(client, 14, typeof(Service)))(client, ref iid, out capture));
            var next = (NextPacket)Method(capture, 5, typeof(NextPacket));
            var get = (GetBuffer)Method(capture, 3, typeof(GetBuffer));
            var release = (ReleaseBuffer)Method(capture, 4, typeof(ReleaseBuffer));
            var parent = new Thread(delegate() { try { while (Console.ReadLine() != null) { } } catch { } Environment.Exit(0); });
            parent.IsBackground = true; parent.Start();
            long counter, frequency; QueryPerformanceFrequency(out frequency); QueryPerformanceCounter(out counter);
            double startHns = counter * (10000000.0 / frequency);
            var clock = Stopwatch.StartNew();
            Check(((Call)Method(client, 10, typeof(Call)))(client)); started = true;
            Emit(new { type = "audio-ready", sampleRate = sampleRate, channels = channels, format = pcm });
            Stream output = Console.OpenStandardOutput();
            long framesSent = 0;
            byte[] silence = new byte[sampleRate / 50 * align];
            for (;;)
            {
                uint frames; Check(next(capture, out frames));
                if (frames == 0)
                {
                    // Loopback emits no packets during complete endpoint silence.
                    // Keep its independent Opus track alive; late packets are trimmed
                    // using their WASAPI QPC positions so silence never doubles time.
                    long due = (long)(clock.Elapsed.TotalSeconds * sampleRate) - sampleRate / 20;
                    while (framesSent + sampleRate / 50 <= due)
                    { output.Write(silence, 0, silence.Length); framesSent += sampleRate / 50; }
                    Thread.Sleep(5); continue;
                }
                IntPtr data; uint flags; ulong position, qpc;
                Check(get(capture, out data, out frames, out flags, out position, out qpc));
                try
                {
                    int length = checked((int)frames * align);
                    if (length > 8 * 1024 * 1024 || (flags & 4) != 0) throw new InvalidOperationException("Audio clock unavailable");
                    long start = Math.Max(0, (long)((qpc - startHns) * sampleRate / 10000000.0));
                    if (start - framesSent > sampleRate) throw new InvalidOperationException("Audio clock discontinuity");
                    while (framesSent < start)
                    {
                        int fill = (int)Math.Min(start - framesSent, silence.Length / align);
                        output.Write(silence, 0, fill * align); framesSent += fill;
                    }
                    int skip = (int)Math.Min(frames, Math.Max(0, framesSent - start));
                    int count = checked(((int)frames - skip) * align);
                    if (count > 0)
                    {
                        byte[] bytes = new byte[count];
                        if ((flags & 2) == 0) Marshal.Copy(IntPtr.Add(data, skip * align), bytes, 0, count);
                        output.Write(bytes, 0, bytes.Length); framesSent += count / align;
                    }
                }
                finally { Check(release(capture, frames)); }
            }
        }
        catch { Emit(new { type = "failed", reason = "system_audio_unavailable" }); return 1; }
        finally
        {
            if (started) { try { ((Call)Method(client, 11, typeof(Call)))(client); } catch { } }
            if (format != IntPtr.Zero) Marshal.FreeCoTaskMem(format);
            foreach (IntPtr value in new[] { capture, client, endpoint, enumerator }) if (value != IntPtr.Zero) Marshal.Release(value);
            if (initialized) CoUninitialize();
        }
    }
}
