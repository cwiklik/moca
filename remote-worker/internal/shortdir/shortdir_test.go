package shortdir

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// need stands in for a caller's socket name in the tests that do not care about a specific one.
// The real callers pass len() of their own suffix.
const need = len("/control.sock")

func TestNewHonoursTmpdirWhenItIsShortEnough(t *testing.T) {
	// A real, short TMPDIR: the directory must land under it, not under the OS default.
	tmp, err := os.MkdirTemp("", "sd")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(tmp) })
	t.Setenv("TMPDIR", tmp)
	got := New(t, "x", need)
	if !strings.HasPrefix(got, filepath.Clean(tmp)) {
		t.Fatalf("New ignored TMPDIR: got %q, want a child of %q", got, tmp)
	}
	if _, err := os.Stat(got); err != nil {
		t.Fatalf("New returned a directory that does not exist: %v", err)
	}
}

func TestNewFallsBackWhenTmpdirIsTooLong(t *testing.T) {
	// The whole point of the package: a TMPDIR too long to hold a socket must not be used, or
	// `bind` would fail later with an EINVAL that explains nothing. The fallback has to land
	// somewhere, so this needs a usable /tmp -- the one environment the package cannot invent.
	requireFallback(t)
	long := filepath.Join(os.TempDir(), strings.Repeat("d", MaxSocketPath))
	if err := os.MkdirAll(long, 0o755); err != nil {
		t.Skipf("cannot create a path that long here: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(long) })
	t.Setenv("TMPDIR", long)
	got := New(t, "x", need)
	if strings.HasPrefix(got, long) {
		t.Fatalf("New used a TMPDIR of %d bytes: %q", len(long), got)
	}
}

// TestNewFallsBackForABigNeedWhereASmallOneFits is the regression test for the bug this package
// shipped with: the check was applied to the BASE against a fixed 40-byte allowance, so darwin's
// default TMPDIR (~48 bytes) passed it and was preferred over /tmp -- and then the collision test's
// 45-byte "/firecracker/vm-6/root/run/firecracker.socket" did not fit under the directory that came
// back, so `bind` failed with EINVAL exactly where the hardcoded /tmp had worked.
//
// It builds one TMPDIR and asks for two different needs. The small one must be satisfied from
// TMPDIR, proving the directory itself is fine and the test is not just measuring an unusable
// TMPDIR; the large one must fall back, which the base-only check could not do because it never
// saw `need` at all.
func TestNewFallsBackForABigNeedWhereASmallOneFits(t *testing.T) {
	requireFallback(t)
	// A base sized so that a directory under it leaves room for a short socket name but not a
	// long one, which is precisely darwin's situation.
	const smallNeed = len("/c.sock")
	const bigNeed = len("/firecracker/vm-6/root/run/firecracker.socket")
	// MkdirTemp appends the prefix plus up to 10 digits; budget for the longest. The padding is
	// sized so the base comes to exactly MaxSocketPath-smallNeed-made bytes whatever os.TempDir()
	// is, which keeps this deterministic on both a 4-byte /tmp and a 48-byte darwin TMPDIR.
	const made = len("x") + 10
	pad := MaxSocketPath - smallNeed - made - len(os.TempDir()) - 2
	if pad < 1 {
		t.Skipf("os.TempDir() is %d bytes, too long to build a base under", len(os.TempDir()))
	}
	base := filepath.Join(os.TempDir(), strings.Repeat("d", pad))
	if err := os.MkdirAll(base, 0o755); err != nil {
		t.Skipf("cannot create a base of that length here: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(base) })
	t.Setenv("TMPDIR", base)

	small := New(t, "x", smallNeed)
	if !strings.HasPrefix(small, base) {
		t.Fatalf("a %d-byte need did not use a TMPDIR that fits it: got %q under a %d-byte base",
			smallNeed, small, len(base))
	}
	big := New(t, "x", bigNeed)
	if strings.HasPrefix(big, base) {
		t.Fatalf("a %d-byte need used a TMPDIR with only %d bytes to spare: %q",
			bigNeed, MaxSocketPath-len(big), big)
	}
}

// requireFallback skips when no short writable directory exists besides TMPDIR, which is the case
// in a sandbox with a read-only /tmp. The tests that need a FALLBACK cannot run there; the ones
// that only need TMPDIR itself still do, and so does every caller in the real suites.
func requireFallback(t *testing.T) {
	t.Helper()
	d, err := os.MkdirTemp("/tmp", "sdprobe")
	if err != nil {
		t.Skipf("no short writable directory to fall back to (/tmp: %v)", err)
	}
	_ = os.RemoveAll(d)
}

func TestNewLeavesRoomForTheCallersSocketName(t *testing.T) {
	// Asserted against the same thing Make now checks -- the created directory -- so the package
	// and its test cannot disagree, which they did while Make measured only the base.
	for _, n := range []int{len("/c.sock"), len("/firecracker/vm-6/root/run/firecracker.socket")} {
		got := New(t, "x", n)
		if len(got)+n > MaxSocketPath {
			t.Fatalf("New returned %q (%d bytes), no room for a %d-byte socket name under it",
				got, len(got), n)
		}
	}
}

func TestMakeSaysWhatItTriedWhenNothingFits(t *testing.T) {
	// An impossible need: no directory anywhere can hold it, so this exercises the error path
	// without depending on a particular TMPDIR.
	dir, err := Make("x", MaxSocketPath+1)
	if err == nil {
		_ = os.RemoveAll(dir)
		t.Fatalf("Make accepted a need of %d bytes, returning %q", MaxSocketPath+1, dir)
	}
	for _, want := range []string{"shortdir:", "tried:"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not mention %q", err, want)
		}
	}
}

func TestNewWithNoTmpdirUsesTheOsDefault(t *testing.T) {
	// Without TMPDIR the only candidates are /tmp and the Go default, so this needs one of them.
	requireFallback(t)
	t.Setenv("TMPDIR", "")
	got := New(t, "x", need)
	if _, err := os.Stat(got); err != nil {
		t.Fatalf("New returned a directory that does not exist: %v", err)
	}
}
