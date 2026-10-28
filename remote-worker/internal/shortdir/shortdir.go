// Package shortdir makes the temporary directories that hold Unix sockets in tests.
//
// It exists because of a conflict between two constraints. A Unix socket path is bounded by
// sockaddr_un.sun_path -- 104 bytes on macOS, 108 on Linux -- and `bind` fails with EINVAL (or
// silently truncates) past it, so these directories have to be SHORT. But hardcoding "/tmp", as
// these tests used to, fails outright wherever /tmp is not writable: a sandboxed or hardened
// environment, a CI image that points TMPDIR elsewhere, or a user without write access to /tmp.
// `go test` itself honours TMPDIR, so hardcoding /tmp also meant the Go tests ignored the one knob
// everything else in the repo respects.
//
// So: prefer TMPDIR when a directory under it still leaves room for the caller's own socket path,
// and fall back to /tmp or the operating system's default otherwise. Either way the caller gets a
// directory it can put a socket in, or an error that says why not.
//
// The room a caller needs is the caller's to state, because it varies by two orders of magnitude
// across this suite: "/c.sock" is 7 bytes, while the Firecracker collision test binds at
// "/firecracker/vm-6/root/run/firecracker.socket", 45. A single built-in allowance cannot be right
// for both -- too small and a long TMPDIR is accepted that cannot hold the socket, too large and a
// perfectly usable TMPDIR is rejected -- so New and Make take `need` and measure the directory they
// actually created against it.
package shortdir

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// MaxSocketPath is the smaller of the two platform limits for sockaddr_un.sun_path, so a path that
// fits here fits everywhere this code runs. The real limit is 104 on macOS and 108 on Linux.
const MaxSocketPath = 104

// New returns a directory for a test's Unix sockets, removed when the test ends.
//
// need is how many bytes the caller will append to the returned directory for its longest socket
// path, separator included -- normally written as a len() of the literal suffix, so it cannot drift
// from the path the test actually binds:
//
//	dir := shortdir.New(t, "fcguard", len("/firecracker/vm-6/root/run/firecracker.socket"))
//
// It tries each candidate in turn and takes the first where the directory it creates is short
// enough AND writable, so a read-only /tmp or an over-long TMPDIR costs a fallback rather than a
// failure. If none works the test fails naming every candidate and why, which is the information
// needed to fix the environment -- far better than `bind` failing later with a bare EINVAL.
func New(t *testing.T, prefix string, need int) string {
	t.Helper()
	dir, err := Make(prefix, need)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return dir
}

// Make is New without the testing dependency, for the conformance harness and anything else that
// is not a test. The caller owns the cleanup.
func Make(prefix string, need int) (string, error) {
	var tried []string
	for _, base := range candidates() {
		// The length that matters is the one of the directory that actually exists: MkdirTemp's
		// random suffix is up to 10 digits and the prefix is the caller's, so neither the base
		// alone nor any fixed allowance for them predicts it. Create first, measure the real
		// thing, and give the directory back if it does not fit.
		dir, err := os.MkdirTemp(base, prefix)
		if err != nil {
			tried = append(tried, fmt.Sprintf("%s (%v)", base, err))
			continue
		}
		if len(dir)+need > MaxSocketPath {
			_ = os.RemoveAll(dir)
			tried = append(tried, fmt.Sprintf(
				"%s (%s is %d bytes, %d with the caller's %d-byte socket name, over the %d limit)",
				base, dir, len(dir), len(dir)+need, need, MaxSocketPath,
			))
			continue
		}
		return dir, nil
	}
	return "", fmt.Errorf(
		"shortdir: no directory both writable and short enough to hold a %d-byte socket name under "+
			"it (sun_path limit %d); tried: %s",
		need, MaxSocketPath, strings.Join(tried, "; "),
	)
}

// candidates lists the parent directories to try, in order of preference: TMPDIR first, because it
// is the knob the rest of the repo honours and the one a sandbox sets; then /tmp, which is short
// and usually writable; then the Go default, which is TMPDIR-or-/tmp but may differ on platforms
// where neither applies. Duplicates and empties are dropped so the error message lists each place
// once.
func candidates() []string {
	var out []string
	seen := map[string]bool{}
	for _, d := range []string{os.Getenv("TMPDIR"), "/tmp", os.TempDir()} {
		if d == "" {
			continue
		}
		// MkdirTemp joins without adding a separator, so a trailing slash would double it in the
		// path and in the length check.
		d = filepath.Clean(d)
		if seen[d] {
			continue
		}
		seen[d] = true
		out = append(out, d)
	}
	return out
}
