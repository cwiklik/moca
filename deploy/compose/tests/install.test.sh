#!/usr/bin/env bash
# Docker-free test for install.sh (#342). Mocks docker/docker-compose/curl onto PATH, wraps every
# other external command install.sh could reach in a logging shim, runs the script the way a
# `curl | sh` user would (under sh, from a pipe), and asserts on the recorded argv and the files it
# leaves behind. Same approach as deploy/vm/tests/setup-vm.test.sh.
set -euo pipefail

COMPOSE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$COMPOSE_DIR/install.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export MOCK_LOG="$TMP/mock.log"
mkdir -p "$TMP/bin"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}
pass() { echo "ok - $*"; }

# Logging shims for the ordinary externals. A secret that reaches ANY process's argv is readable
# by every local user through /proc/<pid>/cmdline, so mocking only docker would miss a token handed
# to `sed`, `tee` or `od` on its way into .env. Each shim logs its argv and execs the real binary.
# They are also the ONLY way anything reaches a binary: PATH below is this bin dir alone, so a real
# docker in /usr/bin (every GitHub runner has one) can never stand in for the mock.
for cmd in awk basename cat chmod cmp cp cut dirname env grep head id ls mkdir mktemp mv od printf \
  rm sed sh sort stat tail tee touch tr uname wc; do
  real="$(command -v "$cmd" 2>/dev/null)" || continue
  [[ "$real" == /* ]] || continue # a builtin with no binary on this host: nothing to shim
  printf '#!/bin/sh\nprintf "%%s %%s\\n" %s "$*" >>"$MOCK_LOG"\nexec %s "$@"\n' \
    "$cmd" "$real" >"$TMP/bin/$cmd"
  chmod +x "$TMP/bin/$cmd"
done

# curl: "download" by copying the file named by the URL's last path segment out of this checkout,
# so the test proves install.sh fetches exactly the compose file that ships next to it.
cat >"$TMP/bin/curl" <<MOCK
#!/bin/sh
printf 'curl %s\n' "\$*" >>"\$MOCK_LOG"
out=''
url=''
while [ \$# -gt 0 ]; do
  case "\$1" in
  -o) out="\$2"; shift 2 ;;
  -*) shift ;;
  *) url="\$1"; shift ;;
  esac
done
src="$COMPOSE_DIR/\${url##*/}"
[ -f "\$src" ] || { echo "mock curl: 404 \$url" >&2; exit 22; }
if [ -n "\$out" ]; then /bin/cp "\$src" "\$out"; else /bin/cat "\$src"; fi
MOCK

# docker: records argv and the working directory (compose reads .env from the project dir).
# MOCK_NO_COMPOSE_PLUGIN=1 makes `docker compose` behave like a docker without the v2 plugin.
# MOCK_PULL_FAIL=1 makes `compose pull` fail, as an offline host or a private registry does.
# `docker run ... genkeys.ts` stands in for the control plane's key generator: fresh random values in
# genkeys.ts's output shapes (control-plane/test/main.test.ts pins those against the real code), or
# a garbled line under MOCK_GENKEYS_BAD=1.
cat >"$TMP/bin/docker" <<'MOCK'
#!/bin/sh
printf 'docker %s [cwd=%s]\n' "$*" "$PWD" >>"$MOCK_LOG"
if [ "${1-}" = compose ] && [ -n "${MOCK_NO_COMPOSE_PLUGIN-}" ]; then
  echo "docker: 'compose' is not a docker command." >&2
  exit 1
fi
if [ "${1-}" = compose ] && [ "${2-}" = pull ] && [ -n "${MOCK_PULL_FAIL-}" ]; then
  echo "mock: Error response from daemon: unauthorized" >&2
  exit 1
fi
if [ "${1-}" = run ]; then
  case "$*" in *genkeys.ts*) ;; *) exit 0 ;; esac
  hex() { od -An -tx1 -N"$1" /dev/urandom | tr -d ' \n'; }
  if [ -n "${MOCK_GENKEYS_BAD-}" ]; then
    printf 'SH_SESSION_TOKEN_PRIVATE_KEY=MC4C%s\n' "$(hex 16)"
    printf 'SH_SESSION_TOKEN_PUBLIC_KEYS=%s:MCow\n' "$(hex 8)"
    printf 'SH_CREDENTIAL_KEK=not a key\n'
    printf 'SH_EXCHANGE_TOKEN=%s\n' "$(hex 32)"
    exit 0
  fi
  printf 'SH_SESSION_TOKEN_PRIVATE_KEY=MC4CAQAwBQYDK2VwBCIEI%s\n' "$(hex 22)"
  printf 'SH_SESSION_TOKEN_PUBLIC_KEYS=%s:MCowBQYDK2VwAyEA%s\n' "$(hex 8)" "$(hex 22)"
  printf 'SH_CREDENTIAL_KEK=%s=\n' "$(hex 22 | cut -c1-43)"
  printf 'SH_EXCHANGE_TOKEN=%s\n' "$(hex 32)"
