//go:build unix

package main

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/rossoctl/moca/remote-worker/internal/egress/control"
	"github.com/rossoctl/moca/remote-worker/internal/shortdir"
)

func TestBinaryServesAndShutsDown(t *testing.T) {
	bin := filepath.Join(t.TempDir(), "moca-egress")
	if out, err := exec.Command("go", "build", "-o", bin, ".").CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, out)
	}

	up, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer up.Close()
	port := up.Addr().(*net.TCPAddr).Port
	got := make(chan string, 1)
	go func() {
		c, err := up.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		buf := make([]byte, 5)
		if _, err := io.ReadFull(c, buf); err != nil {
			return
		}
		got <- string(buf)
		c.Write(buf)
	}()

	dir := shortdir.New(t, "meg", len("/vm.sock"))
	sock := filepath.Join(dir, "c.sock")

	cmd := exec.Command(bin)
	cmd.Env = []string{
		fmt.Sprintf("MOCA_EGRESS_ALLOW=127.0.0.1:%d", port),
		"MOCA_EGRESS_PERMIT_CIDRS=127.0.0.1/32",
		"MOCA_EGRESS_CONTROL_SOCK=" + sock,
		fmt.Sprintf("MOCA_EGRESS_CONTROL_UIDS=%d", os.Getuid()),
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	defer cmd.Process.Kill()

	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := os.Stat(sock); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("control socket never appeared")
		}
		time.Sleep(20 * time.Millisecond)
	}

	vmSock := filepath.Join(dir, "vm.sock")
	ln, err := net.Listen("unix", vmSock)
	if err != nil {
		t.Fatal(err)
	}
	f, err := ln.(*net.UnixListener).File()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := control.NewClient(sock).Register(ctx, "vm-1", "run-a", nil, f); err != nil {
		t.Fatalf("register: %v", err)
	}

	c, err := net.Dial("unix", vmSock)
	if err != nil {
		t.Fatal(err)
	}
	c.SetDeadline(time.Now().Add(5 * time.Second))
	fmt.Fprintf(c, "CONNECT 127.0.0.1:%d HTTP/1.1\r\nHost: 127.0.0.1:%d\r\n\r\n", port, port)
	br := bufio.NewReader(c)
	status, err := br.ReadString('\n')
	if err != nil || !strings.Contains(status, "200") {
		t.Fatalf("status = %q, %v", status, err)
	}
	for {
		l, err := br.ReadString('\n')
		if err != nil {
			t.Fatal(err)
		}
		if l == "\r\n" {
			break
		}
	}
	c.Write([]byte("hello"))
	echo := make([]byte, 5)
	if _, err := io.ReadFull(br, echo); err != nil || string(echo) != "hello" {
		t.Fatalf("echo = %q, %v", echo, err)
	}
	if s := <-got; s != "hello" {
		t.Fatalf("upstream got %q", s)
	}
	c.Close()

	found := make(chan bool, 1)
	go func() {
		sc := bufio.NewScanner(stdout)
		for sc.Scan() {
			if strings.Contains(sc.Text(), `"decision":"tunnel"`) {
				found <- true
				io.Copy(io.Discard, stdout)
				return
			}
		}
		found <- false
	}()
	select {
	case ok := <-found:
		if !ok {
			t.Fatal("no tunnel audit line on stdout")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for tunnel audit line")
	}

	if err := cmd.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-exited:
		if err != nil {
			t.Fatalf("exit: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("did not exit within 2s of SIGTERM")
	}
}
