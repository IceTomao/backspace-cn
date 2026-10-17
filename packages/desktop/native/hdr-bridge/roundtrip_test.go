package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/livekit/protocol/auth"
)

// Opt-in real SFU test. Both peers use the shipping bridge executable, not a
// mocked SDK. No screen capture, public listener, or production credentials.
func TestLiveKitMain10Roundtrip(t *testing.T) {
	serverPath, bridgePath, fixturePath := os.Getenv("HDR_TEST_LIVEKIT"), os.Getenv("HDR_TEST_BRIDGE"), os.Getenv("HDR_TEST_FIXTURE")
	if serverPath == "" || bridgePath == "" || fixturePath == "" {
		t.Skip("set HDR_TEST_LIVEKIT, HDR_TEST_BRIDGE and HDR_TEST_FIXTURE")
	}
	fixture, err := os.ReadFile(fixturePath)
	if err != nil {
		t.Fatal(err)
	}
	port := func() int {
		listener, e := net.Listen("tcp", "127.0.0.1:0")
		if e != nil {
			t.Fatal(e)
		}
		defer listener.Close()
		return listener.Addr().(*net.TCPAddr).Port
	}
	httpPort, tcpPort, udpPort := port(), port(), port()
	udpListener, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	udpPort = udpListener.LocalAddr().(*net.UDPAddr).Port
	_ = udpListener.Close()
	configPath := filepath.Join(t.TempDir(), "livekit.yaml")
	secret := "local-hdr-test-secret-not-a-production-key"
	config := fmt.Sprintf("port: %d\nbind_addresses: [127.0.0.1]\nrtc:\n  tcp_port: %d\n  udp_port: %d\n  node_ip: 127.0.0.1\n  ips:\n    includes: [127.0.0.1/32]\n  use_external_ip: false\n  enable_loopback_candidate: true\nkeys:\n  hdr-test: %s\nroom:\n  enabled_codecs:\n    - mime: video/h265\n    - mime: audio/opus\nlogging:\n  level: info\n", httpPort, tcpPort, udpPort, secret)
	if err := os.WriteFile(configPath, []byte(config), 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	var receivedAudio lockedBuffer
	audioEvent := make(chan bool, 1)
	audioURL := ""
	if ffmpeg := os.Getenv("HDR_TEST_FFMPEG"); ffmpeg != "" {
		audioServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method == "POST" {
				_ = http.NewResponseController(w).EnableFullDuplex()
			}
			w.Header().Set("Content-Type", "audio/ogg")
			w.WriteHeader(200)
			w.(http.Flusher).Flush()
			if r.Method == "GET" {
				cmd := exec.CommandContext(ctx, ffmpeg, "-v", "error", "-re", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-ac", "2", "-c:a", "libopus", "-page_duration", "20000", "-flush_packets", "1", "-f", "ogg", "pipe:1")
				cmd.Stdout = flushWriter{w}
				_ = cmd.Run()
				return
			}
			buffer := make([]byte, 4096)
			for {
				n, err := r.Body.Read(buffer)
				if n > 0 {
					_, _ = receivedAudio.Write(buffer[:n])
					if receivedAudio.Len() > 512 {
						select {
						case audioEvent <- true:
						default:
						}
					}
				}
				if err != nil {
					return
				}
			}
		}))
		t.Cleanup(audioServer.Close)
		audioURL = audioServer.URL + "/" + strings.Repeat("a", 64)
	}
	server := exec.CommandContext(ctx, serverPath, "--config", configPath)
	var serverLog lockedBuffer
	server.Stderr = &serverLog
	server.Stdout = &serverLog
	defer func() {
		if out := os.Getenv("HDR_TEST_OUTPUT"); out != "" {
			_ = os.WriteFile(out+".server.log", serverLog.Bytes(), 0600)
		}
	}()
	if err := server.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = server.Process.Kill(); _ = server.Wait() }()
	address := fmt.Sprintf("127.0.0.1:%d", httpPort)
	for attempts := 0; ; attempts++ {
		conn, err := net.DialTimeout("tcp", address, 100*time.Millisecond)
		if err == nil {
			_ = conn.Close()
			break
		}
		if attempts >= 50 {
			t.Fatalf("local SFU did not start: %s", serverLog.String())
		}
		time.Sleep(100 * time.Millisecond)
	}
	identity := identityPrefix + "alice:publish:00000000-0000-0000-0000-000000000001"
	token := func(id string, publish bool) string {
		jwt, e := auth.NewAccessToken("hdr-test", secret).SetIdentity(id).SetVideoGrant(&auth.VideoGrant{RoomJoin: true, Room: "hdr-test", CanPublish: &publish, CanSubscribe: boolPtr(!publish)}).ToJWT()
		if e != nil {
			t.Fatal(e)
		}
		return jwt
	}
	start := func(cfg configuration) (*exec.Cmd, *bufio.Scanner, *lockedBuffer, interface {
		Write([]byte) (int, error)
		Close() error
	}) {
		cmd := exec.CommandContext(ctx, bridgePath)
		input, e := cmd.StdinPipe()
		if e != nil {
			t.Fatal(e)
		}
		stderr, e := cmd.StderrPipe()
		if e != nil {
			t.Fatal(e)
		}
		output := &lockedBuffer{}
		cmd.Stdout = output
		if e := cmd.Start(); e != nil {
			t.Fatal(e)
		}
		t.Cleanup(func() { _ = input.Close(); _ = cmd.Process.Kill(); _ = cmd.Wait() })
		if e := json.NewEncoder(input).Encode(cfg); e != nil {
			t.Fatal(e)
		}
		return cmd, bufio.NewScanner(stderr), output, input
	}
	url := "ws://" + address
	_, recvEvents, received, _ := start(configuration{Protocol: 1, Mode: "receive", URL: url, Token: token(identityPrefix+"bob:receive:session", false), Publisher: identity, AudioURL: audioURL})
	receivedEvent := make(chan bool, 1)
	var recvLog, pubLog lockedBuffer
	go func() {
		for recvEvents.Scan() {
			_, _ = recvLog.Write(append(append([]byte{}, recvEvents.Bytes()...), '\n'))
			var event struct {
				Type  string `json:"type"`
				Bytes uint64 `json:"bytes"`
			}
			_ = json.Unmarshal(recvEvents.Bytes(), &event)
			if event.Type == "receiving" && event.Bytes > 0 {
				select {
				case receivedEvent <- true:
				default:
				}
			}
		}
	}()
	_, pubEvents, _, input := start(configuration{Protocol: 1, Mode: "publish", URL: url, Token: token(identity, true), FPS: 60, Width: 256, Height: 128, AudioURL: audioURL})
	go func() {
		for pubEvents.Scan() {
			_, _ = pubLog.Write(append(append([]byte{}, pubEvents.Bytes()...), '\n'))
		}
	}()
	var frames [][]byte
	if err := readAccessUnits(bytes.NewReader(fixture), func(frame []byte) error { frames = append(frames, append([]byte{}, frame...)); return nil }); err != nil {
		t.Fatal(err)
	}
	if len(frames) < 2 {
		t.Fatal("fixture requires at least two pictures")
	}
	go func() {
		for n := 0; ; n++ {
			select {
			case <-ctx.Done():
				return
			default:
			}
			if _, err := input.Write(frames[n%len(frames)]); err != nil {
				return
			}
			time.Sleep(time.Second / 60)
		}
	}()
	select {
	case <-receivedEvent:
	case <-ctx.Done():
		t.Fatalf("no HDR video crossed the real SFU: %s\npublisher:%s\nreceiver:%s", serverLog.String(), pubLog.String(), recvLog.String())
	}
	if audioURL != "" {
		select {
		case <-audioEvent:
		case <-ctx.Done():
			t.Fatalf("no Opus audio crossed the real SFU: %s\n%s", pubLog.String(), recvLog.String())
		}
	}
	// Kill/Wait before inspecting the output to avoid racing stdout's writer.
	cancel()
	time.Sleep(100 * time.Millisecond)
	if received.Len() == 0 {
		t.Fatal("no encoded output")
	}
	out := os.Getenv("HDR_TEST_OUTPUT")
	if out != "" {
		if err := os.WriteFile(out, received.Bytes(), 0600); err != nil {
			t.Fatal(err)
		}
		if audioURL != "" {
			if err := os.WriteFile(out+".ogg", receivedAudio.Bytes(), 0600); err != nil {
				t.Fatal(err)
			}
		}
	}
}

type flushWriter struct{ http.ResponseWriter }

func (w flushWriter) Write(data []byte) (int, error) {
	n, err := w.ResponseWriter.Write(data)
	w.ResponseWriter.(http.Flusher).Flush()
	return n, err
}

func boolPtr(value bool) *bool { return &value }

type lockedBuffer struct {
	mu     sync.Mutex
	buffer bytes.Buffer
}

func (b *lockedBuffer) Write(data []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buffer.Write(data)
}
func (b *lockedBuffer) Len() int { b.mu.Lock(); defer b.mu.Unlock(); return b.buffer.Len() }
func (b *lockedBuffer) Bytes() []byte {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]byte{}, b.buffer.Bytes()...)
}
func (b *lockedBuffer) String() string { return string(b.Bytes()) }
