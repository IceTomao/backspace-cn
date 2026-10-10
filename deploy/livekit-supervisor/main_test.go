package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestStartupLogAcrossChunks(t *testing.T) {
	var output bytes.Buffer
	ip := make(chan string, 1)
	writer := &startupLog{destination: &output, ip: ip}
	writer.Write([]byte("INFO starting LiveKit server {\"node"))
	writer.Write([]byte("IP\":\"183.23.161.151\"}\n"))
	select {
	case result := <-ip:
		if result != "183.23.161.151" { t.Fatalf("wrong nodeIP: %s", result) }
	default: t.Fatal("startup address was not parsed")
	}
	if output.String() != "INFO starting LiveKit server {\"nodeIP\":\"183.23.161.151\"}\n" { t.Fatal("log was altered") }
}

func TestPublicIPv4(t *testing.T) {
	for _, value := range []string{"", "example.com", "::1", "::ffff:183.23.161.151", "127.0.0.1", "10.0.0.51", "172.21.0.1", "100.64.1.2", "198.18.0.1", "192.0.2.1", "224.0.0.1", "240.1.1.1"} {
		if validPublicIPv4(value) { t.Errorf("accepted non-public address %q", value) }
	}
	if !validPublicIPv4("183.23.161.151") { t.Fatal("rejected public IPv4") }
}

func TestStateReplacement(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	state := serviceState{Generation: "first", Status: "recovering", DeadlineAt: 100}
	if err := writeState(path, state); err != nil { t.Fatal(err) }
	state.Generation, state.Status = "second", "ready"
	if err := writeState(path, state); err != nil { t.Fatal(err) }
	data, err := os.ReadFile(path)
	if err != nil { t.Fatal(err) }
	var result serviceState
	if err := json.Unmarshal(data, &result); err != nil { t.Fatal(err) }
	if result.Generation != "second" || result.Status != "ready" || result.UpdatedAt == 0 {
		t.Fatalf("unexpected state: %+v", result)
	}
}

func TestRecoveryDeadlineCannotBeRenewed(t *testing.T) {
	now := time.UnixMilli(1_000_000)
	state := serviceState{Status: "ready"}
	beginRecovery(&state, now)
	generation, deadline := state.Generation, state.DeadlineAt
	beginRecovery(&state, now.Add(time.Minute))
	if state.Generation != generation || state.DeadlineAt != deadline { t.Fatal("outage deadline was renewed") }
	state.Status = "failed"
	beginRecovery(&state, now.Add(window))
	if state.Generation != generation || state.DeadlineAt != deadline { t.Fatal("failed outage deadline was renewed") }
}

func TestRestartBudget(t *testing.T) {
	now := time.UnixMilli(1_000_000)
	state := serviceState{Restarts: []int64{now.Add(-window).UnixMilli(), now.Add(-time.Minute).UnixMilli()}}
	if restartAllowed(&state, now) { t.Fatal("allowed restart inside minimum interval") }
	if len(state.Restarts) != 1 { t.Fatal("expired history was not pruned") }
	if !restartAllowed(&state, now.Add(time.Minute)) { t.Fatal("minimum interval did not expire") }
	state.Restarts = []int64{now.Add(-5*time.Minute).UnixMilli(), now.Add(-4*time.Minute).UnixMilli(), now.Add(-2*time.Minute).UnixMilli()}
	if restartAllowed(&state, now) { t.Fatal("allowed fourth restart inside outage window") }
	if !restartAllowed(&state, now.Add(6*time.Minute)) { t.Fatal("restart budget did not recover") }
}
