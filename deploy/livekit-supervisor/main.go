package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

const interval = 30 * time.Second
const window = 10 * time.Minute

type serviceState struct {
	Generation string `json:"generation"`
	Status string `json:"status"`
	StartedAt int64 `json:"startedAt"`
	DeadlineAt int64 `json:"deadlineAt"`
	UpdatedAt int64 `json:"updatedAt"`
	AdoptedIP string `json:"adoptedIP,omitempty"`
	Restarts []int64 `json:"restarts,omitempty"`
}

type child struct {
	cmd *exec.Cmd
	done chan error
	ip chan string
}

type startupLog struct {
	destination io.Writer
	ip chan string
	pending string
}

func (writer *startupLog) Write(data []byte) (int, error) {
	count, err := writer.destination.Write(data)
	writer.pending += string(data)
	for {
		end := strings.IndexByte(writer.pending, '\n')
		if end < 0 { break }
		line := writer.pending[:end]
		writer.pending = writer.pending[end+1:]
		if strings.Contains(line, "starting LiveKit server") {
			if start := strings.IndexByte(line, '{'); start >= 0 {
				var fields struct { IP string `json:"nodeIP"` }
				if json.Unmarshal([]byte(strings.TrimSpace(line[start:])), &fields) == nil {
					select { case writer.ip <- fields.IP: default: }
				}
			}
		}
	}
	if len(writer.pending) > 1024*1024 { writer.pending = "" }
	return count, err
}

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" { return value }
	return fallback
}

func newGeneration() string {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil { panic(err) }
	return hex.EncodeToString(bytes[:])
}

func writeState(path string, state serviceState) error {
	if path == "" { return nil }
	state.UpdatedAt = time.Now().UnixMilli()
	data, err := json.Marshal(state)
	if err != nil { return err }
	if err = os.MkdirAll(filepath.Dir(path), 0755); err != nil { return err }
	tmp, err := os.CreateTemp(filepath.Dir(path), ".state-*")
	if err != nil { return err }
	defer os.Remove(tmp.Name())
	if err = tmp.Chmod(0644); err == nil { _, err = tmp.Write(data) }
	if err == nil { err = tmp.Sync() }
	closeErr := tmp.Close()
	if err != nil { return err }
	if closeErr != nil { return closeErr }
	return os.Rename(tmp.Name(), path)
}

func validPublicIPv4(value string) bool {
	value = strings.TrimSpace(value)
	if strings.Contains(value, ":") { return false }
	ip := net.ParseIP(value)
	if ip == nil || ip.To4() == nil || !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() { return false }
	for _, cidr := range []string{"100.64.0.0/10", "169.254.0.0/16", "192.0.0.0/24", "192.0.2.0/24", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "240.0.0.0/4"} {
		_, block, _ := net.ParseCIDR(cidr)
		if block.Contains(ip) { return false }
	}
	return true
}

func probeIP(ctx context.Context, sources []string) (string, error) {
	if len(sources) < 2 { return "", errors.New("two IPv4 probe sources are required") }
	dialer := &net.Dialer{Timeout: 5 * time.Second}
	transport := &http.Transport{DialContext: func(ctx context.Context, _, address string) (net.Conn, error) {
		return dialer.DialContext(ctx, "tcp4", address)
	}}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 8 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	var agreed string
	for _, source := range sources {
		parsed, err := url.Parse(strings.TrimSpace(source))
		if err != nil || parsed.Scheme != "https" || parsed.User != nil { return "", errors.New("IP probes require HTTPS") }
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String(), nil)
		if err != nil { return "", err }
		response, err := client.Do(req)
		if err != nil { return "", err }
		data, readErr := io.ReadAll(io.LimitReader(response.Body, 128))
		response.Body.Close()
		ip := strings.TrimSpace(string(data))
		if readErr != nil || response.StatusCode != 200 || !validPublicIPv4(ip) { return "", errors.New("invalid IPv4 probe response") }
		if agreed != "" && agreed != ip { return "", errors.New("IPv4 probes disagree") }
		agreed = ip
	}
	return agreed, nil
}

func startChild(args []string) (*child, error) {
	cmd := exec.Command("/livekit-server", args...)
	// Stop the whole child process group, never the supervisor.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	process := &child{cmd: cmd, done: make(chan error, 1), ip: make(chan string, 1)}
	cmd.Stdout = &startupLog{destination: os.Stdout, ip: process.ip}
	cmd.Stderr = &startupLog{destination: os.Stderr, ip: process.ip}
	if err := cmd.Start(); err != nil { return nil, err }
	go func() { process.done <- cmd.Wait() }()
	return process, nil
}

func stopChild(process *child) {
	_ = syscall.Kill(-process.cmd.Process.Pid, syscall.SIGTERM)
	select {
	case <-process.done:
	case <-time.After(10 * time.Second):
		_ = syscall.Kill(-process.cmd.Process.Pid, syscall.SIGKILL)
		<-process.done
	}
}

func health(ctx context.Context, address string) bool {
	ctx, cancel := context.WithTimeout(ctx, 3 * time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, address, nil)
	if err != nil { return false }
	response, err := http.DefaultClient.Do(req)
	if err != nil { return false }
	response.Body.Close()
	return response.StatusCode == http.StatusOK
}

