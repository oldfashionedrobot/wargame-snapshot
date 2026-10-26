#!/bin/sh
# The gate, run by CI and by the /gate skill alike. Every leg runs even after
# one fails, the last line names each leg's exit code, and the gate's own exit
# code is non-zero if any leg's was.
# ⚠️ The typecheck is forced: `tsc -b` can pass stale off its .tsbuildinfo.

failed=0
summary=""

run() {
  leg=$1
  shift
  echo "── $leg: $*"
  "$@"
  code=$?
  summary="$summary $leg=$code"
  [ "$code" -eq 0 ] || failed=1
}

run typecheck bunx tsc -b --force
run lint bun run lint
run test bun run test
run format bun run format:check
run build bun run build
# A development hook that reached the bundle: the board's test handle, or the
# inspector. Not `toggleInspector`, which stays as a method the build empties.
run hooks sh -c 'test -d packages/client/dist && ! grep -rlE "__board|@babylonjs/inspector" packages/client/dist'

echo "gate:$summary"
exit $failed
