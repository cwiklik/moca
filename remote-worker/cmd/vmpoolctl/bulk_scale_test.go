package main

import (
	"encoding/json"
	"strings"
	"testing"
)

// bulkRecord runs teardown-bulk over the fake launcher and returns its record. The fake
// launcher exercises the pool's real admission control (runLocked -> admitLocked), which
// is what this file is about, without needing KVM.
func bulkRecord(t *testing.T, args ...string) (runResult, string, error) {
	t.Helper()
	dir := t.TempDir()
	base := []string{"--vmm=fake", "--snapshot-dir=" + dir, "--workspace-root=" + dir,
		"--key=run-a", "--mode=teardown-bulk", "--json"}
	// vmpoolctl requires a command after `--` in every mode, teardown included, so that
	// every rung's invocation has the same shape. Supplied here for the same reason
	// e10-lifecycle.sh's vmpoolctl_run supplies it.
	args = append(args, "--", "true")
	out, err := run(t, append(base, args...)...)
	var rec runResult
	_ = json.Unmarshal([]byte(strings.TrimSpace(out)), &rec)
	return rec, out, err
}

// TestTeardownBulkAtMetalScaleDoesNotExhaustTheAdmissionBudget is the metal blocker.
//
// teardown-bulk used to take its batch fan-out from --iterations, which for every other
// mode is a repeat count: more iterations means more samples at the same resource
// footprint. For bulk it meant more SIMULTANEOUS VMs. At E10's metal defaults
// (ITERS=200, D=2) that asked for 400 concurrent microVMs, the 32 GiB admission budget
// refused after ~57 keys, and the mode exited non-zero with 143 failures. Because
// e10-lifecycle.sh's vmpoolctl_run dies on a non-zero exit, that aborted the entire
// ladder at rung 4 — and the runbook's ITERS=5 smoke pass (10 VMs) could never reveal
// it, because the failure only exists at scale.
//
// Fan-out now has its own knob, so --iterations means iterations here too.
func TestTeardownBulkAtMetalScaleDoesNotExhaustTheAdmissionBudget(t *testing.T) {
	rec, out, err := bulkRecord(t, "--iterations=200", "--warmup=20")
	if err != nil {
		t.Fatalf("teardown-bulk at E10's metal defaults returned %v — this is the rung that aborts the ladder (out=%s)", err, out)
	}
	if rec.Failures != 0 {
		t.Errorf("Failures = %d at --iterations=200, want 0 — the batch is still scaling with the repeat count", rec.Failures)
	}
	if len(rec.Refusals) != 0 {
		t.Errorf("Refusals = %v, want none — admission refused a batch this rung should have sized to fit", rec.Refusals)
	}
	// --iterations must now buy samples, and the warmup must be real rather than merely
	// reported: the record claimed warmup_discarded=N for a mode that discarded nothing.
	if rec.WarmupDiscarded != 20 {
		t.Errorf("WarmupDiscarded = %d, want 20", rec.WarmupDiscarded)
	}
}

// TestTeardownBulkFanOutIsBoundedByItsOwnKnobNotIterations is the reachability half
// (branch discipline #3: before asserting "the budget no longer refuses", prove it still
// CAN refuse — otherwise the test above could pass because admission was disabled).
//
// A large repeat count must be free; a large fan-out must still hit the budget, and hit
// it as a counted refusal rather than as a crash. The two arms differ only in WHICH knob
// is large, which is the property under test.
func TestTeardownBulkFanOutIsBoundedByItsOwnKnobNotIterations(t *testing.T) {
	// Many iterations, small fan-out: fine.
	rec, out, err := bulkRecord(t, "--iterations=50", "--warmup=0", "--bulk-keys=2")
	if err != nil {
		t.Fatalf("50 iterations of a 2-key batch: %v (out=%s)", err, out)
	}
	if rec.Failures != 0 {
		t.Errorf("Failures = %d with a small fan-out over many iterations, want 0", rec.Failures)
	}

	// One iteration, fan-out far past the budget: 512 keys x D2 x 288 MiB is
	// ~288 GiB against the 32 GiB default.
	//
	// #644 changed what "hitting the budget" looks like for the paused component:
	// a fan-out past the budget now SHEDS the earlier runs' standbys
	// (evictForBudgetLocked) rather than refusing, because a dropped standby costs
	// a cold acquire while a refusal costs a turn. The reachability assertion
	// therefore moved from the refusal counter to the eviction counter — the gate
	// must still bite, measurably, or the metal-scale test above proves nothing;
	// it just bites as churn now. (Refusing is still reachable, via the running
	// component: see TestAWarmAcquireIsRepricedAtPopTime in internal/vmpool.)
	rec2, _, err2 := bulkRecord(t, "--iterations=1", "--warmup=0", "--bulk-keys=512")
	if err2 != nil {
		t.Fatalf("a 512-key batch returned %v — eviction, not refusal, is what a standby-side overflow looks like since #644", err2)
	}
	if rec2.BudgetEvictions == 0 {
		t.Fatal("a 512-key batch against a 32 GiB budget evicted nothing — admission pressure is not reachable from this mode, so the metal-scale test above proves nothing")
	}
}
