package main

import (
	"bytes"
	"os"
	"testing"

	"github.com/livekit/protocol/livekit"
	"github.com/livekit/server-sdk-go/v2/pkg/samplebuilder"
	"github.com/pion/rtp"
	"github.com/pion/rtp/codecs"
)

func TestLarge4KPictureSurvivesRTPFragmentation(t *testing.T) {
	frame := append([]byte{0, 0, 0, 1, 38, 1}, bytes.Repeat([]byte{128}, 1024*1024)...)
	packets := (&codecs.H265Payloader{}).Payload(1200, frame)
	if len(packets) < 512 {
		t.Fatal("fixture does not exercise a large fragmented picture")
	}
	sb := hdrSampleBuilder(func() { t.Error("dropped part of an in-order picture") })
	var output []byte
	for index, payload := range packets {
		sb.Push(&rtp.Packet{Header: rtp.Header{Version: 2, SequenceNumber: uint16(index), Timestamp: 1500, Marker: index == len(packets)-1}, Payload: payload})
		for sample := sb.Pop(); sample != nil; sample = sb.Pop() {
			output = append(output, sample.Data...)
		}
	}
	if !bytes.Equal(output, frame) {
		t.Fatalf("lost data in a large picture: %d/%d", len(output), len(frame))
	}
}

func TestSubscriptionIsRestrictedToOwnedHDRVideo(t *testing.T) {
	target := identityPrefix + "alice:publish:session"
	if !matchesPublication(target, target, trackName, livekit.TrackSource_SCREEN_SHARE, "video/H265") {
		t.Fatal("HDR video rejected")
	}
	for _, c := range []struct {
		id, name, mime string
		source         livekit.TrackSource
	}{
		{"alice:Alice", trackName, "video/H265", livekit.TrackSource_SCREEN_SHARE},
		{target, "SDR", "video/H265", livekit.TrackSource_SCREEN_SHARE},
		{target, trackName, "video/VP8", livekit.TrackSource_SCREEN_SHARE},
		{target, trackName, "video/H265", livekit.TrackSource_CAMERA},
		{target, trackName, "audio/opus", livekit.TrackSource_SCREEN_SHARE_AUDIO},
	} {
		if matchesPublication(target, c.id, c.name, c.source, c.mime) {
			t.Fatalf("unexpected subscription: %+v", c)
		}
	}
}

func TestNVENCMain10PacketizationPreservesCompletePictures(t *testing.T) {
	fixture, err := os.ReadFile("../hdr-probe.hevc")
	if err != nil {
		t.Fatal(err)
	}
	for _, kind := range []byte{32, 33, 34} {
		if !bytes.Contains(fixture, []byte{0, 0, 1, kind << 1, 1}) {
			t.Fatalf("fixture is missing parameter set %d", kind)
		}
	}
	var frames [][]byte
	if err := readAccessUnits(bytes.NewReader(fixture), func(data []byte) error { frames = append(frames, append([]byte{}, data...)); return nil }); err != nil {
		t.Fatal(err)
	}
	payloader := &codecs.H265Payloader{}
	sb := samplebuilder.New(128, &codecs.H265Depacketizer{}, 90000)
	var sequence uint16
	var output [][]byte
	for index, frame := range frames {
		packets := payloader.Payload(1200, frame)
		for i, payload := range packets {
			sb.Push(&rtp.Packet{Header: rtp.Header{Version: 2, SequenceNumber: sequence, Timestamp: uint32(index * 1500), Marker: i == len(packets)-1}, Payload: payload})
			sequence++
			for sample := sb.Pop(); sample != nil; sample = sb.Pop() {
				if len(sample.Data) > 0 {
					output = append(output, sample.Data)
				}
			}
		}
	}
	if len(output) != len(frames) {
		t.Fatalf("depacketized %d/%d pictures", len(output), len(frames))
	}
}

func TestConfigurationRejectsAmbiguousModesAndInvalidVideo(t *testing.T) {
	valid := configuration{Protocol: 1, Mode: "publish", URL: "wss://voice.example", Token: "secret", FPS: 60, Width: 3840, Height: 2160}
	if err := valid.validate(); err != nil {
		t.Fatal(err)
	}
	for _, mutate := range []func(*configuration){
		func(c *configuration) { c.Protocol = 0 }, func(c *configuration) { c.FPS = 0 },
		func(c *configuration) { c.Width = 3839 }, func(c *configuration) { c.Token = "" },
		func(c *configuration) { c.URL = "https://example.com" }, func(c *configuration) { c.Mode = "camera" },
	} {
		c := valid
		mutate(&c)
		if c.validate() == nil {
			t.Fatal("invalid configuration accepted")
		}
	}
}

func TestHEVCUnitsKeepParameterSetsAndHDRMetadata(t *testing.T) {
	var input []byte
	nal := func(kind byte, value byte) []byte { return []byte{0, 0, 0, 1, kind << 1, 1, value} }
	for _, kind := range []byte{35, 32, 33, 34, 39, 19, 35, 1} {
		input = append(input, nal(kind, 128)...)
	}
	var frames [][]byte
	err := readAccessUnits(bytes.NewReader(input), func(data []byte) error { frames = append(frames, append([]byte{}, data...)); return nil })
	if err != nil {
		t.Fatal(err)
	}
	if len(frames) != 2 {
		t.Fatalf("got %d frames", len(frames))
	}
	for _, kind := range []byte{32, 33, 34, 39, 19} {
		if !bytes.Contains(frames[0], nal(kind, 128)) {
			t.Fatalf("lost NAL %d", kind)
		}
	}
}
