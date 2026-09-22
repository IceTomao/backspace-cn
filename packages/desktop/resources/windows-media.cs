using System;
using System.Threading;
using System.Text;
using Windows.Foundation;
using Windows.Media.Control;
using Windows.Media.MediaProperties;

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

    public static void Main()
    {
        // Node reads the helper's pipe as UTF-8. The Windows console code page
        // otherwise corrupts Chinese song and artist metadata before Node sees it.
        Console.OutputEncoding = new UTF8Encoding(false);
        var manager = Wait(GlobalSystemMediaTransportControlsSessionManager.RequestAsync());
        var last = String.Empty;
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
                    json = "{\"source\":\"" + Escape(session.SourceAppUserModelId)
                        + "\",\"title\":\"" + Escape(properties.Title)
                        + "\",\"artist\":\"" + Escape(properties.Artist)
                        + "\",\"album\":\"" + Escape(properties.AlbumTitle)
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
