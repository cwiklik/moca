#!/usr/bin/env bash
# deploy/microvm/build-rootfs.sh
#
# Turns the P6 sandbox IMAGE's filesystem into a directory tree for
# `build-snapshot.sh --rootfs`, so a microVM built from it carries the same toolchain the
# container tier does (bash, coreutils, findutils, file, git, python3, rg, gh -- see
# remote-worker/Dockerfile). It only READS the image: `podman create` + `podman export`, then
# the temporary container is removed. build-snapshot.sh layers the guest agent and its init
# on top; nothing here adds either.
#
# Usage:
#   sudo deploy/microvm/build-rootfs.sh --out /srv/rootfs/moca-sandbox [--image REF]
#
# Root because the image's files have owners (the /workspace mount point is 1001:0, most of
# the tree root:0) and the snapshot's rootfs must keep them; a non-root extraction would
# silently re-own everything to the caller. Root also finds the image where setup-vm.sh put
# it: in root's podman storage.
set -euo pipefail

IMAGE="${SANDBOX_IMAGE:-ghcr.io/rossoctl/moca-remote-worker:latest}"
OUT=""
# The container tier's Hello.capabilities (cmd/worker's `probed`) plus the two coreutils the
# harness's own file ops call. A tree missing one of these would boot, snapshot, advertise less,
# and then fail the first tool call that needs it -- so refuse here instead.
REQUIRED_TOOLS=(bash git rg gh python3 base64 file ls cat)

usage() {
  echo "usage: $0 --out DIR [--image REF]   (default image: $IMAGE)" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
  --out) OUT="${2:-}"; shift 2 ;;
  --image) IMAGE="${2:-}"; shift 2 ;;
  -h | --help) usage ;;
  *) echo "build-rootfs.sh: unknown argument $1" >&2; usage ;;
  esac
done
if [ -z "$OUT" ] || [ -z "$IMAGE" ]; then usage; fi

if [ "$(id -u)" != 0 ]; then
  echo "build-rootfs.sh: must run as root (file ownership inside the image must survive" \
    "extraction, and setup-vm.sh's image lives in root's podman storage)" >&2
  exit 1
fi
# Never merge into, or clobber, an existing tree: a half-old, half-new rootfs is exactly the
# artifact nobody can reason about later.
if [ -e "$OUT" ] && [ -n "$(ls -A "$OUT" 2>/dev/null)" ]; then
  echo "build-rootfs.sh: --out $OUT exists and is not empty; remove it or choose another path" >&2
  exit 1
fi

podman image exists "$IMAGE" || podman pull "$IMAGE"
digest="$(podman image inspect --format '{{.Digest}}' "$IMAGE")"

cid="$(podman create "$IMAGE")"
cleanup() { podman rm -f "$cid" >/dev/null 2>&1 || true; }
trap cleanup EXIT

mkdir -p "$OUT"
podman export "$cid" | tar -x -p --numeric-owner -f - -C "$OUT"

missing=()
for t in "${REQUIRED_TOOLS[@]}"; do
  found=no
  for d in usr/local/bin usr/bin bin; do
    if [ -x "$OUT/$d/$t" ]; then found=yes; break; fi
  done
  [ "$found" = yes ] || missing+=("$t")
done
if [ "${#missing[@]}" -gt 0 ]; then
  echo "build-rootfs.sh: $IMAGE is missing required tool(s): ${missing[*]} -- a snapshot built" \
    "from it would advertise less than the container tier and fail those tool calls" >&2
  rm -rf "$OUT"
  exit 1
fi

# The container tier's own worker binary is inert in a guest (the guest agent is the executor,
# installed by build-snapshot.sh), so it has no business in the image the VM trusts.
rm -f "$OUT/usr/local/bin/remote-worker"
# Mount points init and the kernel need; an exported container tree may lack them.
mkdir -p "$OUT/dev" "$OUT/proc" "$OUT/sys"
printf 'image=%s\ndigest=%s\n' "$IMAGE" "$digest" >"$OUT/etc/moca-rootfs-source"

echo "build-rootfs.sh: $OUT is ready (from $IMAGE @ $digest)"
