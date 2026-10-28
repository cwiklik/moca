package guestagent

import (
	"io"
	"net"
	"path/filepath"
	"testing"
	"time"

	"github.com/rossoctl/moca/remote-worker/internal/shortdir"
)

// These cases exercise the address-parsing and unix: paths that are shared, byte for
// byte, between listen_linux.go and listen_other.go — so they run and mean the same
// thing on every platform this repo tests on, unlike the vsock-specific behaviour
// covered in listen_linux_test.go.

func TestListenRequiresSchemeColon(t *testing.T) {
	if _, err := Listen("noschemehere"); err == nil {
		t.Fatal("Listen(\"noschemehere\") = nil error, want an error for a missing scheme")
	}
}

func TestListenUnsupportedSchemeIsError(t *testing.T) {
	if _, err := Listen("http:80"); err == nil {
		t.Fatal("Listen(\"http:80\") = nil error, want an error for an unsupported scheme")
	}
}

// TestListenUnixRoundTrip drives the unix: scheme through a real Listen/Accept/dial,
// so it is a genuine round trip rather than a check that Listen merely returns
// without error.
func TestListenUnixRoundTrip(t *testing.T) {
	// t.TempDir()'s path is well past the ~104-byte sun_path limit AF_UNIX enforces
	// on darwin (and on some Linux libc/kernel combos), so this asks shortdir for a
	// dir with room for "/s.sock" under it — TMPDIR when that fits, /tmp otherwise.
	// Long enough to be unique, short enough that the bind itself is what the test
	// exercises, not the platform's path limit.
	dir := shortdir.New(t, "sh-ga-", len("/s.sock"))
	sockPath := filepath.Join(dir, "s.sock")
	ln, err := Listen("unix:" + sockPath)
	if err != nil {
		t.Fatalf("Listen(unix:%s): %v", sockPath, err)
	}
	defer ln.Close()

	const msg = "hello over unix socket"
	acceptErrCh := make(chan error, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			acceptErrCh <- err
			return
		}
		defer conn.Close()
		if _, err := conn.Write([]byte(msg)); err != nil {
			acceptErrCh <- err
			return
		}
		acceptErrCh <- nil
	}()

	dialer := net.Dialer{Timeout: 5 * time.Second}
	client, err := dialer.Dial("unix", sockPath)
	if err != nil {
		t.Fatalf("dial %s: %v", sockPath, err)
	}
	defer client.Close()

	buf := make([]byte, len(msg))
	if _, err := io.ReadFull(client, buf); err != nil {
		t.Fatalf("client read: %v", err)
	}
	if string(buf) != msg {
		t.Fatalf("client got %q, want %q", buf, msg)
	}
	if err := <-acceptErrCh; err != nil {
		t.Fatalf("Accept/Write side: %v", err)
	}
}