fi
exit 0
MOCK
cat >"$TMP/bin/docker-compose" <<'MOCK'
#!/bin/sh
printf 'docker-compose %s [cwd=%s]\n' "$*" "$PWD" >>"$MOCK_LOG"
MOCK
chmod +x "$TMP/bin/curl" "$TMP/bin/docker" "$TMP/bin/docker-compose"

export PATH="$TMP/bin"
# The test's own commands must bypass the shims: a shimmed `grep -q curl "$MOCK_LOG"` logs its own
# argv before it runs, so it matches itself and passes vacuously -- and grepping for the token would
# put the token in a logged argv. Functions win over PATH, so these cover every call below.
grep() { PATH=/usr/bin:/bin command grep "$@"; }
tail() { PATH=/usr/bin:/bin command tail "$@"; }
cut() { PATH=/usr/bin:/bin command cut "$@"; }
# A developer's own shell may carry these; the script must not pick them up by accident.
unset SH_RELAY_TOKEN SH_TURNS_PER_WORKER ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL \
  OPENAI_API_KEY SH_MODEL MOCK_NO_COMPOSE_PLUGIN MOCK_GENKEYS_BAD MOCK_PULL_FAIL SH_GITHUB_CLIENT_ID \
  SH_HARNESS_IMAGE SH_SKIP_PULL COMPOSE_PROFILES 2>/dev/null || true
export SH_COMPOSE_BASE_URL="https://example.invalid/deploy/compose"

# Runs install.sh exactly as the README's one-liner does: the script body on sh's stdin, so
# nothing may depend on BASH_SOURCE, $0 or the script's own location on disk.
run_install() {
  : >"$MOCK_LOG"
  sh <"$SCRIPT"
}

# Asserts no logged argv contains the value. Also asserts the log is non-empty, so a shim setup
# that silently logged nothing cannot turn this into a vacuous pass.
assert_not_in_argv() {
  local value="$1"
  [[ -s "$MOCK_LOG" ]] || fail "mock log is empty -- the argv check would be vacuous"
  if grep -qF -- "$value" "$MOCK_LOG"; then
    fail "the relay token reached a process argv (world-readable via /proc/<pid>/cmdline):" \
      "$(grep -F -- "$value" "$MOCK_LOG")"
  fi
}

env_value() { grep -E "^$1=" "$2" | tail -1 | cut -d= -f2-; }

# The line number of the first logged argv matching the ERE, or empty. The mock log is append-only
# and single-process, so comparing two of these compares the order the commands actually ran in.
log_line_of() { grep -nE "$1" "$MOCK_LOG" | head -1 | cut -d: -f1; }

mode_of() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"; }

# --- 1. fresh install with an operator-supplied token ------------------------------------------
export SH_COMPOSE_DIR="$TMP/one"
SH_RELAY_TOKEN='s3cr3t-operator-value' run_install || fail "fresh install exited non-zero"
[[ -f "$SH_COMPOSE_DIR/docker-compose.yml" ]] || fail "docker-compose.yml was not fetched"
cmp -s "$SH_COMPOSE_DIR/docker-compose.yml" "$COMPOSE_DIR/docker-compose.yml" ||
  fail "the fetched compose file is not the one shipped in deploy/compose"
grep -qF "curl" "$MOCK_LOG" || fail "install.sh did not download anything with curl"
grep -qF "$SH_COMPOSE_BASE_URL/docker-compose.yml" "$MOCK_LOG" ||
  fail "compose file not fetched from SH_COMPOSE_BASE_URL: $(grep curl "$MOCK_LOG")"
[[ "$(env_value SH_RELAY_TOKEN "$SH_COMPOSE_DIR/.env")" == 's3cr3t-operator-value' ]] ||
  fail ".env does not carry the operator's SH_RELAY_TOKEN"
[[ "$(mode_of "$SH_COMPOSE_DIR/.env")" == 600 ]] ||
  fail ".env holds the relay token and must be mode 600, got $(mode_of "$SH_COMPOSE_DIR/.env")"
