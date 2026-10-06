# Client rendering performance

Issue [#117](https://github.com/oDestroyeRo/openrayrag/issues/117) tracks lower client CPU and rendering churn while preserving controls, settings and telemetry. The changes retain unchanged activity/drop rows, keep canvas backing dimensions stable, redraw only changed map overlays, paint collision without allocating route-planning structures, reuse the dashboard settings snapshot, and retain permanent field references while reading current DOM values. Dynamic rule rows, admission, locks, native status publication and periodic refresh cadence remain live.

## Repeatable offline benchmark

Install the locked dependencies with `bun install --frozen-lockfile` and use Bun 1.4.2, plus Chrome/Chromium. The default executable is `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`; override it with `--chrome /path/to/chrome` or `CHROME_PATH`. This is a manual benchmark, with no CI timing gate.

```sh
bun scripts/benchmarks/benchmark-client-rendering.mjs --ref 3bf3f4daa0f9172340af22d05ee6562f986c74c0 --output /tmp/rayrag-client-rendering-baseline.json
bun scripts/benchmarks/benchmark-client-rendering.mjs --compare /tmp/rayrag-client-rendering-baseline.json --output /tmp/rayrag-client-rendering-candidate.json
```

The first command bundles `src/` from the baseline commit. The second bundles the working tree with the same harness. Both load actual `src/app/main.ts`, FeatureUi, SettingsForm and BotConsole in a fresh temporary browser profile. Tauri IPC is replaced only inside the benchmark bundle by strict synthetic commands and events; no app, game connection, account credentials or existing browser profile is accessed.

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

## Settings projection comparison, 2026-10-06

Issue [#170](https://github.com/oDestroyeRo/openrayrag/issues/170) concentrates display parsing in SettingsForm. Each synchronous status or control-lock pass creates a projection that refreshes observations once and shares one current DOM read between retained settings, eligible field settings and FeatureUi display consumers. The projection is discarded after that pass. Standalone command and CurrentForm reads remain fresh, and admission still validates settings. Invalid drafts remain editable; programmatic writes and restores require no input event to be observed by the next pass.

The baseline is clean commit `641f81b55febe988bcaf8530a7021691f0225f28`. The candidate includes the integrated changes for issues #170–#173. Both reports use the existing unchanged harness, five timed samples and 100 iterations (ten reconnect cycles), on the Apple M5 Pro machine above with Bun 1.4.2 and Chrome 154.0.8037.98. All six visible outcomes match and all five real-main behavior probes pass.

| Workload | Baseline replay ms | Candidate replay ms | FeatureUi reads, baseline → candidate | SettingsForm refreshes, baseline → candidate |
| --- | ---: | ---: | ---: | ---: |
| 100 unchanged statuses | 106.9 | 92.5 | 600 → 100 | 200 → 100 |
| 100 HP/counter updates | 106.6 | 90.9 | 600 → 100 | 200 → 100 |
| 100 actor/drop/route updates | 107.5 | 89.3 | 600 → 100 | 200 → 100 |
| 100 appended/edited log updates | 192.0 | 178.5 | 600 → 100 | 200 → 100 |
| 100 periodic refresh callbacks | 69.6 | 62.9 | 300 → 100 | 100 → 100 |
| 10 disconnect/reconnect cycles | 62.9 | 55.2 | 120 → 50 | 40 → 20 |

Times are measured whole-renderer medians, not settings-only costs or timing gates. The baseline report is `/var/folders/wj/st7vb06d6yl1k22r6c80wd200000gn/T/rayrag-client-rendering-report-iPBb0T/report.json`; the candidate is `/var/folders/wj/st7vb06d6yl1k22r6c80wd200000gn/T/rayrag-client-rendering-report-S6IlxO/report.json`. Their loaded-source hashes are `3a35664c6a2053c7be2e0dd7240c619a789a3e3762f462af1ee3f59b28806b61` and `77dde43acb69afdaceb86607c2bb2d063220230aca27e5ff206d931760e9eaf6`, with harness/dependency hash `dfdb3fbeebe424006ff77d8ce1bda235560551d0009e4ce2cfa736f932942dc6`.

The integrated `bun run check` passed: build/typechecking, 4,231 frontend tests, 182 default and 184 ci-smoke native tests (two ignored in each configuration), Clippy in both configurations, formatting, 243 helper tests (two platform skips), and eight Python release tests. Independent standards and specification reviews found no blocking findings. These checks do not establish deployed or live-game performance.

## Correctness and proof limits

The focused 140-test run covers bounded log append/rollover, same-length text/timestamp edits, literal text safety, in-place and fractional actor/drop coordinates, route/leg/goal changes, metadata-only updates, unchanged and reordered drops, immediate locks, context restoration, unsupported maps and disconnect/reconnect. Collision pixels are checked against the previous GridNavigator painter on full catalog maps and portal/blocked boundary fixtures. The real-main browser probes also check focus, item selection, coordinate drafts, programmatic settings writes/restoration, invalid settings drafts, bar widths and control state. Full local verification passed: build/typechecking, 3,525 frontend tests, 137 native tests (one optional public probe ignored), Clippy, formatting, 83 Node helper tests (one Linux-specific skip), and eight Python release tests. Independent review found no blocking findings.

Heap readings describe live JavaScript heap between observations, with garbage collection before/after each sample. They do not measure allocation volume, peak heap, process RSS, native canvas memory or GPU memory. Reconnect live-heap growth fell from 13.93 MB to 1.16 MB in this run; retained heap after collection remained approximately flat. Other workloads fluctuate with collection timing, so this result does not establish lower overall application memory. The new retained projections are bounded to 50 log entries, the current drop texts, permanent form controls and one current-map raster.

These are synchronous offline Chromium workloads. They do not establish native WebKit CPU, installed-app memory, real 500 ms game-status behavior, network reconnect, long-duration/minimized liveness or live game action acceptance. Those proof surfaces remain separate from this rendering comparison.
