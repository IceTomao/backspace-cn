// hdr-bridge transports already encoded HEVC. It never captures, decodes,
// tone maps, or creates a backup video track. Credentials arrive on stdin,
// never in command-line arguments or logs.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/livekit/protocol/livekit"
	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/livekit/server-sdk-go/v2/pkg/samplebuilder"
	"github.com/pion/rtp/codecs"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
	"github.com/pion/webrtc/v4/pkg/media/h265reader"
	"github.com/pion/webrtc/v4/pkg/media/oggwriter"
)

const trackName = "backspace-screen-hdr-v1"
const audioTrackName = "backspace-screen-hdr-audio-v1"
const identityPrefix = "__backspace_hdr_v1__"

type configuration struct {
	Protocol  int    `json:"protocol"`
	Mode      string `json:"mode"`
	URL       string `json:"url"`
	Token     string `json:"token"`
	Publisher string `json:"publisher"`
	FPS       int    `json:"fps"`
	Width     int    `json:"width"`
	Height    int    `json:"height"`
	AudioURL  string `json:"audioUrl"`
}

func validAudioURL(raw string) bool {
	parsed, err := url.Parse(raw)
	return err == nil && parsed.Scheme == "http" && parsed.Hostname() == "127.0.0.1" && parsed.Port() != "" && parsed.User == nil && parsed.RawQuery == "" && parsed.Fragment == "" && regexp.MustCompile(`^/[a-f0-9]{64}$`).MatchString(parsed.Path)
}

func (c configuration) validate() error {
	if c.AudioURL != "" && !validAudioURL(c.AudioURL) {
		return errors.New("invalid audio pipe")
	}
	if c.Protocol != 1 || (c.Mode != "publish" && c.Mode != "receive") ||
		!(strings.HasPrefix(c.URL, "wss://") || strings.HasPrefix(c.URL, "ws://127.0.0.1:")) ||
		len(c.Token) == 0 || len(c.Token) > 16384 {
		return errors.New("invalid bridge configuration")
	}
	if c.Mode == "publish" && (c.FPS < 1 || c.FPS > 120 || c.Width < 256 || c.Width > 7680 ||
		c.Height < 128 || c.Height > 4320 || c.Width%2 != 0 || c.Height%2 != 0) {
		return errors.New("invalid HDR video dimensions or frame rate")
	}
	if c.Mode == "receive" && (!strings.HasPrefix(c.Publisher, identityPrefix) || len(c.Publisher) > 256) {
		return errors.New("invalid HDR publisher")
	}
	return nil
}

var eventLock sync.Mutex

func event(kind string, fields map[string]any) {
	eventLock.Lock()
	defer eventLock.Unlock()
	if fields == nil {
		fields = map[string]any{}
	}
	fields["type"] = kind
	_ = json.NewEncoder(os.Stderr).Encode(fields)
}

func main() {
	if err := run(); err != nil {
		// SDK errors can include connection URLs. Do not put them on the IPC wire.
		event("failed", map[string]any{"reason": "native_transport_failed"})
		os.Exit(1)
	}
}

