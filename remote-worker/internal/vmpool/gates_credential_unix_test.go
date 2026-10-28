//go:build unix

package vmpool

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rossoctl/moca/remote-worker/internal/egress"
	"github.com/rossoctl/moca/remote-worker/internal/egress/control"
)

// guestScanScript runs inside the guest as ONE Run (a VM serves exactly one). It makes an
// authenticated request through the proxy, then looks for two values -- a canary it plants
// itself, and the fixture credential -- in every file under / (grep -r -I -F, /proc, /sys
// and /dev excluded), in every /proc/*/environ, and in the memory of every process
// (/proc/<pid>/maps, then /proc/<pid>/mem; unreadable regions are skipped).
//
// Neither value is ever in the command: the Exec agent in the guest holds the command in its
// own memory, which the scan would then find. Both arrive REVERSED ($1 = canary, $2 = fixture)
// and are turned back inside the scanner, whose own process and its parent shell are skipped.
// The canary is the control: the same scan must find it in a file, in an environ and in
// memory, or "found nothing" for the fixture proves nothing.
const guestScanScript = `
set -u
command -v curl >/dev/null && command -v python3 >/dev/null || { echo "MISSING-TOOLS: the guest needs curl and python3"; exit 0; }
cat >/tmp/pyscan.py <<'PYEOF'
import os, sys
rev = sys.argv[1]
pat = rev[::-1].encode()
skip = {os.getpid(), os.getppid()}
keep = len(pat) - 1
pids = sorted(int(p) for p in os.listdir("/proc") if p.isdigit() and int(p) not in skip)
for pid in pids:
    try:
        with open("/proc/%d/environ" % pid, "rb") as f:
            if pat in f.read():
                print("HIT environ: pid %d" % pid)
    except OSError:
        pass
regions = nbytes = 0
for pid in pids:
    try:
        maps = open("/proc/%d/maps" % pid).read().splitlines()
        mem = open("/proc/%d/mem" % pid, "rb", 0)
    except OSError:
        continue
    hit = False
    for line in maps:
        parts = line.split()
        if len(parts) < 2 or not parts[1].startswith("r"):
            continue
        if len(parts) >= 6 and parts[5] in ("[vvar]", "[vsyscall]", "[vdso]"):
            continue
        lo, hi = (int(x, 16) for x in parts[0].split("-"))
        pos, tail = lo, b""
        try:
            mem.seek(lo)
            while pos < hi:
                chunk = mem.read(min(1 << 20, hi - pos))
                if not chunk:
                    break
                pos += len(chunk)
                nbytes += len(chunk)
                if pat in tail + chunk:
                    hit = True
                    break
                tail = chunk[-keep:] if keep else b""
            regions += 1
        except (OSError, OverflowError, ValueError):
            continue
        if hit:
            break
    mem.close()
    if hit:
        try:
            comm = open("/proc/%d/comm" % pid).read().strip()
        except OSError:
            comm = "?"
        print("HIT mem: pid %d (%s)" % (pid, comm))
print("SCANNED pids=%d regions=%d bytes=%d" % (len(pids), regions, nbytes))
PYEOF

scan() {
  local p
  p=$(python3 -c 'import sys; print(sys.argv[1][::-1])' "$1")
  grep -r -I -F -l --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev -e "$p" / 2>/dev/null | sed 's/^/HIT file: /'
  python3 /tmp/pyscan.py "$1"
}

# The canary: in a file, in a process's environment and memory.
C=$(python3 -c 'import sys; print(sys.argv[1][::-1])' "$1")
printf '%s\n' "$C" >/tmp/canary.txt
CANARY_VAL="$C" sleep 120 &
sleep 1

echo ==REQUEST==
curl -sS --max-time 20 --proxy http://127.0.0.1:3128 "$3" 2>&1
echo
echo ==CANARY==
scan "$1"
echo ==FIXTURE==
scan "$2"
echo ==END==
`

