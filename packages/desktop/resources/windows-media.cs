using System;
using System.Threading;
using System.Text;
using Windows.Foundation;
using Windows.Media.Control;
using Windows.Media.MediaProperties;
using Windows.Storage.Streams;

internal static class WindowsMediaHelper
{
    private static string Escape(string value)
    {
        return (value ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "\\r").Replace("\n", "\\n");
    }

    private static string Status(GlobalSystemMediaTransportControlsSessionPlaybackStatus status)
    {
        return status == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing ? "playing"
            : status == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Paused ? "paused"
            : "stopped";
    }

    private static T Wait<T>(IAsyncOperation<T> operation)
    {
        while (operation.Status == AsyncStatus.Started) Thread.Sleep(10);
        if (operation.Status != AsyncStatus.Completed) throw new InvalidOperationException();
        return operation.GetResults();
    }

    private static T Wait<T, P>(IAsyncOperationWithProgress<T, P> operation)
    {
        while (operation.Status == AsyncStatus.Started) Thread.Sleep(10);
        if (operation.Status != AsyncStatus.Completed) throw new InvalidOperationException();
        return operation.GetResults();
    }

    private static string[] Thumbnail(GlobalSystemMediaTransportControlsSessionMediaProperties properties)
    {
        try
        {
            if (properties.Thumbnail == null) return new string[] { "", "" };
            using (var stream = Wait(properties.Thumbnail.OpenReadAsync()))
            {
                if (stream.Size == 0 || stream.Size > 8 * 1024 * 1024) return new string[] { "", "" };
                var buffer = new Windows.Storage.Streams.Buffer((uint)stream.Size);
                var result = Wait<IBuffer, uint>(stream.ReadAsync(buffer, (uint)stream.Size, InputStreamOptions.None));
                using (var reader = DataReader.FromBuffer(result))
                {
                    var bytes = new byte[result.Length];
                    reader.ReadBytes(bytes);
                    return new string[] { Convert.ToBase64String(bytes), stream.ContentType ?? "" };
                }
            }
        }
        catch { return new string[] { "", "" }; }
    }

    public static void Main()
    {
        // Node reads the helper's pipe as UTF-8. The Windows console code page
        // otherwise corrupts Chinese song and artist metadata before Node sees it.
        Console.OutputEncoding = new UTF8Encoding(false);
        var manager = Wait(GlobalSystemMediaTransportControlsSessionManager.RequestAsync());
        var last = String.Empty;
        var lastMediaKey = String.Empty;
        var thumbnail = new string[] { "", "" };
        var coverPoll = 0;
        while (true)
        {
            try
            {
                var session = manager.GetCurrentSession();
                var json = "{\"status\":\"stopped\"}";
                if (session != null)
                {
                    var properties = Wait(session.TryGetMediaPropertiesAsync());
                    var playback = session.GetPlaybackInfo();
                    var mediaKey = session.SourceAppUserModelId + "\n" + properties.Title + "\n" + properties.Artist + "\n" + properties.AlbumTitle;
                    if (mediaKey != lastMediaKey || ++coverPoll >= 5)
                    {
                        thumbnail = Thumbnail(properties);
                        lastMediaKey = mediaKey;
                        coverPoll = 0;
                    }
                    json = "{\"source\":\"" + Escape(session.SourceAppUserModelId)
                        + "\",\"title\":\"" + Escape(properties.Title)
                        + "\",\"artist\":\"" + Escape(properties.Artist)
                        + "\",\"album\":\"" + Escape(properties.AlbumTitle)
                        + "\",\"thumbnailBase64\":\"" + thumbnail[0]
                        + "\",\"thumbnailMime\":\"" + Escape(thumbnail[1])
                        + "\",\"status\":\"" + Status(playback.PlaybackStatus) + "\"}";
                }
                if (json != last)
                {
                    Console.WriteLine(json);
                    Console.Out.Flush();
                    last = json;
                }
            }
            catch
            {
                // A player can close between GetCurrentSession and metadata access.
            }
            Thread.Sleep(1000);
        }
    }
}