func run() error {
	in := bufio.NewReaderSize(os.Stdin, 65536)
	line, err := in.ReadSlice('\n')
	if err != nil {
		return errors.New("missing configuration")
	}
	var cfg configuration
	if err = json.Unmarshal(line, &cfg); err != nil {
		return err
	}
	if err = cfg.validate(); err != nil {
		return err
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
	defer cancel()
	failed := make(chan error, 1)
	fail := func(err error) {
		select {
		case failed <- err:
		default:
		}
		cancel()
	}
	cb := &lksdk.RoomCallback{
		OnDisconnected: func() { fail(errors.New("disconnected")) },
		OnReconnecting: func() { fail(errors.New("connection interrupted; restart with a fresh token")) },
	}
	var videoStarted atomic.Bool
	wants := func(identity, name string, source livekit.TrackSource, mime string) bool {
		return matchesPublication(cfg.Publisher, identity, name, source, mime) || (cfg.AudioURL != "" && matchesAudio(cfg.Publisher, identity, name, source, mime))
	}
	cb.OnTrackPublished = func(pub *lksdk.RemoteTrackPublication, p *lksdk.RemoteParticipant) {
		if cfg.Mode == "receive" && wants(p.Identity(), pub.Name(), pub.Source(), pub.MimeType()) {
			if err := pub.SetSubscribed(true); err != nil {
				fail(err)
			}
		}
	}
	cb.OnTrackSubscribed = func(track *webrtc.TrackRemote, pub *lksdk.RemoteTrackPublication, p *lksdk.RemoteParticipant) {
		if cfg.Mode != "receive" || !wants(p.Identity(), pub.Name(), pub.Source(), track.Codec().MimeType) {
			_ = pub.SetSubscribed(false)
			return
		}
		if track.Kind() == webrtc.RTPCodecTypeAudio {
			go receiveAudio(ctx, cfg.AudioURL, track, &videoStarted, fail)
		} else {
			go receive(ctx, track, p, &videoStarted, fail)
		}
	}
	cb.OnTrackUnpublished = func(pub *lksdk.RemoteTrackPublication, p *lksdk.RemoteParticipant) {
		if cfg.Mode == "receive" && p.Identity() == cfg.Publisher && (pub.Name() == trackName || (cfg.AudioURL != "" && pub.Name() == audioTrackName)) {
			fail(io.EOF)
		}
	}
	room, err := lksdk.ConnectToRoomWithToken(cfg.URL, cfg.Token, cb, lksdk.WithAutoSubscribe(false))
	if err != nil {
		return err
	}
	defer room.Disconnect()
	if cfg.Mode == "receive" {
		for _, p := range room.GetRemoteParticipants() {
			for _, raw := range p.TrackPublications() {
				pub, ok := raw.(*lksdk.RemoteTrackPublication)
				if ok && wants(p.Identity(), pub.Name(), pub.Source(), pub.MimeType()) {
					if err := pub.SetSubscribed(true); err != nil {
						return err
					}
				}
			}
		}
		// Closing the owning Electron process closes stdin, even after a crash.
		go func() { _, _ = io.Copy(io.Discard, in); cancel() }()
	} else {
		if cfg.AudioURL != "" {
			response, err := localAudioRequest(ctx, "GET", cfg.AudioURL, nil)
			if err != nil {
				return err
			}
			defer response.Body.Close()
			audio, err := lksdk.NewLocalReaderTrack(response.Body, webrtc.MimeTypeOpus, lksdk.ReaderTrackWithOnWriteComplete(func() { fail(io.EOF) }))
			if err != nil {
				return err
			}
			defer audio.Close()
			if _, err := room.LocalParticipant.PublishTrack(audio, &lksdk.TrackPublicationOptions{Name: audioTrackName, Source: livekit.TrackSource_SCREEN_SHARE_AUDIO}); err != nil {
				return err
			}
		}
		track, err := lksdk.NewLocalTrack(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH265, ClockRate: 90000,
			SDPFmtpLine: "profile-id=2;tier-flag=0;level-id=153;tx-mode=SRST"})
		if err != nil {
			return err
		}
		defer track.Close()
		bound := make(chan struct{})
		var bindOnce sync.Once
		track.OnBind(func() { bindOnce.Do(func() { close(bound) }) })
		pub, err := room.LocalParticipant.PublishTrack(track, &lksdk.TrackPublicationOptions{
			Name: trackName, Source: livekit.TrackSource_SCREEN_SHARE,
			VideoWidth: cfg.Width, VideoHeight: cfg.Height,
		})
		if err != nil {
			return err
		}
		// The owner additionally validates the bitstream and waits for outbound
		// bytes before announcing HDR; a publication acknowledgement is insufficient.
		event("published", map[string]any{"trackSid": pub.SID(), "identity": room.LocalParticipant.Identity()})
		go func() {
			select {
			case <-bound:
			case <-ctx.Done():
				return
			}
			var sent uint64
			lastReport := time.Now()
			err := readAccessUnits(in, func(data []byte) error {
				if err := track.WriteSample(media.Sample{Data: data, Duration: time.Second / time.Duration(cfg.FPS)}, nil); err != nil {
					return err
				}
				if sent == 0 {
					event("streaming", map[string]any{"trackSid": pub.SID(), "identity": room.LocalParticipant.Identity()})
				}
				sent += uint64(len(data))
				if time.Since(lastReport) >= time.Second {
					event("sending", map[string]any{"bytes": sent})
					lastReport = time.Now()
				}
				return nil
			})
			fail(err)
		}()
	}
	select {
	case <-ctx.Done():
		return nil
	case err := <-failed:
		return err
	}
}

func matchesPublication(target, identity, name string, source livekit.TrackSource, mime string) bool {
	return identity == target && strings.HasPrefix(identity, identityPrefix) &&
		name == trackName && source == livekit.TrackSource_SCREEN_SHARE && strings.EqualFold(mime, webrtc.MimeTypeH265)
}

func matchesAudio(target, identity, name string, source livekit.TrackSource, mime string) bool {
	return identity == target && strings.HasPrefix(identity, identityPrefix) && name == audioTrackName && source == livekit.TrackSource_SCREEN_SHARE_AUDIO && strings.EqualFold(mime, webrtc.MimeTypeOpus)
}

