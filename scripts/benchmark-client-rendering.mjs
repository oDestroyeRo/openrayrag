import { fromEntries, map, sort } from 'remeda';
// Offline renderer benchmark: bun scripts/benchmark-client-rendering.mjs
//   [--ref HEAD] [--output /tmp/baseline.json] [--compare /tmp/baseline.json]
//   [--samples 5] [--iterations 100] [--chrome /path/to/chrome]
// --ref bundles src/ from that commit; omitted bundles the working tree. The
// harness stays current, so the same workload runs against baseline and candidate.
// No timing pass/fail gates: compare work counters, output parity and sample medians.
// Explicit --output files must not already exist.
import { build } from 'esbuild';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rendererOptions, compareRenderingReports, median } from './benchmark-policy.mjs';

export async function writeBenchmarkReport(report, requestedOutput) {
  const output = requestedOutput ? resolve(requestedOutput)
    : join(await mkdtemp(join(tmpdir(), 'rayrag-client-rendering-report-')), 'report.json');
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return output;
}

export async function runBenchmark(args = process.argv.slice(2)) {
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { options, samples, iterations } = rendererOptions(args);
const commit = execFileSync('git', ['rev-parse', '--verify', `${options.get('--ref') ?? 'HEAD'}^{commit}`], { cwd: root, encoding: 'utf8' }).trim();
const chromePath = options.get('--chrome') ?? process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const temporary = await mkdtemp(join(tmpdir(), 'rayrag-client-rendering-'));
const sourceHashes = new Map();
const harnessFiles = ['scripts/benchmark-client-rendering.mjs', 'scripts/benchmark-policy.mjs', 'scripts/client-rendering-fixture.ts', 'scripts/client-rendering-native.ts', 'bun.lock'];
const harnessHash = createHash('sha256');
for (const file of harnessFiles) harnessHash.update(file).update(await readFile(join(root, file)));
const harness = { files: harnessFiles, hash: harnessHash.digest('hex') };
let chrome, server, cdp;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

class DevTools {
  pending = new Map(); sequence = 0; errors = [];
  constructor(socket) {
    this.socket = socket;
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.method === 'Runtime.exceptionThrown') this.errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
      if (!message.id) return;
      const pending = this.pending.get(message.id); if (!pending) return;
      this.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error))); else pending.resolve(message.result);
    });
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`DevTools timeout: ${method}`)); }, 60000);
      this.pending.set(id, { resolve, reject, timer }); this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  }
}
const metrics = async () => fromEntries(map((await cdp.send('Performance.getMetrics')).metrics, ({ name, value }) => [name, value]));
try {
  await build({ entryPoints: [join(root, 'scripts/client-rendering-fixture.ts')], bundle: true, format: 'esm', platform: 'browser', target: 'chrome120', loader: { '.svg': 'text' }, outfile: join(temporary, 'bundle.js'), logLevel: 'silent',
    plugins: [{ name: 'offline-native-and-source', setup(builder) {
      builder.onResolve({ filter: /^@tauri-apps\/api\/(core|event)$/ }, () => ({ path: join(root, 'scripts/client-rendering-native.ts') }));
      builder.onLoad({ filter: /\/src\/.*\.(ts|json|css)$/ }, async ({ path }) => {
        const file = relative(root, path);
        const contents = options.has('--ref') ? execFileSync('git', ['show', `${commit}:${file}`], { cwd: root, encoding: 'utf8', maxBuffer: 32000000 }) : await readFile(path, 'utf8');
        sourceHashes.set(file, createHash('sha256').update(contents).digest('hex'));
        return { contents, loader: path.endsWith('.json') ? 'json' : path.endsWith('.css') ? 'css' : 'ts' };
      });
    } }] });
  const html = '<!doctype html><html lang="en"><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Offline RayRag renderer benchmark</title><link rel="stylesheet" href="/bundle.css"><div id="app"></div><script type="module" src="/bundle.js"></script></html>';
  server = createServer(async (request, response) => {
    try {
      if (request.url === '/') { response.setHeader('Content-Type', 'text/html'); response.end(html); return; }
      if (request.url === undefined || !['/bundle.js', '/bundle.css'].includes(request.url)) { response.writeHead(404).end(); return; }
      response.setHeader('Content-Type', request.url.endsWith('.css') ? 'text/css' : 'text/javascript');
      response.end(await readFile(join(temporary, request.url.slice(1))));
    } catch { response.writeHead(500).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  chrome = spawn(chromePath, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${join(temporary, 'profile')}`, '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-extensions', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
  chrome.on('error', error => { console.error(error.message); });
  let port;
  for (let attempt = 0; attempt < 200; attempt++) {
    try { port = Number((await readFile(join(temporary, 'profile/DevToolsActivePort'), 'utf8')).split('\n')[0]); break; } catch { await pause(50); }
  }
  if (!port) throw new Error('Chrome did not expose DevTools. Set --chrome to a Chrome/Chromium executable.');
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  if (typeof target !== 'object' || target === null || !('webSocketDebuggerUrl' in target) || typeof target.webSocketDebuggerUrl !== 'string') throw new Error('Chrome did not expose a target WebSocket.');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  cdp = new DevTools(socket);
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable'); await cdp.send('Performance.enable');
  await cdp.send('Emulation.setTimezoneOverride', { timezoneId: 'UTC' });
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
  let ready = false;
  for (let attempt = 0; attempt < 200; attempt++) {
    if (cdp.errors.length) throw new Error(cdp.errors.join('\n'));
    ready = await cdp.evaluate('window.clientRenderingBenchmark?.ready === true'); if (ready) break; await pause(50);
  }
  if (!ready) throw new Error('Benchmark fixture did not initialize.');
  const browser = await cdp.send('Browser.getVersion');
  /** @type {import("./tooling-domain-values.mjs").RenderingReport} */
  const report = { schemaVersion: 2, harness, createdAt: new Date().toISOString(), source: { commit, mode: options.has('--ref') ? 'commit' : 'working-tree', loadedSourceHash: createHash('sha256').update(JSON.stringify(sort([...sourceHashes], (a, b) => String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0))).digest('hex'), dirty: execFileSync('git', ['status', '--short', '--', 'src'], { cwd: root, encoding: 'utf8' }).trim() }, machine: { platform: platform(), release: release(), cpu: cpus()[0]?.model, cores: cpus().length, totalMemoryBytes: totalmem(), bun: process.versions.bun, browser: browser.product, viewport: [1280, 900], timezone: 'UTC' }, methodology: { samples, iterations, warmupSamples: 2, synchronousBurst: true, timers: 'Real main 1000ms callbacks run in explicit timer scenario; automatic periodic callbacks suspended.', instrumentation: 'Work counters collected in a separate instrumented pass; timed samples restore original methods and disconnect MutationObserver.', heap: 'JSHeapUsedSize before/after replay only with GC before and after; live heap is not peak allocation or native canvas memory.', cpu: 'CDP TaskDuration brackets replay only; setup and outcome pixel hashing run outside CPU/heap metrics. Renderer CPU seconds, not whole-app CPU percent.', timingGate: false }, workload: await cdp.evaluate('window.clientRenderingBenchmark.workload'), scenarios: [], probes: null };
  /** @type {readonly import('./tooling-domain-values.mjs').RenderingScenarioName[]} */
  const scenarios = ['steady', 'vitals', 'movement', 'logs', 'timer', 'reconnect'];
  for (const kind of scenarios) {
    const count = kind === 'reconnect' ? Math.min(iterations, 10) : iterations;
    await cdp.evaluate(`window.clientRenderingBenchmark.prepare(${JSON.stringify(kind)}, ${count})`);
    await cdp.evaluate('window.clientRenderingBenchmark.begin(true)');
    const work = await cdp.evaluate(`window.clientRenderingBenchmark.run(${JSON.stringify(kind)}, ${count})`);
    for (let warmup = 0; warmup < 2; warmup++) { await cdp.evaluate('window.clientRenderingBenchmark.begin()'); await cdp.evaluate(`window.clientRenderingBenchmark.run(${JSON.stringify(kind)}, ${count})`); }
    const rows = [];
    for (let sample = 0; sample < samples; sample++) {
      await cdp.evaluate('window.clientRenderingBenchmark.begin()');
      await cdp.send('HeapProfiler.collectGarbage'); const before = await metrics();
      const result = await cdp.evaluate(`window.clientRenderingBenchmark.run(${JSON.stringify(kind)}, ${count})`);
      const after = await metrics(); await cdp.send('HeapProfiler.collectGarbage'); const settled = await metrics();
      const outcome = await cdp.evaluate('window.clientRenderingBenchmark.outcome()');
      rows.push({ ...result, outcome, rendererTaskMs: (after.TaskDuration - before.TaskDuration) * 1000, heapBeforeBytes: before.JSHeapUsedSize, heapAfterBytes: after.JSHeapUsedSize, heapAfterGcBytes: settled.JSHeapUsedSize, heapGrowthBytes: after.JSHeapUsedSize - before.JSHeapUsedSize, retainedHeapDeltaBytes: settled.JSHeapUsedSize - before.JSHeapUsedSize });
    }
    /** @type {import("./tooling-domain-values.mjs").RenderingScenario} */
    const row = { name: kind, iterations: count, workCounters: work.counters, medianElapsedMs: median(map(rows, row => row.elapsedMs)), medianRendererTaskMs: median(map(rows, row => row.rendererTaskMs)), medianHeapGrowthBytes: median(map(rows, row => row.heapGrowthBytes)), medianRetainedHeapDeltaBytes: median(map(rows, row => row.retainedHeapDeltaBytes)), samples: rows };
    report.scenarios.push(row);
    console.log(`${kind}: ${row.medianElapsedMs.toFixed(2)}ms/${count}; renderer ${row.medianRendererTaskMs.toFixed(2)}ms; reads ${work.counters['FeatureUi.read'] ?? 0}; refresh ${work.counters['SettingsForm.refresh'] ?? 0}; created ${work.counters.elementsCreated ?? 0}; draws ${work.counters['canvas.drawImage'] ?? 0}`);
  }
  report.probes = await cdp.evaluate('window.clientRenderingBenchmark.probes()');
  if (cdp.errors.length) throw new Error(cdp.errors.join('\n'));
  const comparePath = options.get('--compare');
  if (comparePath !== undefined) {
    const baseline = JSON.parse(await readFile(resolve(comparePath), 'utf8'));
    report.comparison = compareRenderingReports(report, baseline);
  }
  const output = await writeBenchmarkReport(report, options.get('--output'));
  console.log(`Saved ${output}; ${report.probes?.passed.length} behavior probes passed.`);
} finally {
  cdp?.socket.close();
  if (chrome && chrome.exitCode === null) { chrome.kill('SIGTERM'); await Promise.race([new Promise(resolve => chrome.once('exit', resolve)), pause(5000)]); if (chrome.exitCode === null) chrome.kill('SIGKILL'); }
  if (server) await new Promise(resolve => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runBenchmark();
}