func TestGateCredentialNeverInGuest(t *testing.T) {
	requireKVM(t)
	if v := envOr("SH_VMM", "firecracker"); v != "firecracker" {
		t.Skipf("SH_VMM=%q: the egress vsock transport is a Firecracker-arm feature", v)
	}
	caCert, caKey := os.Getenv("SH_EGRESS_CA_CERT"), os.Getenv("SH_EGRESS_CA_KEY")
	if caCert == "" || caKey == "" {
		t.Skip("NOT RUN (no signal, not a pass): set SH_EGRESS_CA_CERT and SH_EGRESS_CA_KEY to the interception CA " +
			"whose public certificate the snapshot was built with (build-snapshot.sh --egress-ca)")
	}

	// The fixture: random per run, so a stale copy of an earlier run cannot match.
	rb := make([]byte, 12)
	if _, err := rand.Read(rb); err != nil {
		t.Fatal(err)
	}
	fixture := "gate-fixture-credential-" + hex.EncodeToString(rb)
	canary := "gate-canary-" + hex.EncodeToString(rb)
	want := "Bearer " + fixture

	// The upstream: TLS, certificate for up.test, accepts only the fixture credential.
	upCert, upPEM := selfSignedFor(t, "up.test")
	var upMu sync.Mutex
	var upAuth []string
	up := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upMu.Lock()
		upAuth = append(upAuth, r.Header.Get("Authorization"))
		upMu.Unlock()
		if r.Header.Get("Authorization") != want {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		_, _ = w.Write([]byte("authed-ok"))
	}))
	up.TLS = &tls.Config{Certificates: []tls.Certificate{upCert}}
	up.StartTLS()
	defer up.Close()
	_, port, err := net.SplitHostPort(up.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	portN := 0
	_, _ = fmt.Sscan(port, &portN)

	// The fake control plane: POST /v1/egress/credential, bearer token, the fixture for up.test.
	const cpToken = "gate-cp-token"
	var cpMu sync.Mutex
	var cpCalls int
	cp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/egress/credential" || r.Header.Get("Authorization") != "Bearer "+cpToken {
			http.Error(w, "bad", http.StatusUnauthorized)
			return
		}
		cpMu.Lock()
		cpCalls++
		cpMu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{
			"subject": "gate-user", "ttlSeconds": 60,
			"credentials": []map[string]any{{
				"name": "gate-fixture", "port": portN, "pathPrefix": "/",
				"headers": []map[string]string{{"name": "Authorization", "value": want}},
			}},
		})
	}))
	defer cp.Close()

	dir := t.TempDir()
	write := func(name string, b []byte) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, b, 0o600); err != nil {
			t.Fatal(err)
		}
		return p
	}
	env := map[string]string{
		"MOCA_EGRESS_ALLOW":                  "up.test:" + port,
		"MOCA_EGRESS_CREDENTIALS_URL":        cp.URL,
		"MOCA_EGRESS_CREDENTIALS_TOKEN_FILE": write("token", []byte(cpToken)),
		"MOCA_EGRESS_CA_CERT_FILE":           caCert,
		"MOCA_EGRESS_CA_KEY_FILE":            caKey,
		"MOCA_EGRESS_UPSTREAM_CA":            write("up.pem", upPEM),
	}
	cfg, _, err := egress.ConfigFromEnv(func(k string) string { return env[k] })
	if err != nil {
		t.Fatalf("ConfigFromEnv: %v", err)
	}
	cfg.PermitCIDRs = []netip.Prefix{netip.MustParsePrefix("127.0.0.1/32")}
	cfg.Resolver = mapResolver{"up.test": netip.MustParseAddr("127.0.0.1")}
	cfg.LocalAddrs = nil
	audit := &recordingAudit{}
	cfg.Audit = audit
	proxy, err := egress.NewProxy(cfg)
	if err != nil {
		t.Fatalf("NewProxy: %v", err)
	}
	defer proxy.Close()

	sockDir, err := os.MkdirTemp("/tmp", "egc")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(sockDir)
	sock := filepath.Join(sockDir, "c.sock")
	srv, err := control.NewServer(sock, []int{os.Getuid()}, proxy)
	if err != nil {
		t.Fatalf("control.NewServer: %v", err)
	}
	go func() { _ = srv.Serve() }()
	defer srv.Close()
	client := control.NewClient(sock)
	defer client.Close()

	lc := fcLauncherWith(t, func(o *FirecrackerOptions) { o.Egress = client })
	workspace := sameDeviceSiblingDir(t, envOr("SH_SNAPSHOT_IMAGE_DIR", "/srv/snapshots/swebench-py311"))
	vm, err := lc.Restore(context.Background(), RestoreRequest{
		// The ID is short on purpose: the jailed firecracker.socket path
		// (<chroot base>/firecracker/<ID>/root/run/firecracker.socket) must fit in
		// the 108-byte sun_path limit under the rig's chroot base.
		ID: "vm-cred", Key: "cred-gate", WorkspaceDir: workspace, GuestRAMBytes: 256 << 20,
	})
	if err != nil {
		t.Fatalf("Restore: %v", err)
	}
	defer func() { _ = vm.Destroy() }()
	if err := vm.Resume(context.Background()); err != nil {
		t.Fatalf("Resume: %v", err)
	}

	// Both values reversed on the command line (see guestScanScript).
	args := fmt.Sprintf("%s %s %s", shQuote(reverse(canary)), shQuote(reverse(fixture)), shQuote("https://up.test:"+port+"/"))
	var out capturingSink
	if _, err := vm.Run(context.Background(), Command{Command: "bash -c " + shQuote(guestScanScript) + " scan " + args, TimeoutS: 600, CapBytes: OutputCapBytes}, &out); err != nil {
		t.Fatalf("Run: %v", err)
	}
	got := out.out()
	if strings.Contains(got, "MISSING-TOOLS") {
		t.Fatalf("the snapshot lacks curl or python3:\n%s", got)
	}
	if strings.Contains(got, fixture) {
		t.Fatalf("the fixture credential reached the guest's stdout")
	}
	if strings.Contains(got, "Connection refused") {
		t.Fatalf("guest 127.0.0.1:3128 refused the connection: snapshot built without the egress init?\n%s", got)
	}

	section := func(name, next string) string {
		_, rest, ok := strings.Cut(got, "=="+name+"==\n")
		if !ok {
			t.Fatalf("no ==%s== section in the guest output:\n%s", name, got)
		}
		s, _, _ := strings.Cut(rest, "=="+next+"==")
		return s
	}
	if r := section("REQUEST", "CANARY"); !strings.Contains(r, "authed-ok") {
		t.Fatalf("the authenticated request did not reach the upstream with the credential (%d control-plane lookups); guest said:\n%s", cpCalls, r)
	}
	upMu.Lock()
	sawUpstream := false
	for _, a := range upAuth {
		sawUpstream = sawUpstream || a == want
	}
	upMu.Unlock()
	if !sawUpstream {
		t.Errorf("the upstream never saw the injected Authorization header")
	}

	// The control: the scanner must find a planted value everywhere it looks.
	canarySec := section("CANARY", "FIXTURE")
	for _, kind := range []string{"HIT file: /tmp/canary.txt", "HIT environ:", "HIT mem:"} {
		if !strings.Contains(canarySec, kind) {
			t.Errorf("the scan missed the planted canary (%q not reported): its \"found nothing\" would prove nothing:\n%s", kind, canarySec)
		}
	}
	fixSec := section("FIXTURE", "END")
	if !strings.Contains(fixSec, "SCANNED pids=") || strings.Contains(fixSec, "regions=0 ") {
		t.Errorf("the memory scan read no regions:\n%s", fixSec)
	}
	if strings.Contains(fixSec, "HIT ") {
		t.Errorf("the credential is in the guest:\n%s", fixSec)
	}
}

func reverse(s string) string {
	b := []byte(s)
	for i, j := 0, len(b)-1; i < j; i, j = i+1, j-1 {
		b[i], b[j] = b[j], b[i]
	}
	return string(b)
}

// selfSignedFor returns a TLS certificate valid for host and its PEM, which the proxy trusts
// as an upstream root.
func selfSignedFor(t *testing.T, host string) (tls.Certificate, []byte) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: host},
		DNSNames:              []string{host},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(24 * time.Hour),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		IsCA:                  true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key},
		pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
}