func localAudioRequest(ctx context.Context, method, address string, body io.Reader) (*http.Response, error) {
	if !validAudioURL(address) {
		return nil, errors.New("invalid audio pipe")
	}
	request, err := http.NewRequestWithContext(ctx, method, address, body)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "audio/ogg")
	client := &http.Client{Transport: &http.Transport{Proxy: nil, ResponseHeaderTimeout: 15 * time.Second}, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return errors.New("audio redirect denied") }}
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	if response.StatusCode != 200 {
		_ = response.Body.Close()
		return nil, errors.New("audio pipe rejected")
	}
	return response, nil
}

func receiveAudio(ctx context.Context, address string, track *webrtc.TrackRemote, videoStarted *atomic.Bool, fail func(error)) {
	reader, writer := io.Pipe()
	defer reader.Close()
	defer writer.Close()
	go func() {
		response, err := localAudioRequest(ctx, "POST", address, reader)
		if err != nil {
			fail(err)
			return
		}
		defer response.Body.Close()
		_, err = io.Copy(io.Discard, response.Body)
		if ctx.Err() == nil {
			fail(err)
		}
	}()
	ogg, err := oggwriter.NewWith(writer, 48000, 2)
	if err != nil {
		fail(err)
		return
	}
	defer ogg.Close()
	for {
		packet, _, err := track.ReadRTP()
		if err != nil {
			fail(err)
			return
		}
		if ctx.Err() != nil {
			return
		}
		if !videoStarted.Load() || len(packet.Payload) == 0 {
			continue
		}
		if err := ogg.WriteRTP(packet); err != nil {
			fail(err)
			return
		}
	}
}

func hdrSampleBuilder(onDrop func()) *samplebuilder.SampleBuilder {
	// A 4K IDR can exceed the usual 128-packet reorder buffer even without
	// packet loss. Bound memory while retaining complete multi-megabyte NALs.
	return samplebuilder.New(8192, &codecs.H265Depacketizer{}, 90000, samplebuilder.WithPacketDroppedHandler(onDrop))
}

func receive(ctx context.Context, track *webrtc.TrackRemote, participant *lksdk.RemoteParticipant, videoStarted *atomic.Bool, fail func(error)) {
	onDrop := func() { participant.WritePLI(track.SSRC()) }
	sb := hdrSampleBuilder(onDrop)
	var lastSampleTS uint32
	hasSample := false
	var bytes uint64
	var packets uint64
	lastReport := time.Now()
	participant.WritePLI(track.SSRC())
	for {
		packet, _, err := track.ReadRTP()
		if err != nil {
			fail(err)
			return
		}
		select {
		case <-ctx.Done():
			return
		default:
		}
		if hasSample && int32(packet.Timestamp-lastSampleTS) > 45000 {
			// Do not let the larger IDR buffer turn a lost fragment into a long
			// playback backlog. Periodic encoder IDRs restore decoder state.
			sb = hdrSampleBuilder(onDrop)
			onDrop()
			hasSample = false
		}
		sb.Push(packet)
		packets++
		for sample, timestamp := sb.PopWithTimestamp(); sample != nil; sample, timestamp = sb.PopWithTimestamp() {
			if _, err := os.Stdout.Write(sample.Data); err != nil {
				fail(err)
				return
			}
			bytes += uint64(len(sample.Data))
			videoStarted.Store(true)
			lastSampleTS = timestamp
			hasSample = true
		}
		if time.Since(lastReport) >= time.Second {
			event("receiving", map[string]any{"bytes": bytes, "packets": packets, "payloadBytes": len(packet.Payload), "marker": packet.Marker})
			lastReport = time.Now()
			// Request fresh parameter sets/IDR periodically for join and packet loss.
			participant.WritePLI(track.SSRC())
		}
	}
}

// The owned encoder inserts AUDs. Preserve VPS/SPS/PPS and HDR SEIs together
// with their picture; publishing only VCL NALs loses decoder/color information.
func readAccessUnits(in io.Reader, write func([]byte) error) error {
	reader, err := h265reader.NewReaderWithOptions(in, h265reader.WithIncludeSEI(true))
	if err != nil {
		return err
	}
	var unit []byte
	hasPicture := false
	flush := func() error {
		if !hasPicture {
			return errors.New("HEVC access unit has no picture")
		}
		if err := write(unit); err != nil {
			return err
		}
		unit = nil
		hasPicture = false
		return nil
	}
	for {
		nal, err := reader.NextNAL()
		if err == io.EOF {
			if hasPicture {
				return flush()
			}
			return io.EOF
		}
		if err != nil {
			return err
		}
		kind := uint8(nal.NalUnitType)
		if kind == 35 && hasPicture {
			if err := flush(); err != nil {
				return err
			}
		}
		if len(unit)+len(nal.Data)+4 > 16*1024*1024 {
			return errors.New("HEVC access unit exceeds limit")
		}
		unit = append(unit, 0, 0, 0, 1)
		unit = append(unit, nal.Data...)
		if kind < 32 {
			hasPicture = true
		}
	}
}
