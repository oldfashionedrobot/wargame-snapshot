---
name: gate
description: Run the full pre-commit verification gate — forced typecheck, lint, all tests, format check, build, and no development hook in the bundle — and report per-leg exit codes. Use before every commit, and after any change worth keeping.
---

# The verification gate

`bun run gate` is the gate — the same script CI runs. It runs every leg even
after one fails, and its last line names each leg's exit code. Judge **only
exit codes** — never grep output for success (`… | tail -3 && echo OK` chains
the `&&` to `tail` and prints OK on failure; that happened in this repo).

From the repo root:

```sh
bun run gate > /tmp/gate.log 2>&1; echo "gate=$?"; tail -1 /tmp/gate.log
```

`gate=0` is green. Report the exit code and the per-leg line.

On failure, the per-leg line says which leg; read that leg's output in
`/tmp/gate.log` (each starts with `── <leg>:`), or re-run it alone:

- **format** → `bun run format` (prettier --write), then re-run the gate — a
  fix must not break another leg.
- **lint / typecheck** → fix the code; never disable a rule to get past it
  without saying so explicitly.
- **test / build** → read the failure output in full before touching anything.
- **hooks** → a development-only handle (`__board`) or the inspector reached the
  built bundle; find what stopped being behind `import.meta.env.DEV`.

Never commit on a red gate, and never chain `git commit` off anything but the
full green chain — commit only after the gate has printed `gate=0` in this
run, not a previous one.