func domainsReady(ctx context.Context, domains []string, ip string) bool {
	for _, domain := range domains {
		domain = strings.TrimSpace(domain)
		if domain == "" { continue }
		if !strings.Contains(domain, "://") { domain = "https://" + domain }
		parsed, err := url.Parse(domain)
		if err != nil || parsed.Hostname() == "" { return false }
		domain = parsed.Hostname()
		ctx, cancel := context.WithTimeout(ctx, 5 * time.Second)
		addresses, err := net.DefaultResolver.LookupIP(ctx, "ip4", domain)
		cancel()
		if err != nil || len(addresses) == 0 { return false }
		for _, address := range addresses {
			if address.String() != ip { return false }
		}
	}
	return true
}

func beginRecovery(state *serviceState, now time.Time) {
	if state.Status != "ready" { return }
	state.Generation, state.Status = newGeneration(), "recovering"
	state.StartedAt, state.DeadlineAt = now.UnixMilli(), now.Add(window).UnixMilli()
}

func restartAllowed(state *serviceState, now time.Time) bool {
	filtered := state.Restarts[:0]
	for _, restart := range state.Restarts {
		if now.UnixMilli()-restart < window.Milliseconds() { filtered = append(filtered, restart) }
	}
	state.Restarts = filtered
	return len(state.Restarts) < 3 && (len(state.Restarts) == 0 ||
		now.UnixMilli()-state.Restarts[len(state.Restarts)-1] >= 120_000)
}

func run() error {
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	process, err := startChild(os.Args[1:])
	if err != nil { return err }
	defer func() { if process != nil { stopChild(process) } }()
	path := env("LIVEKIT_RECOVERY_STATE_PATH", "/run/backspace-voice/state.json")
	sources := strings.Split(env("LIVEKIT_IP_PROBE_URLS", "https://api4.ipify.org,https://ipv4.icanhazip.com"), ",")
	domains := strings.Split(env("LIVEKIT_DDNS_DOMAINS", strings.Join([]string{
		os.Getenv("DOMAIN"), os.Getenv("LIVEKIT_URL"), os.Getenv("LIVEKIT_TURN_DOMAIN"),
	}, ",")), ",")
	now := time.Now()
	state := serviceState{Generation: newGeneration(), Status: "recovering",
		StartedAt: now.UnixMilli(), DeadlineAt: now.Add(window).UnixMilli()}
	// Keep an unfinished outage bounded even across container restarts.
	if data, err := os.ReadFile(path); err == nil {
		var previous serviceState
		if json.Unmarshal(data, &previous) == nil {
			state.Restarts = previous.Restarts
			if previous.Status != "ready" && previous.StartedAt > 0 {
				state = previous
			}
		}
	}
	publish := func() error { return writeState(path, state) }
	if state.DeadlineAt <= now.UnixMilli() { state.Status = "failed" }
	if err := publish(); err != nil { return err }
	var advertised, candidate string
	var confirmations int
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done(): return nil
		case err := <-process.done:
			process = nil
			if ctx.Err() != nil { return nil }
			return fmt.Errorf("LiveKit exited unexpectedly: %v", err)
		case advertised = <-process.ip:
			log.Printf("LiveKit advertised nodeIP=%s", advertised)
		case <-ticker.C:
			ip, err := probeIP(ctx, sources)
			if err != nil {
				candidate, confirmations = "", 0
				log.Printf("public IPv4 probe failed: %v", err)
				if state.Status != "ready" && time.Now().UnixMilli() >= state.DeadlineAt { state.Status = "failed" }
				if err := publish(); err != nil { return err }
				continue
			}
			if ctx.Err() != nil { return nil }
			now := time.Now()
			if state.Status != "ready" && now.UnixMilli() >= state.DeadlineAt {
				state.Status = "failed"
			}
			if advertised == "" {
				log.Print("waiting for LiveKit startup nodeIP; not restarting without an advertised address")
				if err := publish(); err != nil { return err }
				continue
			}
			if advertised == ip {
				candidate, confirmations = "", 0
				if !health(ctx, env("LIVEKIT_LOCAL_HEALTH_URL", "http://127.0.0.1:7880/")) {
					log.Print("LiveKit health check failed; IPv4 is unchanged")
					beginRecovery(&state, now)
					if err := publish(); err != nil { return err }
					continue
				}
				state.AdoptedIP = ip
				if domainsReady(ctx, domains, ip) {
					state.Status = "ready"
				} else { beginRecovery(&state, now) }
				if err := publish(); err != nil { return err }
				continue
			}
			if candidate == ip { confirmations++ } else { candidate, confirmations = ip, 1 }
			if confirmations < 2 {
				if err := publish(); err != nil { return err }
				continue
			}
			beginRecovery(&state, now)
			if !restartAllowed(&state, now) {
				log.Print("IP recovery restart rate limit reached")
				if err := publish(); err != nil { return err }
				continue
			}
			state.Restarts = append(state.Restarts, now.UnixMilli())
			if err := publish(); err != nil { return err }
			log.Printf("public IPv4 changed; refreshing LiveKit nodeIP to %s", ip)
			stopChild(process)
			process = nil
			if ctx.Err() != nil { return nil }
			process, err = startChild(os.Args[1:])
			if err != nil { return err }
			advertised, candidate, confirmations = "", "", 0
		}
	}
}

func main() {
	if err := run(); err != nil { log.Print(err); os.Exit(1) }
}
