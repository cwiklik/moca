package shortdir_test

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// TestEveryCallerDeclaresEnoughRoom reads the suite's own source and checks each shortdir
// caller's `need` against the longest socket path that package actually joins onto the
// directory it gets back.
//
// It exists because the hand-audit is the step that keeps going wrong. `need` is written once
// at the call site, while the names bound under it live hundreds of lines away and grow when
// someone adds a test. Three call sites were already undersized that way:
//
//	internal/egress/control   len("/vm1.sock")=9   but vmListener binds "vm-doomed.sock" (15)
//	cmd/moca-egress           len("/c.sock")=7     but the test also binds "vm.sock" (8)
//	internal/egress           len("/vm-1.sock")=10 but #641 added "vm-quiet" (14), long after
//
// The last one is the point: that need was correct when written and became wrong when an
// unrelated PR added a longer VM id. An undersized need does not fail on a short base like
// /tmp, so nothing catches it until someone runs with a long TMPDIR -- which is precisely the
// case this package exists to handle, and precisely the case CI never exercises.
//
// Deliberately source-level rather than a runtime assertion: the names are compile-time
// literals, so this reports every call site at once instead of only the paths a given run
// happens to execute.
func TestEveryCallerDeclaresEnoughRoom(t *testing.T) {
	// shortdir.go's own doc comment carries an example call, which is documentation rather
	// than a caller; skipping the package itself keeps the example free to stay illustrative.
	const self = "internal/shortdir"

	callRe := regexp.MustCompile(`shortdir\.(?:New|Make)\(([^)]*?)len\("([^"]+)"\)\)`)
	joinRe := regexp.MustCompile(`filepath\.Join\((?:h\.)?(?:dir|d|base|sockDir|jailRoot|jail)\b[^)]*?"([^"]+)"`)
	// vmListener takes a full filename; .register takes a bare id the proxy suffixes with
	// ".sock". Conflating the two is how this test's first draft reported a phantom
	// "vm-doomed.sock.sock".
	fileRe := regexp.MustCompile(`vmListener\(t,\s*\w+,\s*"([^"]+)"`)
	idRe := regexp.MustCompile(`\.register\("([^"]+)"`)
	// A join of a VARIABLE id, e.g. filepath.Join(h.dir, id+".sock"). The literal ids live in
	// another file, so this file's own names cannot bound the path -- it must be charged the
	// package maximum. Without this, conformance.go's need was checked only against the
	// "/c.sock" beside it and the longer "vm-a" ids cases.go registers were never considered.
	varJoinRe := regexp.MustCompile(`filepath\.Join\((?:h\.)?(?:dir|d|base|sockDir)\b,\s*\w+\s*\+`)

	type site struct {
		file string
		need string
	}
	type pkg struct {
		sites    []site
		names    map[string]bool            // every socket name bound anywhere in the package
		byFile   map[string]map[string]bool // and the subset bound in each file
		pkgScope map[string]bool            // files joining a variable name: use names, not byFile
	}
	pkgs := map[string]*pkg{}

	// "../.." not "..": the test's working directory is internal/shortdir, so ".." is
	// internal/ and would silently skip cmd/ and egress/ -- which is how the first draft
	// reported 12 sites and missed the undersized one in cmd/moca-egress entirely.
	root := filepath.Join("..", "..")
	if err := filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(p, ".go") {
			return nil
		}
		if strings.Contains(filepath.ToSlash(p), self) {
			return nil
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return nil
		}
		s, dir := string(b), filepath.Dir(p)
		if pkgs[dir] == nil {
			pkgs[dir] = &pkg{names: map[string]bool{}, byFile: map[string]map[string]bool{}, pkgScope: map[string]bool{}}
		}
		if pkgs[dir].byFile[p] == nil {
			pkgs[dir].byFile[p] = map[string]bool{}
		}
		note := func(n string) {
			pkgs[dir].names[n] = true
			pkgs[dir].byFile[p][n] = true
		}
		// Appended, never keyed: two call sites in one file may legitimately declare the
		// same need, and a map would silently collapse them.
		for _, m := range callRe.FindAllStringSubmatch(s, -1) {
			pkgs[dir].sites = append(pkgs[dir].sites, site{file: p, need: m[2]})
		}
		for _, m := range joinRe.FindAllStringSubmatch(s, -1) {
			if looksLikeSocket(m[1]) {
				note("/" + m[1])
			}
		}
		for _, m := range fileRe.FindAllStringSubmatch(s, -1) {
			note("/" + m[1])
		}
		for _, m := range idRe.FindAllStringSubmatch(s, -1) {
			note("/" + m[1] + ".sock")
		}
		if varJoinRe.MatchString(s) {
			pkgs[dir].pkgScope[p] = true
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	checked := 0
	for dir, p := range pkgs {
		if len(p.sites) == 0 || len(p.names) == 0 {
			continue
		}
		longestIn := func(names map[string]bool) string {
			out := ""
			for n := range names {
				if len(n) > len(out) {
					out = n
				}
			}
			return out
		}
		for _, s := range p.sites {
			checked++
			// Prefer the names bound in the caller's own file: a directory used by exactly one
			// test is bounded by what that test binds, and charging it the package maximum
			// would be a false positive (cmd/moca-egress's sdnotify dir only ever holds
			// "/notify"). Only when the file binds nothing does the package become the best
			// available evidence -- that is the helper-in-another-file shape of control/ and
			// vmpool/, where the names genuinely live elsewhere.
			scope, where := p.byFile[s.file], s.file
			if len(scope) == 0 || p.pkgScope[s.file] {
				scope, where = p.names, dir
			}
			longest := longestIn(scope)
			if len(s.need) < len(longest) {
				t.Errorf("%s declares need=len(%q)=%d, but %s binds %q (%d bytes) under that "+
					"directory;\n\tsize the call for the longest socket it binds",
					s.file, s.need, len(s.need), where, longest, len(longest))
			}
		}
	}
	// Without this the test passes vacuously the moment a refactor breaks the scan.
	if checked < 14 {
		t.Fatalf("scanned only %d call sites across %d packages; the source scan is broken, "+
			"not the callers (expected every shortdir.New/Make in the module)", checked, len(pkgs))
	}
	t.Logf("checked %d call sites across %d packages", checked, len(pkgs))
}

// looksLikeSocket reports whether a joined basename is plausibly a bound Unix socket, which
// is what sun_path bounds -- a regular file under the same directory is irrelevant to it.
//
// A name-based guess, because the alternative is dataflow: these names reach `bind` through
// local variables, helper parameters and shell scripts, and following that properly means a
// type-checked SSA pass rather than a regexp. The two errors are not symmetric, so it is kept
// deliberately narrow: a missed socket loses one call site's coverage, while a regular file
// counted as a socket is a false failure on correct code, which is how this test first
// reported vmpool's "jailer-was-spawned" marker file. Known socket spellings in this suite
// are .sock, .socket and the vsock "v.sock_<port>"; cmd/moca-egress's systemd notify socket
// is named plain "notify", so that one is listed outright.
func looksLikeSocket(name string) bool {
	if strings.Contains(name, ".sock") || strings.HasSuffix(name, ".socket") {
		return true
	}
	return name == "notify"
}