assert_not_in_argv 's3cr3t-operator-value'
grep -qE "^docker compose up -d \[cwd=$SH_COMPOSE_DIR\]$" "$MOCK_LOG" ||
  fail "expected 'docker compose up -d' run from $SH_COMPOSE_DIR: $(grep '^docker' "$MOCK_LOG")"
pass "fresh install: fetches the compose file, writes a 0600 .env, runs up -d, token never in argv"

# #349: `up -d` reuses a cached :latest without ever re-resolving it, so a machine that pulled the
# image once runs that one forever -- and both defaults are mutable tags build.yaml republishes on
# every push to main. The pull must happen, from the project directory (so .env's SH_HARNESS_IMAGE
# and SH_SANDBOX_IMAGE are the references pulled), and BEFORE up -d, which is the whole point.
grep -qE "^docker compose pull \[cwd=$SH_COMPOSE_DIR\]$" "$MOCK_LOG" ||
  fail "install.sh did not pull before starting the stack, so a stale cached :latest runs (#349):" \
    "$(grep '^docker' "$MOCK_LOG")"
pull_at="$(log_line_of '^docker compose pull ')"
up_at="$(log_line_of '^docker compose up -d ')"
[[ -n "$pull_at" && -n "$up_at" && "$pull_at" -lt "$up_at" ]] ||
  fail "the pull must run before up -d (pull at line '$pull_at', up at '$up_at')"
pass "fresh install pulls the images from the project directory, before up -d (#349)"

# The supervisor's readConfig refuses to start with SH_TURNS_PER_WORKER blank, and the compose
# file makes it required, so a trial install that leaves it unset never gets a supervisor.
[[ "$(env_value SH_TURNS_PER_WORKER "$SH_COMPOSE_DIR/.env")" =~ ^[1-9][0-9]*$ ]] ||
  fail ".env must set SH_TURNS_PER_WORKER to a positive integer for a trial run"
pass "fresh install sets a positive SH_TURNS_PER_WORKER"

# --- 2. no token supplied: one is generated, never on argv, distinct per install -----------------
export SH_COMPOSE_DIR="$TMP/two"
run_install || fail "install without a token exited non-zero"
GEN_A="$(env_value SH_RELAY_TOKEN "$SH_COMPOSE_DIR/.env")"
[[ "$GEN_A" =~ ^[0-9a-f]{64}$ ]] ||
  fail "a generated SH_RELAY_TOKEN must be 32 random bytes as hex, got '${GEN_A}'"
assert_not_in_argv "$GEN_A"
export SH_COMPOSE_DIR="$TMP/three"
run_install || fail "second install without a token exited non-zero"
GEN_B="$(env_value SH_RELAY_TOKEN "$SH_COMPOSE_DIR/.env")"
[[ "$GEN_A" != "$GEN_B" ]] || fail "two installs generated the same token: it is not random"
pass "no token supplied: a fresh 256-bit token is generated per install and never enters argv"

EXEC_A="$(env_value MOCA_RELAY_EXEC_TOKEN "$SH_COMPOSE_DIR/.env")"
[[ "$EXEC_A" =~ ^[0-9a-f]{64}$ ]] ||
  fail "a fresh install must generate MOCA_RELAY_EXEC_TOKEN as 32 random bytes of hex, got '${EXEC_A}'"
[[ "$EXEC_A" != "$(env_value SH_RELAY_TOKEN "$SH_COMPOSE_DIR/.env")" ]] ||
  fail "MOCA_RELAY_EXEC_TOKEN must not equal SH_RELAY_TOKEN: sandboxes hold the latter"
run_install || fail "re-run exited non-zero"
[[ "$(env_value MOCA_RELAY_EXEC_TOKEN "$SH_COMPOSE_DIR/.env")" == "$EXEC_A" ]] ||
  fail "a re-run replaced MOCA_RELAY_EXEC_TOKEN"
pass "MOCA_RELAY_EXEC_TOKEN is generated once, distinct from SH_RELAY_TOKEN, and kept on re-run"

# An install that predates MI1 has an .env with no exec token: the re-run adds one, touching nothing else.
printf 'SH_RELAY_TOKEN=keep-me\nSH_TURNS_PER_WORKER=4\n' >"$SH_COMPOSE_DIR/.env"
run_install || fail "upgrade re-run exited non-zero"
[[ "$(env_value SH_RELAY_TOKEN "$SH_COMPOSE_DIR/.env")" == keep-me ]] ||
  fail "the upgrade touched SH_RELAY_TOKEN"
[[ "$(env_value MOCA_RELAY_EXEC_TOKEN "$SH_COMPOSE_DIR/.env")" =~ ^[0-9a-f]{64}$ ]] ||
  fail "the upgrade did not add MOCA_RELAY_EXEC_TOKEN"
