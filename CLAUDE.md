# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

See @AGENTS.md for setup, run commands, the five-layer architecture, auth, and the event schema.
It is the source of truth — keep it current, and keep this file to what it does not cover.

## Additional notes

- **Run everything from the repo root.** There is no `pyproject.toml` or `setup.py`, so nothing is
  installable and `twinflow` resolves only because the repo root is on `sys.path`. The script
  entry points (`python run_demo.py`, `python validate.py`) get that for free wherever they are
  invoked from, since Python adds the script's own directory — but `uvicorn server:app` and any
  bare `import twinflow` (REPL, `python -c`, a test runner) resolve against the cwd and fail
  outside the root.

- **`server.py` duplicates the other two entry points.** Its `_random_scenario`,
  `_spec_limit_baseline`, `_detection_scoring` and `_sensor_sweep` are near-verbatim copies of the
  same-named functions in `validate.py`, and `server.py:run_demo()` re-implements
  `run_demo.py:build_payload()`. A change to payload shape or validation logic must be mirrored in
  both files or the dashboard and the CLI will disagree. `trust_loop_row`, `variant_conditioning`,
  `forecast_accuracy` and `forecast_summary` are imported from `validate` instead — new shared
  helpers should go that way rather than growing the copied set, and the copied ones are worth
  converting to imports whenever you are rewriting one anyway.

- **`requirements.txt` overstates the dependencies.** Only `numpy`, `fastapi` and `uvicorn` are
  imported anywhere; `pandas`, `scikit-learn`, `scipy` and `networkx` are declared but unused.
  There is no simpy either — the discrete-event loop in `twinflow/simulator.py:LineSimulator.run()`
  is a hand-rolled 1 s tick with an explicit downstream-first push phase then upstream-first pull
  phase. Don't assume simpy semantics when editing it.

- **`out/twin_run.json` and `out/validation.json` are tracked in git** and rewritten by every run,
  so expect large diffs after `run_demo.py` or `validate.py`. `out/history.json` (from
  `build_history.py`) joins them — `/api/history` serves it when its shift count matches the request
  and runs ten shifts inline (~20 s) when it does not, so stale or missing means a slow manager view,
  not a broken one. `frontend/public/out` is a symlink to
  `out/`, and `frontend/dist/out/` holds stale copies — both are leftovers of the old `?data=`
  query-param load path and are not read by anything in `frontend/src/`.

- **Type checking the frontend** is `cd frontend && npm run build` (`tsc -b && vite build`). There
  is no standalone typecheck or lint script.

- **Auth gates the view, not the data.** `/api/run-demo`, `/api/validate` and `/api/line-info`
  require no `Authorization` header; the token only selects which of Floor/Manager/Leadership
  renders. Passwords in `users.json` are compared in plaintext, and `_active_tokens` is in-memory
  with no expiry, so `--reload` invalidates every session. Fine for the demo, not a security model
  to build on.

- **Design docs:** `ARCHITECTURE.md` is the source. `ARCHITECTURE.typ` and `ARCHITECTURE.pdf` are
  conversions of it, rebuilt with `pandoc ARCHITECTURE.md -t typst -o ARCHITECTURE.typ` then
  `typst compile ARCHITECTURE.typ` — nothing in the repo records those commands.

- **`frontend/src/components/Tabs.tsx` is dead code.** Role-based routing via `VIEW_MAP` in
  `App.tsx` replaced the tab bar; nothing imports it.

- **The line JSON is regenerated, not hand-edited, when the variant block changes.** The `variants`
  mix and the fourteen per-station `variant_cycle_mult` overrides in
  `twinflow/lines/final_assembly_a.json` were applied by a one-off script. Two invariants worth
  re-checking after any change to them: the mix-weighted constraint must stay FA17 end-of-line test
  (PT06 primer sand overtakes it if its SUV multiplier goes much past 1.10, which unbalances the
  line), and `max(s.mix_cycle_s)` is the takt every layer compares against.
