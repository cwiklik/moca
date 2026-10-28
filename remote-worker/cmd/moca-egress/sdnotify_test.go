//go:build unix

package main

import (
	"net"
	"path/filepath"
	"testing"
	"time"

	"github.com/rossoctl/moca/remote-worker/internal/shortdir"
)

func TestSdNotifyIsANoOpWithoutNotifySocket(t *testing.T) {
	t.Setenv("NOTIFY_SOCKET", "")
	if err := sdNotify("READY=1"); err != nil {
		t.Fatalf("sdNotify without NOTIFY_SOCKET: %v", err)
	}
}

func TestSdNotifySendsTheStateDatagram(t *testing.T) {
	dir := shortdir.New(t, "sdn", len("/notify"))
	path := filepath.Join(dir, "notify")
	ln, err := net.ListenUnixgram("unixgram", &net.UnixAddr{Name: path, Net: "unixgram"})
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	t.Setenv("NOTIFY_SOCKET", path)
	if err := sdNotify("READY=1"); err != nil {
		t.Fatalf("sdNotify: %v", err)
	}
	_ = ln.SetReadDeadline(time.Now().Add(2 * time.Second))
	buf := make([]byte, 64)
	n, err := ln.Read(buf)
	if err != nil || string(buf[:n]) != "READY=1" {
		t.Fatalf("notify socket got %q, %v", buf[:n], err)
	}
}