pass "an existing .env without MOCA_RELAY_EXEC_TOKEN gains one; nothing else changes"

# The same upgrade, when the operator's editor left no newline at the end of the last line.
printf 'SH_TURNS_PER_WORKER=4\nSH_RELAY_TOKEN=keep-me' >"$SH_COMPOSE_DIR/.env"
run_install || fail "upgrade re-run exited non-zero on an .env with no final newline"
[[ "$(env_value SH_RELAY_TOKEN "$SH_COMPOSE_DIR/.env")" == keep-me ]] ||
  fail "appending to an .env with no final newline changed SH_RELAY_TOKEN: $(cat "$SH_COMPOSE_DIR/.env")"
[[ "$(env_value MOCA_RELAY_EXEC_TOKEN "$SH_COMPOSE_DIR/.env")" =~ ^[0-9a-f]{64}$ ]] ||
  fail "the exec token was not appended as its own line: $(cat "$SH_COMPOSE_DIR/.env")"
pass "an .env with no final newline gains the exec token on its own line"

# --- 3. a re-run never clobbers an operator-edited .env ------------------------------------------
export SH_COMPOSE_DIR="$TMP/two"
sed -i.bak 's/^SH_TURNS_PER_WORKER=.*/SH_TURNS_PER_WORKER=11/' "$SH_COMPOSE_DIR/.env"
SH_RELAY_TOKEN='a-different-value' run_install || fail "re-run exited non-zero"
[[ "$(env_value SH_TURNS_PER_WORKER "$SH_COMPOSE_DIR/.env")" == 11 ]] ||
  fail "re-run clobbered the operator's edited SH_TURNS_PER_WORKER"
[[ "$(env_value SH_RELAY_TOKEN "$SH_COMPOSE_DIR/.env")" == "$GEN_A" ]] ||
  fail "re-run replaced the existing SH_RELAY_TOKEN; running sandboxes would stop authenticating"
grep -q '^docker compose up -d' "$MOCK_LOG" || fail "re-run did not bring the stack up"
# The re-run IS the #349 case: this directory's images were pulled on the first install, so without
# a pull here the "upgrade" path in README.md ("Re-run install.sh") never gets the current main.
grep -q '^docker compose pull' "$MOCK_LOG" ||
  fail "a re-run did not pull, so the documented upgrade path keeps running the cached images (#349)"
pass "re-run keeps an existing .env untouched, pulls, and still runs up -d"

# --- 4. an existing .env with no token fails closed, before any container starts ----------------
export SH_COMPOSE_DIR="$TMP/four"
mkdir -p "$SH_COMPOSE_DIR"
printf 'SH_TURNS_PER_WORKER=4\n#SH_RELAY_TOKEN=\n' >"$SH_COMPOSE_DIR/.env"
if run_install 2>"$TMP/err"; then fail "install succeeded with an .env that has no SH_RELAY_TOKEN"; fi
grep -q 'SH_RELAY_TOKEN' "$TMP/err" || fail "the refusal must name SH_RELAY_TOKEN: $(cat "$TMP/err")"
if grep -q ' up ' "$MOCK_LOG"; then fail "containers were started despite the missing token: $(grep ' up ' "$MOCK_LOG")"; fi
pass "an existing .env without SH_RELAY_TOKEN fails closed, naming the variable, starting nothing"

# --- 5. model credentials in the caller's environment reach .env, not argv -----------------------
export SH_COMPOSE_DIR="$TMP/five"
ANTHROPIC_API_KEY='sk-ant-fabricated-for-test' run_install || # notsecret
  fail "install with a model key exited non-zero"
[[ "$(env_value ANTHROPIC_API_KEY "$SH_COMPOSE_DIR/.env")" == 'sk-ant-fabricated-for-test' ]] || # notsecret
  fail "ANTHROPIC_API_KEY from the caller's environment was not written to .env"
assert_not_in_argv 'sk-ant-fabricated-for-test' # notsecret
# Unset credentials must stay absent: an empty SH_MODEL= would reach the worker as '' and
# run-turn.ts's `env.SH_MODEL ?? default` keeps the empty string instead of the default model.
if grep -qE '^(SH_MODEL|OPENAI_API_KEY)=' "$SH_COMPOSE_DIR/.env"; then
  fail "unset model variables must not be written to .env as empty assignments"
fi
pass "caller-supplied model credentials land in .env only; unset ones are left out"

