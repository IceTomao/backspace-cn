// WASAPI loopback only (per-process tree or render-endpoint fallback): never opens a microphone or creates video.
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
    [DllImport("mmdevapi.dll", ExactSpelling = true, PreserveSig = true)]
    private static extern int ActivateAudioInterfaceAsync(
        [MarshalAs(UnmanagedType.LPWStr)] string deviceInterfacePath,
        ref Guid riid,
        IntPtr activationParams,
        IActivateAudioInterfaceCompletionHandler completionHandler,
        out IActivateAudioInterfaceAsyncOperation activationOperation);

    [ComImport, Guid("94EA2B94-E9CC-49E0-C0FF-EE64CA8F5B90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAgileObject { }

    [ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IActivateAudioInterfaceAsyncOperation
    {
        [PreserveSig]
        int GetActivateResult(out int activateResult, out IntPtr activatedInterface);
    }

    [ComImport, Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IActivateAudioInterfaceCompletionHandler
    {
        [PreserveSig]
        int ActivateCompleted(IActivateAudioInterfaceAsyncOperation activateOperation);
    }

    private sealed class ProcessLoopbackActivator : IActivateAudioInterfaceCompletionHandler, IAgileObject
    {
        public readonly ManualResetEvent Done = new ManualResetEvent(false);
        public int HrResult = -1;
        public IntPtr AudioClient = IntPtr.Zero;

        public int ActivateCompleted(IActivateAudioInterfaceAsyncOperation activateOperation)
        {
            try
            {
                if (activateOperation != null)
                {
                    int hrCall = activateOperation.GetActivateResult(out HrResult, out AudioClient);
                    if (hrCall < 0 && HrResult >= 0) HrResult = hrCall;
                }
            }
            catch (Exception ex)
            {
                HrResult = Marshal.GetHRForException(ex);
            }
            finally
            {
                Done.Set();
            }
            return 0;
        }
    }

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

    private static uint ParseTargetPid(string[] args)
    {
        if (args == null || args.Length == 0) return 0;
        if (args.Length == 2 && args[0] == "--pid")
        {
            uint pid;
            if (uint.TryParse(args[1], out pid) && pid > 0) return pid;
        }
        throw new InvalidOperationException("Invalid audio arguments");
    }

    private static bool TryOpenProcessLoopback(uint targetPid, out IntPtr client, out IntPtr format)
    {
        client = IntPtr.Zero;
        format = IntPtr.Zero;
        IntPtr pParams = IntPtr.Zero;
        IntPtr pPropVariant = IntPtr.Zero;
        IActivateAudioInterfaceAsyncOperation asyncOp = null;
        var activator = new ProcessLoopbackActivator();
        bool asyncPending = false;
        try
        {
            // AUDIOCLIENT_ACTIVATION_PARAMS (12 bytes):
            //   [0] ActivationType = 1 (AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK)
            //   [4] TargetProcessId = targetPid
            //   [8] ProcessLoopbackMode = 0 (PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE)
            pParams = Marshal.AllocCoTaskMem(12);
            Marshal.WriteInt32(pParams, 0, 1);
            Marshal.WriteInt32(pParams, 4, unchecked((int)targetPid));
            Marshal.WriteInt32(pParams, 8, 0);

            int propSize = IntPtr.Size == 8 ? 24 : 16;
            pPropVariant = Marshal.AllocCoTaskMem(propSize);
            for (int i = 0; i < propSize; i++) Marshal.WriteByte(pPropVariant, i, 0);
            Marshal.WriteInt16(pPropVariant, 0, 65); // VT_BLOB
            Marshal.WriteInt32(pPropVariant, 8, 12); // cbSize
            Marshal.WriteIntPtr(pPropVariant, IntPtr.Size == 8 ? 16 : 12, pParams);

            Guid iidAudioClient = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
            int hr = ActivateAudioInterfaceAsync("VAD\\Process_Loopback", ref iidAudioClient, pPropVariant, activator, out asyncOp);
            if (hr < 0) return false;
            asyncPending = true;
            if (!activator.Done.WaitOne(5000)) return false;
            asyncPending = false;
            if (activator.HrResult < 0 || activator.AudioClient == IntPtr.Zero) return false;

            // WAVEFORMATEX (18 bytes): 48kHz stereo 32-bit IEEE float
            format = Marshal.AllocCoTaskMem(18);
            Marshal.WriteInt16(format, 0, 3); // WAVE_FORMAT_IEEE_FLOAT
            Marshal.WriteInt16(format, 2, 2); // nChannels = 2
            Marshal.WriteInt32(format, 4, 48000); // nSamplesPerSec = 48000
            Marshal.WriteInt32(format, 8, 48000 * 8); // nAvgBytesPerSec
            Marshal.WriteInt16(format, 12, 8); // nBlockAlign = 8
            Marshal.WriteInt16(format, 14, 32); // wBitsPerSample = 32
            Marshal.WriteInt16(format, 16, 0); // cbSize = 0

            var init = (Initialize)Method(activator.AudioClient, 3, typeof(Initialize));
            // AUDCLNT_STREAMFLAGS_LOOPBACK (0x00020000) | AUTOCONVERTPCM (0x80000000) | SRC_DEFAULT_QUALITY (0x08000000)
            int hrInit = init(activator.AudioClient, 0, 0x00020000u, 1000000, 0, format, IntPtr.Zero);
            if (hrInit < 0)
            {
                hrInit = init(activator.AudioClient, 0, 0x88020000u, 0, 0, format, IntPtr.Zero);
            }
            if (hrInit < 0)
            {
                Marshal.Release(activator.AudioClient);
                activator.AudioClient = IntPtr.Zero;
                Marshal.FreeCoTaskMem(format);
                format = IntPtr.Zero;
                return false;
            }
            client = activator.AudioClient;
            activator.AudioClient = IntPtr.Zero;
            return true;
        }
        catch
        {
            if (activator.AudioClient != IntPtr.Zero)
            {
                Marshal.Release(activator.AudioClient);
                activator.AudioClient = IntPtr.Zero;
            }
            if (format != IntPtr.Zero)
            {
                Marshal.FreeCoTaskMem(format);
                format = IntPtr.Zero;
            }
            return false;
        }
        finally
        {
            if (asyncOp != null) Marshal.ReleaseComObject(asyncOp);
            // Only free unmanaged activation memory if async activation is no longer reading it.
            if (!asyncPending)
            {
                if (pPropVariant != IntPtr.Zero) Marshal.FreeCoTaskMem(pPropVariant);
                if (pParams != IntPtr.Zero) Marshal.FreeCoTaskMem(pParams);
                activator.Done.Close();
            }
        }
    }

    [MTAThread]
    private static int Main(string[] args)
    {
        IntPtr enumerator = IntPtr.Zero, endpoint = IntPtr.Zero, client = IntPtr.Zero, capture = IntPtr.Zero, format = IntPtr.Zero;
        bool initialized = false, started = false, isProcessLoopback = false;
        try
        {
            uint targetPid = ParseTargetPid(args);
            Check(CoInitializeEx(IntPtr.Zero, 0)); initialized = true;

            if (targetPid != 0 && TryOpenProcessLoopback(targetPid, out client, out format))
            {
                isProcessLoopback = true;
            }
            else
            {
                Guid clsid = new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E"), iid = new Guid("A95664D2-9614-4F35-A746-DE8DB63617E6");
                Check(CoCreateInstance(ref clsid, IntPtr.Zero, 23, ref iid, out enumerator));
                Check(((DefaultEndpoint)Method(enumerator, 4, typeof(DefaultEndpoint)))(enumerator, 0, 1, out endpoint));
                iid = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
                Check(((Activate)Method(endpoint, 3, typeof(Activate)))(endpoint, ref iid, 23, IntPtr.Zero, out client));
                Check(((MixFormat)Method(client, 8, typeof(MixFormat)))(client, out format));
            }

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
            if (!isProcessLoopback)
            {
                Check(((Initialize)Method(client, 3, typeof(Initialize)))(client, 0, 0x20000, 1000000, 0, format, IntPtr.Zero));
            }
            Guid iidCapture = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");
            Check(((Service)Method(client, 14, typeof(Service)))(client, ref iidCapture, out capture));
            var next = (NextPacket)Method(capture, 5, typeof(NextPacket));
            var get = (GetBuffer)Method(capture, 3, typeof(GetBuffer));
            var release = (ReleaseBuffer)Method(capture, 4, typeof(ReleaseBuffer));
            var parent = new Thread(delegate() { try { while (Console.ReadLine() != null) { } } catch { } Environment.Exit(0); });
            parent.IsBackground = true; parent.Start();
            long counter, frequency; QueryPerformanceFrequency(out frequency); QueryPerformanceCounter(out counter);
            double startHns = counter * (10000000.0 / frequency);
            var clock = Stopwatch.StartNew();
            Check(((Call)Method(client, 10, typeof(Call)))(client)); started = true;
            Emit(new { type = "audio-ready", sampleRate = sampleRate, channels = channels, format = pcm, mode = isProcessLoopback ? "process" : "endpoint" });
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
                    if (length > 8 * 1024 * 1024) throw new InvalidOperationException("Audio packet exceeds limit");
                    if (isProcessLoopback)
                    {
                        // Virtual process-loopback devices may omit QPC or set TIMESTAMP_ERROR on early packets.
                        // Keep wall-clock pacing bounded without rejecting valid application audio packets.
                        long wallFrames = (long)(clock.Elapsed.TotalSeconds * sampleRate);
                        if (wallFrames - framesSent > sampleRate / 10)
                        {
                            long target = wallFrames - sampleRate / 25;
                            while (framesSent < target)
                            {
                                int fill = (int)Math.Min(target - framesSent, silence.Length / align);
                                output.Write(silence, 0, fill * align); framesSent += fill;
                            }
                        }
                        byte[] bytes = new byte[length];
                        if ((flags & 2) == 0) Marshal.Copy(data, bytes, 0, length);
                        output.Write(bytes, 0, bytes.Length);
                        framesSent += frames;
                    }
                    else
                    {
                        if ((flags & 4) != 0) throw new InvalidOperationException("Audio clock unavailable");
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
