# Client rendering performance

Issue [#117](https://github.com/oDestroyeRo/openrayrag/issues/117) tracks lower client CPU and rendering churn while preserving controls, settings and telemetry. The changes retain unchanged activity/drop rows, keep canvas backing dimensions stable, redraw only changed map overlays, paint collision without allocating route-planning structures, reuse the dashboard settings snapshot, and retain permanent field references while reading current DOM values. Dynamic rule rows, admission, locks, native status publication and periodic refresh cadence remain live.

## Repeatable offline benchmark

Install the locked npm dependencies and use Node with built-in `WebSocket`, plus Chrome/Chromium. The default executable is `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`; override it with `--chrome /path/to/chrome` or `CHROME_PATH`. This is a manual benchmark, with no CI timing gate.

```sh
node scripts/benchmark-client-rendering.mjs --ref 3bf3f4daa0f9172340af22d05ee6562f986c74c0 --output /tmp/rayrag-client-rendering-baseline.json
node scripts/benchmark-client-rendering.mjs --compare /tmp/rayrag-client-rendering-baseline.json --output /tmp/rayrag-client-rendering-candidate.json
```

The first command bundles `src/` from the baseline commit. The second bundles the working tree with the same harness. Both load actual `src/main.ts`, FeatureUi, SettingsForm and BotConsole in a fresh temporary browser profile. Tauri IPC is replaced only inside the benchmark bundle by strict synthetic commands and events; no app, game connection, account credentials or existing browser profile is accessed.

Each scenario has two warmup passes and five samples, normally replaying 100 statuses. The 400 × 400 `prt_fild08` fixture contains 24 monsters, 12 drops and 50 log entries. Workloads include unchanged observations, HP/counters, moving actors/drops/routes, appended and edited logs, the real main-window 1000 ms callback, and ten disconnect/reconnect cycles. Automatic intervals are suspended inside the fixture so their phase cannot contaminate measurements; production scheduling is unchanged.

Counters are collected in a separate pass using prototype wrappers and MutationObserver. Timed passes restore original methods and disconnect the observer. CDP renderer TaskDuration and heap readings bracket replay only; preparation and outcome hashing happen outside that window. Reports bind source hashes, harness/dependency hashes, browser, machine, methodology and workload. Comparisons reject incompatible reports and require matching visible outcomes, including 322 controls, HP/SP bar widths, text/logs and canvas pixels.

## Recorded comparison, 2026-10-04

Machine: Apple M5 Pro, 18 cores, 48 GiB RAM; macOS Darwin 27.2.0; Node v26.10.0; Chrome 154.0.8037.97; 1280 × 900 viewport and UTC. Baseline commit: `3bf3f4daa0f9172340af22d05ee6562f986c74c0`.

| Workload | Baseline replay ms | Candidate replay ms | Baseline renderer CPU ms | Candidate renderer CPU ms |
| --- | ---: | ---: | ---: | ---: |
| 100 unchanged statuses | 247.4 | 89.0 | 249.8 | 91.0 |
| 100 HP/counter updates | 267.4 | 91.7 | 270.5 | 93.9 |
| 100 actor/drop/route updates | 247.5 | 98.4 | 250.1 | 100.4 |
| 100 appended/edited log updates | 252.4 | 194.6 | 255.1 | 197.0 |
| 100 periodic refresh callbacks | 82.8 | 51.3 | 84.4 | 52.3 |
| 10 disconnect/reconnect cycles | 204.5 | 51.5 | 207.1 | 54.1 |

All entries are medians; times are observations, not acceptance thresholds. For 100 unchanged statuses:

| Renderer work | Baseline | Candidate |
| --- | ---: | ---: |
| Created elements | 18,900 | 2,700 |
| Log time formatting | 5,000 | 0 |
| Canvas backing dimension writes | 200 | 0 |
| Map raster drawImage calls | 100 | 0 |
| FeatureUi settings reads | 700 | 600 |
| SettingsForm snapshots | 200 | 100 |
| SettingsForm refreshes | 200 | 200 |

Moving overlays still draw 100 times. Changed logs still format and display the bounded 50 entries. Disconnect/reconnect still rebuilds the single current-map collision raster; its painter avoids clearance/component planning and temporary per-pixel color arrays.

The first final baseline is retained at `/tmp/rayrag-client-rendering-baseline-final.json`, and the candidate report at `/tmp/rayrag-client-rendering-candidate.json`. Their loaded-source hashes are `0a5b0df236c3d611cac86efdff32e805afdb48af00c2cd42f22f48e0dc2f6faa` and `136b088a20080eed908a511bfb3be6f3d90e7bc7f35adbba3f71c0d1edad1411`. Both use harness/dependency hash `50889d48b7868dc87feebbd233dd25030c11604e4cdd051dceef81e95ae28122`.

## Correctness and proof limits

The focused 140-test run covers bounded log append/rollover, same-length text/timestamp edits, literal text safety, in-place and fractional actor/drop coordinates, route/leg/goal changes, metadata-only updates, unchanged and reordered drops, immediate locks, context restoration, unsupported maps and disconnect/reconnect. Collision pixels are checked against the previous GridNavigator painter on full catalog maps and portal/blocked boundary fixtures. The real-main browser probes also check focus, item selection, coordinate drafts, programmatic settings writes/restoration, invalid settings drafts, bar widths and control state. Full local verification passed: build/typechecking, 3,525 frontend tests, 137 native tests (one optional public probe ignored), Clippy, formatting, 83 Node helper tests (one Linux-specific skip), and eight Python release tests. Independent review found no blocking findings.

Heap readings describe live JavaScript heap between observations, with garbage collection before/after each sample. They do not measure allocation volume, peak heap, process RSS, native canvas memory or GPU memory. Reconnect live-heap growth fell from 13.93 MB to 1.16 MB in this run; retained heap after collection remained approximately flat. Other workloads fluctuate with collection timing, so this result does not establish lower overall application memory. The new retained projections are bounded to 50 log entries, the current drop texts, permanent form controls and one current-map raster.

These are synchronous offline Chromium workloads. They do not establish native WebKit CPU, installed-app memory, real 500 ms game-status behavior, network reconnect, long-duration/minimized liveness or live game action acceptance. Those proof surfaces remain separate from this rendering comparison.