# --- 6. falls back to the standalone docker-compose binary ---------------------------------------
export SH_COMPOSE_DIR="$TMP/six"
MOCK_NO_COMPOSE_PLUGIN=1 run_install || fail "install with only docker-compose exited non-zero"
grep -qE "^docker-compose up -d \[cwd=$SH_COMPOSE_DIR\]$" "$MOCK_LOG" ||
  fail "expected the docker-compose fallback: $(grep -E '^docker' "$MOCK_LOG")"
# The pull goes through the same entrypoint: `docker compose pull` on a machine without the v2
# plugin is the error detect_compose exists to avoid, and would abort the install.
grep -qE "^docker-compose pull \[cwd=$SH_COMPOSE_DIR\]$" "$MOCK_LOG" ||
  fail "the pull did not use the docker-compose fallback: $(grep -E '^docker' "$MOCK_LOG")"
pass "without the compose plugin, both the pull and up -d fall back to docker-compose"

# --- 7. no docker at all: a clear refusal, nothing written ---------------------------------------
export SH_COMPOSE_DIR="$TMP/seven"
mv "$TMP/bin/docker" "$TMP/bin/docker.off"
mv "$TMP/bin/docker-compose" "$TMP/bin/docker-compose.off"
# Without this guard, a docker elsewhere on PATH turns the check below into a real
# `docker compose up` on the test host -- which is what happened on the CI runner.
if command -v docker >/dev/null || command -v docker-compose >/dev/null; then
  fail "a docker is still reachable on PATH ($(command -v docker docker-compose | tr '\n' ' '))" \
    "-- this test would run the host's real docker"
fi
if run_install 2>"$TMP/err"; then fail "install succeeded with no docker on PATH"; fi
grep -qi 'docker' "$TMP/err" || fail "the refusal must name docker: $(cat "$TMP/err")"
[[ ! -e "$SH_COMPOSE_DIR/.env" ]] || fail "a .env was written before the docker check failed"
mv "$TMP/bin/docker.off" "$TMP/bin/docker"
mv "$TMP/bin/docker-compose.off" "$TMP/bin/docker-compose"
pass "no docker on PATH: refuses before writing anything"

# --- 8. the MU1 control plane's secrets (#348) ---------------------------------------------------
MU1_KEYS='SH_SESSION_TOKEN_PRIVATE_KEY SH_SESSION_TOKEN_PUBLIC_KEYS SH_CREDENTIAL_KEK SH_EXCHANGE_TOKEN'
genkeys_runs() { grep -c '^docker run .*genkeys\.ts' "$MOCK_LOG" || true; }

# Without a control plane nothing is generated: no generator run, no MU1 key in .env.
export SH_COMPOSE_DIR="$TMP/eight-none"
run_install || fail "install without a client id exited non-zero"
[[ "$(genkeys_runs)" == 0 ]] || fail "an install with no control plane ran the key generator"
if grep -qE '^SH_(SESSION_TOKEN|CREDENTIAL_KEK|EXCHANGE_TOKEN)' "$SH_COMPOSE_DIR/.env"; then
  fail "an install with no control plane wrote MU1 secrets"
fi
pass "no control plane: the key generator never runs"

# Every case below wants the control plane.
export SH_GITHUB_CLIENT_ID=Iv1.fabricated

export SH_COMPOSE_DIR="$TMP/eight"
run_install || fail "fresh install exited non-zero"
ENV8="$SH_COMPOSE_DIR/.env"
[[ "$(env_value SH_SESSION_TOKEN_PRIVATE_KEY "$ENV8")" =~ ^[A-Za-z0-9+/]+=*$ ]] ||
  fail "no one-line SH_SESSION_TOKEN_PRIVATE_KEY in .env"
[[ "$(env_value SH_SESSION_TOKEN_PUBLIC_KEYS "$ENV8")" =~ ^[0-9a-f]{16}:[A-Za-z0-9+/]+=*$ ]] ||
  fail "SH_SESSION_TOKEN_PUBLIC_KEYS is not <kid>:<base64 SPKI>"
[[ "$(env_value SH_CREDENTIAL_KEK "$ENV8")" =~ ^[A-Za-z0-9+/]{43}=$ ]] ||
  fail "SH_CREDENTIAL_KEK is not 32 bytes of base64"
[[ "$(env_value SH_EXCHANGE_TOKEN "$ENV8")" =~ ^[0-9a-f]{64}$ ]] || fail "SH_EXCHANGE_TOKEN is not 32 bytes of hex"
[[ "$(mode_of "$ENV8")" == 600 ]] || fail ".env must stay mode 600 once it holds the signing key"
for k in $MU1_KEYS; do assert_not_in_argv "$(env_value "$k" "$ENV8")"; done
grep -qE '^docker run --rm --network none --user 1000:1000 -w /app/packages/control-plane ghcr\.io/rossoctl/moca:latest node --import tsx src/genkeys\.ts' \
  "$MOCK_LOG" || fail "the key generator must run offline in the harness image: $(grep '^docker run' "$MOCK_LOG")"
