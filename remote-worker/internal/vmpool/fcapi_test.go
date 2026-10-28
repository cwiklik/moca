package vmpool

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/rossoctl/moca/remote-worker/internal/shortdir"
)

// shortUnixSocketDir returns a short-lived directory suitable for AF_UNIX socket
// paths. t.TempDir() is unusable for this on macOS: it nests under
// $TMPDIR/TestName.../NNN, and $TMPDIR there is the sandboxed
// "/var/folders/xx/........./T" path, which combined with a descriptive test name
// routinely exceeds sockaddr_un's sun_path limit (104 bytes on Darwin, 108 on Linux) —
// bind then fails with "invalid argument", not a clear "path too long". shortdir
// measures the directory it creates against the "/fc.sock" this appends, so what comes
// back has room for it on every platform this runs on.
func shortUnixSocketDir(t *testing.T) string {
	t.Helper()
	dir := shortdir.New(t, "vmpool-", len("/fc.sock"))
	return dir
}

// fakeFirecrackerAPI serves Firecracker's HTTP API on a unix socket and records the
// requests, so the client is tested against the wire shape without KVM.
func fakeFirecrackerAPI(t *testing.T) (sock string, seen *[]string, bodies *[]string) {
	t.Helper()
	sock = filepath.Join(shortUnixSocketDir(t), "fc.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close(); _ = os.Remove(sock) })
	var reqs, bs []string
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		reqs = append(reqs, r.Method+" "+r.URL.Path)
		bs = append(bs, string(b))
		w.WriteHeader(http.StatusNoContent)
	})
	srv := &http.Server{Handler: mux}
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })
	return sock, &reqs, &bs
}

func TestFirecrackerClientLoadsAndResumes(t *testing.T) {
	sock, seen, bodies := fakeFirecrackerAPI(t)
	c := newFCClient(sock)
	if err := c.LoadSnapshot(context.Background(), "/snapshot/vmstate", "/snapshot/memfile"); err != nil {
		t.Fatalf("LoadSnapshot: %v", err)
	}
	if err := c.Resume(context.Background()); err != nil {
		t.Fatalf("Resume: %v", err)
	}
	want := []string{"PUT /snapshot/load", "PATCH /vm"}
	if len(*seen) != 2 || (*seen)[0] != want[0] || (*seen)[1] != want[1] {
		t.Fatalf("requests = %v, want %v", *seen, want)
	}
	var load struct {
		SnapshotPath string `json:"snapshot_path"`
		MemBackend   struct {
			BackendPath string `json:"backend_path"`
			BackendType string `json:"backend_type"`
		} `json:"mem_backend"`
		EnableDiff bool `json:"enable_diff_snapshots"`
		ResumeVM   bool `json:"resume_vm"`
	}
	if err := json.Unmarshal([]byte((*bodies)[0]), &load); err != nil {
		t.Fatalf("load body: %v", err)
	}
	if load.MemBackend.BackendType != "File" {
		t.Errorf("backend_type = %q, want File", load.MemBackend.BackendType)
	}
	// Diff snapshots are developer preview and generally NOT resumable (spec §2.4), so
	// this must never be true — an incremental strategy does not exist for us.
	if load.EnableDiff {
		t.Error("enable_diff_snapshots must be false: diff snapshots are not resumable")
	}
	// Restore then PAUSE. A paused VM takes zero CPU, which is what lets thousands of
	// standbys exist without burning cores on timer ticks (spec §3.2) — and resuming at
	// load time would make every standby a running VM.
	if load.ResumeVM {
		t.Error("resume_vm must be false: standbys are paused, not running (spec §3.2)")
	}
}

// TestLoadSnapshotSerializesVsockOverrideAsObject asserts on the ACTUAL SERIALIZED
// JSON of the /snapshot/load request body, not on the Go struct: Firecracker
// v1.17.0 rejects a bare-string vsock_override ("invalid type: string ..., expected
// struct VsockOverride") and only accepts an object with a uds_path member. A test
// that decoded into a Go struct with a `string` field would pass whether the wire
// value were a string or an object, and would not have caught this bug.
func TestLoadSnapshotSerializesVsockOverrideAsObject(t *testing.T) {
	sock, _, bodies := fakeFirecrackerAPI(t)
	c := newFCClient(sock)
	c.setVsockOverride("/run/v.sock")
	if err := c.LoadSnapshot(context.Background(), "/snapshot/vmstate", "/snapshot/memfile"); err != nil {
		t.Fatalf("LoadSnapshot: %v", err)
	}

	var raw map[string]any
	if err := json.Unmarshal([]byte((*bodies)[0]), &raw); err != nil {
		t.Fatalf("decode request body: %v", err)
	}
	got, ok := raw["vsock_override"]
	if !ok {
		t.Fatal("vsock_override is absent from the request body, but an override was set")
	}
	obj, ok := got.(map[string]any)
	if !ok {
		t.Fatalf("vsock_override = %#v (a %T), want a JSON object — Firecracker v1.17.0 "+
			"rejects a bare string with \"invalid type: string ..., expected struct VsockOverride\"",
			got, got)
	}
	if len(obj) != 1 {
		t.Fatalf("vsock_override object = %v, want exactly one member (uds_path)", obj)
	}
	if udsPath, _ := obj["uds_path"].(string); udsPath != "/run/v.sock" {
		t.Fatalf("vsock_override.uds_path = %v, want \"/run/v.sock\"", obj["uds_path"])
	}
}

// TestLoadSnapshotOmitsVsockOverrideWhenUnset asserts the vsock_override key is
// entirely absent from the request body when no override was set. Firecracker
// accepts an absent field but rejects an empty object ({}) with "missing field
// `uds_path`", so {} would be just as wrong as a bare string here.
func TestLoadSnapshotOmitsVsockOverrideWhenUnset(t *testing.T) {
	sock, _, bodies := fakeFirecrackerAPI(t)
	c := newFCClient(sock) // vsockOverride deliberately left unset

	if err := c.LoadSnapshot(context.Background(), "/snapshot/vmstate", "/snapshot/memfile"); err != nil {
		t.Fatalf("LoadSnapshot: %v", err)
	}

	var raw map[string]any
	if err := json.Unmarshal([]byte((*bodies)[0]), &raw); err != nil {
		t.Fatalf("decode request body: %v", err)
	}
	if v, present := raw["vsock_override"]; present {
		t.Fatalf("vsock_override = %v, want the key entirely absent when no override is set", v)
	}
}

func TestFirecrackerClientSurfacesAnAPIError(t *testing.T) {
	sock := filepath.Join(shortUnixSocketDir(t), "fc.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"fault_message":"Load snapshot error: Snapshot file is invalid"}`))
	})}
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })

	err = newFCClient(sock).LoadSnapshot(context.Background(), "/x", "/y")
	if err == nil {
		t.Fatal("LoadSnapshot ignored a 400")
	}
	// The fault message must survive: "restore failed" without it is undiagnosable, and
	// spec §6 treats a CRC failure as FATAL FOR THE HOST — a decision that needs the
	// VMM's own reason.
	if !strings.Contains(err.Error(), "Snapshot file is invalid") {
		t.Fatalf("err = %v, want the fault_message preserved", err)
	}
}
