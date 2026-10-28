package guestagent

import (
	"errors"
	"io"
	"net"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rossoctl/moca/remote-worker/internal/shortdir"
)

// startForwarder serves a forwarder on tcp 127.0.0.1:0 using the given Dial and
// returns its address and a channel that receives Serve's result.
func startForwarder(t *testing.T, dial func() (net.Conn, error)) (addr string, done chan error) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	// `t.Logf` must not be called once the test has returned: the race detector flags it as a
	// write/read on testing.common, and the testing package itself panics on it. Closing the
	// listener stops Serve, but an in-flight `handle` goroutine can still be mid-request and log
	// after that. So the logger is gated -- Cleanup flips it off under the mutex before the test
	// ends, and a later line is dropped rather than written to a finished *testing.T.
	var mu sync.Mutex
	live := true
	t.Cleanup(func() {
		mu.Lock()
		live = false
		mu.Unlock()
	})
	logf := func(format string, a ...any) {
		mu.Lock()
		defer mu.Unlock()
		if !live {
			return
		}
		t.Logf(format, a...)
	}
	f := &EgressForwarder{Dial: dial, Logf: logf}
	done = make(chan error, 1)
	go func() { done <- f.Serve(ln) }()
	// Registered after the gate above, so it runs BEFORE it (Cleanup is LIFO): the listener closes
	// and Serve returns first, and only then does logging stop.
	t.Cleanup(func() { ln.Close() })
	return ln.Addr().String(), done
}

func unixUpstream(t *testing.T) (net.Listener, func() (net.Conn, error)) {
	t.Helper()
	dir := shortdir.New(t, "gfwd", len("/u.sock"))
	path := filepath.Join(dir, "u.sock")
	ul, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ul.Close() })
	return ul, func() (net.Conn, error) { return net.Dial("unix", path) }
}

func echoServer(ul net.Listener) {
	for {
		c, err := ul.Accept()
		if err != nil {
			return
		}
		go func() { defer c.Close(); io.Copy(c, c) }()
	}
}

func TestForwarderSplicesBothWays(t *testing.T) {
	ul, dial := unixUpstream(t)
	go echoServer(ul)
	addr, _ := startForwarder(t, dial)
	c, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(2 * time.Second))
	if _, err := c.Write([]byte("ping")); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 4)
	if _, err := io.ReadFull(c, buf); err != nil || string(buf) != "ping" {
		t.Fatalf("got %q, %v", buf, err)
	}
}

func TestForwarderAnswers502WhenTheHostSideRefuses(t *testing.T) {
	addr, _ := startForwarder(t, func() (net.Conn, error) { return nil, errors.New("connection reset") })
	c, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(time.Second))
	c.Write([]byte("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n"))
	b, err := io.ReadAll(c)
	if err != nil {
		t.Fatalf("read: %v (got %q)", err, b)
	}
	s := string(b)
	for _, want := range []string{
		"HTTP/1.1 502 Bad Gateway\r\n",
		"X-Moca-Egress-Error: egress_unreachable\r\n",
		"Content-Type: text/plain\r\n",
		"Connection: close\r\n",
		"Content-Length: 37\r\n",
		"\r\n\r\negress_unreachable: connection reset\n",
	} {
		if !strings.Contains(s, want) {
			t.Errorf("response missing %q:\n%q", want, s)
		}
	}
	if !strings.HasPrefix(s, "HTTP/1.1 502 Bad Gateway\r\n") {
		t.Errorf("bad status line: %q", s)
	}
}

func TestForwarderPropagatesHalfClose(t *testing.T) {
	ul, dial := unixUpstream(t)
	go func() {
		c, err := ul.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		b, _ := io.ReadAll(c) // only returns on EOF
		if string(b) == "req" {
			c.Write([]byte("resp"))
		}
	}()
	addr, _ := startForwarder(t, dial)
	c, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(2 * time.Second))
	c.Write([]byte("req"))
	c.(*net.TCPConn).CloseWrite()
	b, err := io.ReadAll(c)
	if err != nil || string(b) != "resp" {
		t.Fatalf("got %q, %v", b, err)
	}
}

func TestForwarderClosesClientWhenUpstreamDiesMidStream(t *testing.T) {
	ul, dial := unixUpstream(t)
	go func() {
		c, err := ul.Accept()
		if err != nil {
			return
		}
		c.Write([]byte("a"))
		c.Close()
	}()
	addr, _ := startForwarder(t, dial)
	c, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(time.Second))
	b, err := io.ReadAll(c)
	if err != nil || string(b) != "a" {
		t.Fatalf("got %q, %v", b, err)
	}
}

func TestForwarderSurvivesManyConcurrentConnections(t *testing.T) {
	ul, dial := unixUpstream(t)
	go echoServer(ul)
	addr, done := startForwarder(t, dial)
	var wg sync.WaitGroup
	for i := 0; i < 64; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c, err := net.Dial("tcp", addr)
			if err != nil {
				t.Error(err)
				return
			}
			defer c.Close()
			c.SetDeadline(time.Now().Add(5 * time.Second))
			c.Write([]byte("hello"))
			buf := make([]byte, 5)
			if _, err := io.ReadFull(c, buf); err != nil || string(buf) != "hello" {
				t.Errorf("got %q, %v", buf, err)
			}
		}()
	}
	wg.Wait()
	select {
	case err := <-done:
		t.Fatalf("Serve returned early: %v", err)
	default:
	}
	c, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatalf("not accepting afterwards: %v", err)
	}
	c.Close()
}

type flakyListener struct {
	net.Listener
	once sync.Once
}

func (l *flakyListener) Accept() (net.Conn, error) {
	var injected bool
	l.once.Do(func() { injected = true })
	if injected {
		return nil, errors.New("accept: too many open files")
	}
	return l.Listener.Accept()
}

func TestForwarderKeepsServingAfterATransientAcceptError(t *testing.T) {
	ul, dial := unixUpstream(t)
	go echoServer(ul)
	real, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	f := &EgressForwarder{Dial: dial, Logf: t.Logf}
	done := make(chan error, 1)
	go func() { done <- f.Serve(&flakyListener{Listener: real}) }()
	c, err := net.Dial("tcp", real.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	c.SetDeadline(time.Now().Add(2 * time.Second))
	c.Write([]byte("ok"))
	buf := make([]byte, 2)
	if _, err := io.ReadFull(c, buf); err != nil || string(buf) != "ok" {
		t.Fatalf("got %q, %v", buf, err)
	}
	c.Close()
	real.Close()
	select {
	case err := <-done:
		if !errors.Is(err, net.ErrClosed) {
			t.Fatalf("Serve returned %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Serve did not return after listener close")
	}
}