# The generator is code from the harness image, so it has to run on the PULLED one (#349): a stale
# image may ship a different genkeys.ts, or -- as in the issue -- not the package at all.
genkeys_at="$(log_line_of '^docker run .*genkeys\.ts')"
[[ -n "$genkeys_at" && "$(log_line_of '^docker compose pull ')" -lt "$genkeys_at" ]] ||
  fail "the key generator ran before the pull, so it ran in a possibly stale image (#349)"
pass "a fresh install generates the four MU1 secrets in the harness image, offline, never in argv"

before="$(grep -E '^SH_(SESSION_TOKEN|CREDENTIAL_KEK|EXCHANGE_TOKEN)' "$ENV8")"
run_install || fail "re-run exited non-zero"
[[ "$(grep -E '^SH_(SESSION_TOKEN|CREDENTIAL_KEK|EXCHANGE_TOKEN)' "$ENV8")" == "$before" ]] ||
  fail "a re-run changed an MU1 secret: a new KEK strands every stored credential"
[[ "$(genkeys_runs)" == 0 ]] || fail "a re-run with every secret present still ran the key generator"
pass "a re-run keeps every MU1 secret and does not run the generator"

# Upgrading a pre-#348 .env: the missing secrets are added, an existing one is kept.
# 43 base64 chars + '=' (32 bytes), by the builtin printf: this test's PATH has no seq.
KEEP_KEK="$(printf '%043d=' 0)"
[[ "$KEEP_KEK" =~ ^0{43}=$ ]] || fail "test setup: KEEP_KEK is '$KEEP_KEK'"
printf 'SH_RELAY_TOKEN=keep-me\nSH_TURNS_PER_WORKER=4\nMOCA_RELAY_EXEC_TOKEN=x\nSH_CREDENTIAL_KEK=%s\n' \
  "$KEEP_KEK" >"$ENV8"
run_install || fail "upgrade re-run exited non-zero"
[[ "$(env_value SH_CREDENTIAL_KEK "$ENV8")" == "$KEEP_KEK" ]] ||
  fail "the upgrade replaced an existing SH_CREDENTIAL_KEK"
[[ "$(grep -c '^SH_CREDENTIAL_KEK=' "$ENV8")" == 1 ]] || fail "the upgrade appended a second SH_CREDENTIAL_KEK"
for k in SH_SESSION_TOKEN_PRIVATE_KEY SH_SESSION_TOKEN_PUBLIC_KEYS SH_EXCHANGE_TOKEN; do
  [[ -n "$(env_value "$k" "$ENV8")" ]] || fail "the upgrade did not add $k"
done
pass "an existing .env gains only the MU1 secrets it lacks"

# Half a keypair is refused: generating the other half would pair it with the wrong key.
printf 'SH_RELAY_TOKEN=keep-me\nSH_TURNS_PER_WORKER=4\nSH_SESSION_TOKEN_PUBLIC_KEYS=0123456789abcdef:AAAA\n' >"$ENV8"
if run_install 2>"$TMP/err"; then fail "install succeeded with only the public half of the signing key"; fi
grep -q SH_SESSION_TOKEN_PRIVATE_KEY "$TMP/err" || fail "the refusal must name the missing half: $(cat "$TMP/err")"
if grep -q ' up ' "$MOCK_LOG"; then fail "containers were started despite the half keypair"; fi
[[ -z "$(env_value SH_SESSION_TOKEN_PRIVATE_KEY "$ENV8")" ]] || fail "a private key was invented for an existing public key"
pass "half a signing keypair fails closed, starting nothing"

# A garbled generator writes NOTHING -- not even the values that did parse.
export SH_COMPOSE_DIR="$TMP/eight-bad"
if MOCK_GENKEYS_BAD=1 run_install 2>"$TMP/err"; then fail "install accepted a garbled key generator"; fi
grep -q SH_CREDENTIAL_KEK "$TMP/err" || fail "the refusal must name the bad value: $(cat "$TMP/err")"
if grep -qE '^SH_(SESSION_TOKEN|CREDENTIAL_KEK|EXCHANGE_TOKEN)' "$SH_COMPOSE_DIR/.env"; then
  fail "a garbled generator left MU1 secrets in .env: $(grep -E '^SH_(SESSION|CREDENTIAL|EXCHANGE)' "$SH_COMPOSE_DIR/.env" | cut -d= -f1)"
