// Captures the audio of one process tree (Spotify) through WASAPI process
// loopback and writes it to stdout as raw PCM: 48 kHz, stereo, s16le.
// Silence is written while the app is quiet, so the stream keeps real time.
//
//   spotify-capture.exe <root process id>
//
// Needs Windows 10 2004 or later. Compiled on demand by server/sports/listen.mjs
// with the .NET Framework csc.exe. Exits when stdout closes or the process ends.
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

static class SpotifyCapture
{
    const int SampleRate = 48000;
    const int Channels = 2;
    const int BlockAlign = 4;
    const uint LoopbackFlags = 0x00020000 | 0x00040000 | 0x80000000 | 0x08000000; // loopback, event callback, auto-convert PCM, default SRC quality
    const uint SilentFlag = 0x2;

    [ComImport, Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IActivateAudioInterfaceCompletionHandler
    {
        void ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation);
    }

    [ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IActivateAudioInterfaceAsyncOperation
    {
        void GetActivateResult(out int activateResult, [MarshalAs(UnmanagedType.IUnknown)] out object activatedInterface);
    }

    [ComImport, Guid("94ea2b94-e9cc-49e0-c0ff-ee64ca8f5b90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAgileObject { }

    [ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioClient
    {
        void Initialize(int shareMode, uint streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr sessionGuid);
        void GetBufferSize(out uint frames);
        void GetStreamLatency(out long latency);
        void GetCurrentPadding(out uint padding);
        void IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);
        void GetMixFormat(out IntPtr format);
        void GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
        void Start();
        void Stop();
        void Reset();
        void SetEventHandle(IntPtr handle);
        void GetService([MarshalAs(UnmanagedType.LPStruct)] Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }

    [ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioCaptureClient
    {
        void GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong qpcPosition);
        void ReleaseBuffer(uint frames);
        void GetNextPacketSize(out uint frames);
    }

    [DllImport("Mmdevapi.dll", ExactSpelling = true, PreserveSig = false)]
    static extern void ActivateAudioInterfaceAsync(
        [MarshalAs(UnmanagedType.LPWStr)] string deviceInterfacePath,
        [MarshalAs(UnmanagedType.LPStruct)] Guid riid,
        IntPtr activationParams,
        IActivateAudioInterfaceCompletionHandler completionHandler,
        out IActivateAudioInterfaceAsyncOperation activationOperation);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr CreateEvent(IntPtr attributes, bool manualReset, bool initialState, string name);

    [DllImport("kernel32.dll")]
    static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    sealed class Completion : IActivateAudioInterfaceCompletionHandler, IAgileObject
    {
        public readonly ManualResetEvent Done = new ManualResetEvent(false);
        public int Result;
        public object Client;
        public void ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation)
        {
            operation.GetActivateResult(out Result, out Client);
            Done.Set();
        }
    }

    static IAudioClient Activate(uint processId)
    {
        // AUDIOCLIENT_ACTIVATION_PARAMS: process loopback, include the whole tree.
        IntPtr parameters = Marshal.AllocHGlobal(12);
        Marshal.WriteInt32(parameters, 0, 1);
        Marshal.WriteInt32(parameters, 4, (int)processId);
        Marshal.WriteInt32(parameters, 8, 0);
        // PROPVARIANT holding a VT_BLOB that points at those parameters.
        IntPtr variant = Marshal.AllocHGlobal(24);
        for (int i = 0; i < 24; i++) Marshal.WriteByte(variant, i, 0);
        Marshal.WriteInt16(variant, 0, 65);
        Marshal.WriteInt32(variant, 8, 12);
        Marshal.WriteIntPtr(variant, 16, parameters);

        var completion = new Completion();
        IActivateAudioInterfaceAsyncOperation operation;
        ActivateAudioInterfaceAsync("VAD\\Process_Loopback", typeof(IAudioClient).GUID, variant, completion, out operation);
        if (!completion.Done.WaitOne(10000)) throw new TimeoutException("Audio activation timed out.");
        if (completion.Result != 0) Marshal.ThrowExceptionForHR(completion.Result);
        return (IAudioClient)completion.Client;
    }

    [MTAThread]
    static int Main(string[] args)
    {
        uint processId;
        if (args.Length != 1 || !uint.TryParse(args[0], out processId))
        {
            Console.Error.WriteLine("Usage: spotify-capture.exe <process id>");
            return 2;
        }
        Process target;
        try { target = Process.GetProcessById((int)processId); }
        catch (ArgumentException) { Console.Error.WriteLine("That process is not running."); return 3; }

        try
        {
            IAudioClient client = Activate(processId);
            IntPtr format = Marshal.AllocHGlobal(18);
            Marshal.WriteInt16(format, 0, 1);                       // PCM
            Marshal.WriteInt16(format, 2, Channels);
            Marshal.WriteInt32(format, 4, SampleRate);
            Marshal.WriteInt32(format, 8, SampleRate * BlockAlign);
            Marshal.WriteInt16(format, 12, BlockAlign);
            Marshal.WriteInt16(format, 14, 16);
            Marshal.WriteInt16(format, 16, 0);
            client.Initialize(0, LoopbackFlags, 2000000, 0, format, IntPtr.Zero);
            IntPtr ready = CreateEvent(IntPtr.Zero, false, false, null);
            client.SetEventHandle(ready);
            object service;
            client.GetService(typeof(IAudioCaptureClient).GUID, out service);
            var capture = (IAudioCaptureClient)service;

            Stream output = Console.OpenStandardOutput();
            var buffer = new byte[SampleRate * BlockAlign];
            var silence = new byte[SampleRate * BlockAlign / 10];
            var clock = Stopwatch.StartNew();
            long written = 0;
            client.Start();
            while (!target.HasExited)
            {
                WaitForSingleObject(ready, 20);
                uint packet;
                capture.GetNextPacketSize(out packet);
                while (packet > 0)
                {
                    IntPtr data; uint frames; uint flags; ulong devicePosition; ulong qpcPosition;
                    capture.GetBuffer(out data, out frames, out flags, out devicePosition, out qpcPosition);
                    int bytes = (int)frames * BlockAlign;
                    if (bytes > buffer.Length) buffer = new byte[bytes];
                    if ((flags & SilentFlag) != 0) Array.Clear(buffer, 0, bytes);
                    else Marshal.Copy(data, buffer, 0, bytes);
                    capture.ReleaseBuffer(frames);
                    output.Write(buffer, 0, bytes);
                    written += frames;
                    capture.GetNextPacketSize(out packet);
                }
                // Spotify sends nothing while paused: fill the gap with silence
                // so the encoder and the listeners' players keep running.
                long expected = (long)(clock.Elapsed.TotalSeconds * SampleRate);
                while (written < expected - SampleRate / 10)
                {
                    output.Write(silence, 0, silence.Length);
                    written += silence.Length / BlockAlign;
                }
                output.Flush();
            }
            client.Stop();
            return 0;
        }
        catch (IOException)
        {
            return 0; // The listener closed the pipe.
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.Message);
            return 1;
        }
    }
}