fi
if grep -q ' up ' "$MOCK_LOG"; then fail "containers were started after a garbled key generator"; fi
pass "a garbled key generator is refused before anything is written"

# SH_HARNESS_IMAGE picks the image the generator runs in, as it picks the one compose runs.
export SH_COMPOSE_DIR="$TMP/eight-img"
SH_HARNESS_IMAGE=dev.local/harness:test run_install || fail "install with SH_HARNESS_IMAGE exited non-zero"
grep -qE '^docker run .* dev\.local/harness:test node ' "$MOCK_LOG" ||
  fail "SH_HARNESS_IMAGE did not reach the key generator: $(grep '^docker run' "$MOCK_LOG")"
pass "SH_HARNESS_IMAGE picks the key generator's image"

unset SH_GITHUB_CLIENT_ID

# --- 9. SH_GITHUB_CLIENT_ID turns the control plane on ---------------------------------------------
export SH_COMPOSE_DIR="$TMP/nine"
run_install >"$TMP/out" || fail "install without a client id exited non-zero"
if grep -qE '^(COMPOSE_PROFILES|SH_GITHUB_CLIENT_ID)=' "$SH_COMPOSE_DIR/.env"; then
  fail "without SH_GITHUB_CLIENT_ID the control-plane profile must stay off"
fi
grep -q 'SH_GITHUB_CLIENT_ID' "$TMP/out" || fail "an install without a control plane must say how to add one"
SH_GITHUB_CLIENT_ID=Iv1.fabricated run_install >"$TMP/out" || fail "install with a client id exited non-zero"
[[ "$(env_value SH_GITHUB_CLIENT_ID "$SH_COMPOSE_DIR/.env")" == Iv1.fabricated ]] ||
  fail "SH_GITHUB_CLIENT_ID was not recorded in .env"
[[ "$(env_value COMPOSE_PROFILES "$SH_COMPOSE_DIR/.env")" == control-plane ]] ||
  fail "a client id must turn on COMPOSE_PROFILES=control-plane"
grep -q '127.0.0.1:8090' "$TMP/out" || fail "the install must print the control plane's URL"
run_install >/dev/null || fail "re-run exited non-zero"
[[ "$(grep -c '^COMPOSE_PROFILES=' "$SH_COMPOSE_DIR/.env")" == 1 ]] || fail "a re-run appended COMPOSE_PROFILES again"
pass "SH_GITHUB_CLIENT_ID records the client id and turns on the control-plane profile, once"

export SH_COMPOSE_DIR="$TMP/nine-own"
mkdir -p "$SH_COMPOSE_DIR"
printf 'SH_RELAY_TOKEN=t\nSH_TURNS_PER_WORKER=4\nCOMPOSE_PROFILES=mine\n' >"$SH_COMPOSE_DIR/.env"
SH_GITHUB_CLIENT_ID=Iv1.fabricated run_install >"$TMP/out" || fail "install exited non-zero"
[[ "$(env_value COMPOSE_PROFILES "$SH_COMPOSE_DIR/.env")" == mine ]] ||
  fail "an operator's own COMPOSE_PROFILES line was rewritten"
grep -q 'WARNING: .*without control-plane' "$TMP/out" || fail "a profile line without control-plane must be warned about"
if grep -q '^==> control plane:' "$TMP/out"; then fail "the closing message claims a control plane the profile never starts"; fi
[[ "$(genkeys_runs)" == 0 ]] || fail "keys were generated for a control plane that will not run"
pass "an operator's own COMPOSE_PROFILES is left alone, warned about, and not claimed as running"

# A line that does list control-plane, among others, runs it -- and the message uses .env's ports.
printf 'SH_RELAY_TOKEN=t\nSH_TURNS_PER_WORKER=4\nCOMPOSE_PROFILES=mine, control-plane\nSH_PORT=18080\nSH_CP_PORT=18090\n' \
  >"$SH_COMPOSE_DIR/.env"
SH_GITHUB_CLIENT_ID=Iv1.fabricated run_install >"$TMP/out" || fail "install exited non-zero"
grep -q '^==> control plane: http://127.0.0.1:18090 ' "$TMP/out" ||
  fail "the closing message ignores SH_CP_PORT: $(grep '^==> control plane' "$TMP/out")"
grep -q 'Supervisor: http://127.0.0.1:18080 ' "$TMP/out" || fail "the closing message ignores SH_PORT"
[[ "$(genkeys_runs)" == 1 ]] || fail "a profile line listing control-plane must get its keys generated"
pass "a COMPOSE_PROFILES list including control-plane runs it, and the message prints the real ports"

# The fallback is opt-in: a fresh .env carries it commented out, never on.
if grep -qE '^SH_ALLOW_OPERATOR_FALLBACK=' "$TMP/nine/.env"; then fail "install turned the operator-key fallback on"; fi
grep -qE '^#SH_ALLOW_OPERATOR_FALLBACK=true$' "$TMP/nine/.env" || fail "a fresh .env should show how to opt in to the fallback"
pass "the operator-key fallback stays off, documented in .env"

# --- 10. only docker-compose, no docker CLI ------------------------------------------------------
# Without a control plane that machine installs as it always did; with one, the key generator cannot
# run, so it refuses before starting anything.
export SH_COMPOSE_DIR="$TMP/ten"
mv "$TMP/bin/docker" "$TMP/bin/docker.off"
run_install || fail "a docker-compose-only machine with no control plane must still install"
grep -qE "^docker-compose up -d \[cwd=$SH_COMPOSE_DIR\]$" "$MOCK_LOG" ||
  fail "expected docker-compose up: $(grep -E '^docker' "$MOCK_LOG")"
export SH_COMPOSE_DIR="$TMP/ten-cp"
if SH_GITHUB_CLIENT_ID=Iv1.fabricated run_install 2>"$TMP/err"; then
  fail "install succeeded with a control plane and no docker CLI to generate its keys"
fi
grep -q 'docker CLI' "$TMP/err" || fail "the refusal must say the docker CLI is needed: $(cat "$TMP/err")"
if grep -q ' up ' "$MOCK_LOG"; then fail "containers were started with no keys generated"; fi
mv "$TMP/bin/docker.off" "$TMP/bin/docker"
pass "docker-compose only: installs without a control plane, refuses one it cannot generate keys for"

# --- 11. the pull is fail-closed, and SH_SKIP_PULL is the way past it (#349) ----------------------
# A pull that fails leaves only the images this machine happens to hold, which is the bug the pull
# exists to prevent -- and on a first install there is nothing to run at all. So it refuses, says
# how to override, and starts nothing.
export SH_COMPOSE_DIR="$TMP/eleven"
if MOCK_PULL_FAIL=1 run_install 2>"$TMP/err"; then fail "install succeeded with a failing pull"; fi
grep -q 'SH_SKIP_PULL' "$TMP/err" || fail "the refusal must name the override: $(cat "$TMP/err")"
if grep -q ' up ' "$MOCK_LOG"; then fail "the stack was started after a failed pull: $(grep ' up ' "$MOCK_LOG")"; fi
pass "a failed pull refuses, names SH_SKIP_PULL, and starts nothing"

# Same failing registry, with the override: the stack comes up on the local images, and the pull is
# not even attempted -- an offline host must not have to wait for one to time out.
export SH_COMPOSE_DIR="$TMP/eleven-skip"
MOCK_PULL_FAIL=1 SH_SKIP_PULL=1 run_install >"$TMP/out" || fail "SH_SKIP_PULL install exited non-zero"
if grep -q '^docker compose pull' "$MOCK_LOG"; then fail "SH_SKIP_PULL still pulled: $(grep '^docker compose' "$MOCK_LOG")"; fi
grep -qE "^docker compose up -d \[cwd=$SH_COMPOSE_DIR\]$" "$MOCK_LOG" ||
  fail "SH_SKIP_PULL did not bring the stack up: $(grep '^docker' "$MOCK_LOG")"
grep -q 'SH_SKIP_PULL' "$TMP/out" || fail "a skipped pull must be visible in the output: $(cat "$TMP/out")"
pass "SH_SKIP_PULL skips the pull, says so, and still starts the stack"

# The control plane's keys are generated inside the harness image, so a refused pull must stop
# before that -- a stale image is exactly the case where the generator may be missing (#349).
export SH_COMPOSE_DIR="$TMP/eleven-cp"
if MOCK_PULL_FAIL=1 SH_GITHUB_CLIENT_ID=Iv1.fabricated run_install 2>"$TMP/err"; then
  fail "install with a control plane succeeded with a failing pull"
fi
[[ "$(genkeys_runs)" == 0 ]] || fail "the key generator ran in an unpulled image after the pull failed"
if grep -qE '^SH_(SESSION_TOKEN|CREDENTIAL_KEK|EXCHANGE_TOKEN)' "$SH_COMPOSE_DIR/.env"; then
  fail "MU1 secrets were written after a failed pull"
fi
pass "a failed pull stops before the key generator, writing no MU1 secret"
