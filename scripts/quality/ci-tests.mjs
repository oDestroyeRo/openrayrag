import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, lstat, readFile, realpath, mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { spawnSync } from 'node:child_process';
import { platforms, packageConfig, packageSmokes, assertArchitecture, installerFiles } from './ci-platform.mjs';
import { createReportDirectory, privateEnvironment, runReadOnly } from '../release/release-public-io.mjs';

const workflow=parse(await readFile(new URL('../../.github/workflows/release.yml',import.meta.url),'utf8'));
const release=parse(await readFile(new URL('../../.github/workflows/release-publish.yml',import.meta.url),'utf8'));
const planName='release-plan-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}';
const runtimeInstall='bun install --production --frozen-lockfile --ignore-scripts';

test('every release stage provisions locked runtime dependencies before root entrypoints without step credentials',()=>{
  for(const [name,{steps}] of Object.entries(release.jobs)){
    const setup=steps.findIndex(step=>step.uses?.startsWith('oven-sh/setup-bun@'));
    const runtime=steps.findIndex(step=>step.run===runtimeInstall);
    assert.ok(runtime>setup,name);
    assert.equal(steps[runtime].if,undefined,name);
    assert.equal(steps[runtime].env,undefined,name);
    const source=steps.map(step=>step.run??'').join('\n');
    assert.ok(source.indexOf(runtimeInstall)<source.indexOf('bun install --cwd tools/release'),name);
    for(const step of steps.filter(step=>/bun scripts\/(?:release\/release|quality\/ci-platform)\.mjs/.test(step.run??'')))
      assert.ok(runtime<steps.indexOf(step),name);
  }
});

test('a clean hosted checkout imports tooling with auto-install disabled and production-only root dependencies',async()=>{
  const parent=await createReportDirectory(),checkout=join(parent,'checkout');
  try{
    await mkdir(checkout);
    await cp(new URL('../',import.meta.url),join(checkout,'scripts'),{recursive:true});
    for(const name of ['package.json','bun.lock','bunfig.toml','release.config.mjs','release-policy-history.json','release-migration.json'])
      await writeFile(join(checkout,name),await readFile(new URL(`../../${name}`,import.meta.url)));
    await mkdir(join(checkout,'tools/release'),{recursive:true});
    for(const name of ['package.json','bun.lock','bunfig.toml'])
      await writeFile(join(checkout,'tools/release',name),await readFile(new URL(`../../tools/release/${name}`,import.meta.url)));
    for(const directory of [checkout,join(checkout,'tools/release')]){
      const manifest=JSON.parse(await readFile(join(directory,'package.json'),'utf8'));
      manifest.scripts={...manifest.scripts,postinstall:`${JSON.stringify(process.execPath)} -e "require('node:fs').writeFileSync('lifecycle-ran','unsafe')"`};
      await writeFile(join(directory,'package.json'),JSON.stringify(manifest));
    }
    const options={cwd:checkout,env:privateEnvironment(parent)};
    const isolated=release.jobs.publish.steps.find(step=>step.run==='bun install --cwd tools/release --frozen-lockfile --ignore-scripts');
    runReadOnly(process.execPath,isolated.run.split(' ').slice(1),options);
    const unavailable=spawnSync(process.execPath,['--no-install','--eval','await import("./scripts/release/release.mjs");'],{...options,encoding:'utf8',timeout:30_000});
    assert.notEqual(unavailable.status,0);
    assert.match(unavailable.stderr,/Cannot find (?:package|module).*remeda/);

    // Rebuild the isolated tools in the corrected hosted order as well.
    await rm(join(checkout,'tools/release/node_modules'),{recursive:true});
    runReadOnly(process.execPath,runtimeInstall.split(' ').slice(1),options);
    runReadOnly(process.execPath,isolated.run.split(' ').slice(1),options);
    const proof=`import assert from 'node:assert/strict';
      const release=await import('./scripts/release/release.mjs');
      const dependabot=await import('./scripts/quality/dependabot-auto-merge.mjs');
      assert.equal(typeof release.GitHubReleaseApi,'function');
      assert.equal(typeof dependabot.mergeDependabotUpdate,'function');
      const {planRelease,bumpVersion}=await import('./scripts/release/semantic-release-plan.mjs');
      const {migrationBridge:bridge}=await import('./scripts/release/release-policy.mjs');
      const sourceSha='a'.repeat(40),commits=[{hash:sourceSha,message:'fix: resolve hosted policy dependencies'}];
      const result=await planRelease({source:{sourceSha,firstParentCount:bridge.firstParentCount+1,pubDate:'2026-10-06T00:00:00.000Z'},published:{sourceSha:bridge.sourceSha,version:bridge.version,tag:bridge.tag},reservation:null,analysisCommits:commits,notesCommits:commits});
      assert.equal(result.state,'release');assert.equal(result.plan.version,bumpVersion(bridge.version,'patch'));
      assert.match(result.plan.notes,/resolve hosted policy dependencies/);`;
    const imported=spawnSync(process.execPath,['--no-install','--eval',proof],{...options,encoding:'utf8',timeout:30_000});
    assert.equal(imported.error,undefined);
    assert.equal(imported.status,0,imported.stderr);
    assert.equal(imported.stdout,'');
    assert.equal(imported.stderr,'');
    assert.equal((await lstat(join(checkout,'node_modules'))).isSymbolicLink(),false);
    assert.notEqual(await realpath(join(checkout,'node_modules')),await realpath(join(checkout,'tools/release/node_modules')));
    for(const name of ['esbuild','typescript','vite','vitest','yaml','@tauri-apps/cli'])
      await assert.rejects(lstat(join(checkout,'node_modules',name)),{code:'ENOENT'});
    for(const directory of [checkout,join(checkout,'tools/release')])
      await assert.rejects(lstat(join(directory,'lifecycle-ran')),{code:'ENOENT'});
    for(const name of ['bun.lock','tools/release/bun.lock'])
      assert.deepEqual(await readFile(join(checkout,name)),await readFile(new URL(`../../${name}`,import.meta.url)));
  }finally{await rm(parent,{recursive:true,force:true});}
});

test('main PRs and merge queue always run all native platform lanes',()=>{
  assert.deepEqual(workflow.on.pull_request.branches,['main']);
  assert.ok(Object.hasOwn(workflow.on,'merge_group'));
  const quality=workflow.jobs.quality;
  assert.equal(quality.strategy['fail-fast'],false);
  assert.deepEqual(quality.strategy.matrix.include.map(x=>[x.platform,x.target]),Object.entries(platforms).map(([name,s])=>[name,s.target]));
  assert.equal(quality.if,undefined);
  const source=quality.steps.map(x=>x.run||'').join('\n');
  for(const command of ['bun install --frozen-lockfile','bun run check','ci-platform.mjs build'])assert.ok(source.includes(command),command);
  assert.ok(source.includes('xvfb-run'));
  assert.ok(source.indexOf('bun install --frozen-lockfile') < source.indexOf('bun run check'));
  assert.ok(!source.includes('cargo test')); // One owning source-check entry point.
  const smoke=quality.steps.filter(step=>step.run?.includes('scripts/quality/ci-platform.mjs build'));
  assert.equal(smoke.length,2);
  for(const step of smoke)assert.ok(step.run.endsWith('--smoke'));

});

test('quality warms the trusted release dependency cache for each platform without caching application outputs',()=>{
  const cacheOf=job=>job.steps.find(step=>step.uses?.startsWith('Swatinem/rust-cache@')).with;
  const quality=cacheOf(workflow.jobs.quality);
  const mac=cacheOf(release.jobs.build);
  const other=cacheOf(release.jobs['release-platforms']);
  const vendorKey="${{ hashFiles('vendor/glib/**') }}";
  for(const cache of [quality,mac,other]){
    assert.equal(cache.workspaces,'src-tauri');
    // The pinned action ignores `key` when a `shared-key` is present.
    assert.equal(cache.key,undefined);
    assert.ok(cache['shared-key'].endsWith('-'+vendorKey));
    assert.notEqual(cache['cache-workspace-crates'],true);
    assert.notEqual(cache['cache-all-crates'],true);
    assert.notEqual(cache['add-rust-environment-hash-key'],false);
  }
  assert.equal(quality['shared-key'],'desktop-${{ matrix.target }}-'+vendorKey);
  assert.equal(other['shared-key'],quality['shared-key']);
  assert.equal(mac['shared-key'],quality['shared-key'].replace('${{ matrix.target }}',platforms.macos.target));
  const artifact=workflow.jobs.quality.steps.find(step=>step.uses?.startsWith('actions/upload-artifact@'));
  assert.equal(artifact.if,'always()');
  assert.equal(artifact.with['compression-level'],0);
  assert.ok(artifact.with.path.includes('reports/*'));
});

test('Bun download caches are shared across installation jobs while complete trusted quality lanes alone write them',()=>{
  const quality=workflow.jobs.quality;
  const restoreOf=job=>job.steps.find(step=>step.id==='bun-cache');
  const restore=restoreOf(quality);
  assert.equal(workflow.env.BUN_INSTALL_CACHE_DIR,'${{ github.workspace }}/../rayrag-bun-cache');
  assert.equal(release.env.BUN_INSTALL_CACHE_DIR,workflow.env.BUN_INSTALL_CACHE_DIR);
  assert.equal(restore.with.path,'${{ env.BUN_INSTALL_CACHE_DIR }}');
  assert.equal(restore.uses,'actions/cache/restore@v6.1.0');
  assert.equal(restore.with.key,"bun-packages-v1-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('.bun-version') }}-${{ hashFiles('bun.lock', 'tools/release/bun.lock') }}");
  assert.equal(restore.with['restore-keys'],"bun-packages-v1-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('.bun-version') }}-");
  assert.notEqual(restore.with['fail-on-cache-miss'],true);
  assert.notEqual(restore.with.enableCrossOsArchive,true);
  for(const job of [quality,...Object.values(release.jobs)]){
    assert.deepEqual(restoreOf(job).with,restore.with);
    const firstInstall=job.steps.findIndex(step=>step.run?.includes('bun install'));
    assert.ok(job.steps.indexOf(restoreOf(job))<firstInstall);
    assert.ok(job.steps[firstInstall].run.includes('--frozen-lockfile'));
  }
  const save=quality.steps.find(step=>step.uses==='actions/cache/save@v6.1.0'&&step.with.path===restore.with.path);
  assert.equal(save.with.key,'${{ steps.bun-cache.outputs.cache-primary-key }}');
  assert.equal(save.if,"github.repository == 'oDestroyeRo/openrayrag' && github.ref == 'refs/heads/main' && steps.bun-cache.outputs.cache-hit != 'true'");
  assert.ok(quality.steps.indexOf(save)>quality.steps.findIndex(step=>step.run?.includes('bun run check')));
  for(const job of Object.values(release.jobs))assert.ok(!job.steps.some(step=>step.uses?.startsWith('actions/cache/save@')));
});

test('Tauri tool reuse stays within platform and locked tool versions and still builds and smokes on misses',()=>{
  const quality=workflow.jobs.quality,releaseJob=release.jobs['release-platforms'];
  const restore=quality.steps.find(step=>step.id==='tauri-cache');
  assert.equal(restore.if,"matrix.platform != 'macos'");
  assert.equal(restore.uses,'actions/cache/restore@v6.1.0');
  assert.equal(restore.with.path,'~/.cache/tauri\n~/AppData/Local/tauri\n');
  assert.equal(restore.with.key,"tauri-tools-v1-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('bun.lock', 'src-tauri/Cargo.lock') }}");
  assert.equal(restore.with['restore-keys'],undefined);
  assert.notEqual(restore.with['fail-on-cache-miss'],true);
  assert.notEqual(restore.with.enableCrossOsArchive,true);
  assert.deepEqual(releaseJob.steps.find(step=>step.id==='tauri-cache').with,restore.with);
  for(const job of [quality,releaseJob]){
    const build=job.steps.find(step=>step.run?.includes('ci-platform.mjs build'));
    assert.ok(job.steps.indexOf(job.steps.find(step=>step.id==='tauri-cache'))<job.steps.indexOf(build));
    assert.ok(!(build.if??'').includes('cache-hit'));
  }
  const save=quality.steps.find(step=>step.uses==='actions/cache/save@v6.1.0'&&step.with.key.includes('tauri-cache'));
  assert.equal(save.with.path,restore.with.path);
  assert.equal(save.with.key,'${{ steps.tauri-cache.outputs.cache-primary-key }}');
  assert.equal(save.if,"matrix.platform != 'macos' && github.repository == 'oDestroyeRo/openrayrag' && github.ref == 'refs/heads/main' && steps.tauri-cache.outputs.cache-hit != 'true'");
  for(const smoke of quality.steps.filter(step=>step.run?.includes('--smoke')))
    assert.ok(quality.steps.indexOf(save)>quality.steps.indexOf(smoke));
});

test('aggregate cannot report success after failed, cancelled, skipped or missing lanes',()=>{
  const gate=workflow.jobs.verify;
  assert.equal(gate.name,'CI / required');assert.deepEqual(gate.needs,['quality','security']);assert.equal(gate.if,'always()');
  assert.equal(gate.steps.length,1);
  assert.equal(gate.steps[0].env.QUALITY_RESULT,'${{ needs.quality.result }}');
  assert.equal(gate.steps[0].env.SECURITY_RESULT,'${{ needs.security.result }}');
  assert.equal(gate.steps[0].run,'test "$QUALITY_RESULT" = success && test "$SECURITY_RESULT" = success');
  assert.equal(workflow.jobs.release.needs,'verify');
  assert.equal(release.jobs.reconcile.needs,undefined);
  assert.equal(release.jobs.build.needs,'reconcile');
  assert.deepEqual(release.jobs.assemble.needs,['reconcile','build','release-platforms']);
  assert.deepEqual(release.jobs.publish.needs,['reconcile','assemble']);
});
test('only trusted main signs and centrally publishes every platform',()=>{
  assert.ok(workflow.jobs.release.if.includes("github.ref == 'refs/heads/main'"));
  assert.ok(workflow.jobs.release.if.includes("github.event_name == 'push'"));
  for(const name of ['reconcile','release-platforms','build','assemble','publish']){
    assert.ok(release.jobs[name].if.includes("github.ref == 'refs/heads/main'"));
    assert.ok(release.jobs[name].if.includes("github.event_name == 'push'"));
    assert.equal(release.jobs[name].environment,'release');
  }
  const jobs=Object.entries(release.jobs).filter(([,job])=>JSON.stringify(job).includes('secrets.TAURI_SIGNING_PRIVATE_KEY'));
  assert.deepEqual(jobs.map(([name])=>name),['build']);
  for(const job of [...Object.values(workflow.jobs),...Object.values(release.jobs)])for(const step of job.steps||[]){
    if(step.uses)assert.match(step.uses,/^(actions|github)\//.test(step.uses)?/@v\d+\.\d+\.\d+$/:/@[a-f0-9]{40}$/);
    if(step.uses?.startsWith('actions/checkout@')){assert.equal(step.with.ref,'${{ github.sha }}');assert.equal(step.with['persist-credentials'],false);}
  }
  for(const platform of ['windows','linux'])assert.ok(release.jobs.assemble.steps.some(s=>s.with?.path===`platform-bundles/${platform}`));
});

test('the reusable release admits only the environment signing names and rejects an empty key before building',()=>{
  const names=['TAURI_SIGNING_PRIVATE_KEY','TAURI_SIGNING_PRIVATE_KEY_PASSWORD'];
  assert.deepEqual(Object.keys(workflow.jobs.release.secrets).sort(),names);
  assert.deepEqual(Object.keys(release.on.workflow_call.secrets).sort(),names);
  for(const name of names){
    assert.equal(workflow.jobs.release.secrets[name],'${{ secrets.'+name+' }}');
    // The caller has no environment binding: the callee's release environment
    // supplies these values. Presence is required at runtime, not at the call.
    assert.equal(release.on.workflow_call.secrets[name].required,false);
  }
  const guard=release.jobs.build.steps[0];
  assert.deepEqual(guard.env,{TAURI_SIGNING_PRIVATE_KEY:'${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}'});
  for(const key of ['', 'synthetic-signing-input-only']){
    const result=spawnSync('bash',['-c',guard.run],{
      env:{...process.env,TAURI_SIGNING_PRIVATE_KEY:key},encoding:'utf8',
    });
    assert.equal(result.status,key?0:1);
    assert.ok(!`${result.stdout}${result.stderr}`.includes('synthetic-signing-input-only'));
    if(!key)assert.match(result.stdout+result.stderr,/signing key is unavailable/);
  }
});

test('parallel production builders join before source-bound bundle verification and preserve draft recovery',()=>{
  const {build,assemble,publish}=release.jobs;
  assert.equal(release.jobs['release-platforms'].needs,'reconcile');
  const mac=build.steps.find(step=>step.uses?.startsWith('actions/upload-artifact@'));
  assert.equal(mac.with.name,'signed-macos-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}');
  assert.ok(mac.with.path.includes('macos/*.app.tar.gz'));
  assert.ok(mac.with.path.includes('macos/*.app.tar.gz.sig'));
  assert.ok(mac.with.path.includes('dmg/*.dmg'));
  assert.ok(!mac.with.path.includes('*.app\n'));
  assert.equal(mac.with.archive,true);
  const downloads=assemble.steps.filter(step=>step.uses?.startsWith('actions/download-artifact@')&&step.with.name!==planName);
  assert.deepEqual(downloads.map(step=>step.with.name),[
    mac.with.name,
    'platform-windows-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}',
    'platform-linux-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}',
  ]);
  assert.equal(downloads[0].with.path,'src-tauri/target/aarch64-apple-darwin/release/bundle');
  const prepare=assemble.steps.findIndex(step=>step.run==='bun scripts/release/release.mjs prepare');
  for(const step of downloads)assert.ok(assemble.steps.indexOf(step)<prepare);
  assert.ok(assemble.steps.slice(0,prepare).some(step=>step.run==='bun scripts/release/release.mjs stamp'));
  assert.ok(assemble.steps.slice(0,prepare).some(step=>step.run?.includes('rustup toolchain install')));
  assert.ok(assemble.steps.some(step=>step.if==="needs.reconcile.outputs.state == 'reuse'"&&step.run==='bun scripts/release/release.mjs restore'));
  for(const name of ['artifact-id','artifact-run-id','artifact-digest']) {
    assert.ok(assemble.outputs[name].includes(`needs.reconcile.outputs.${name}`));
  }
  assert.ok(!JSON.stringify(assemble).includes('secrets.'));
  const restore=publish.steps.find(step=>step.run==='bun scripts/release/release.mjs restore');
  assert.equal(restore.env.RELEASE_ARTIFACT_ID,'${{ needs.assemble.outputs.artifact-id }}');
  assert.equal(restore.env.RELEASE_ARTIFACT_RUN_ID,'${{ needs.assemble.outputs.artifact-run-id }}');
  assert.equal(restore.env.RELEASE_ARTIFACT_DIGEST,'${{ needs.assemble.outputs.artifact-digest }}');
  assert.equal(restore.if,"needs.reconcile.outputs.state != 'published'");
});

test('one reusable main release call queues the entire trusted lifecycle without an inner lock',()=>{
  assert.deepEqual(Object.keys(workflow.jobs),['security','quality','verify','release']);
  const caller=workflow.jobs.release;
  assert.equal(caller.uses,'./.github/workflows/release-publish.yml');
  assert.deepEqual(caller.permissions,{contents:'write',actions:'read'});
  assert.deepEqual(caller.concurrency,{group:'rayrag-release-publication',queue:'max','cancel-in-progress':false});
  assert.notEqual(caller.secrets,'inherit');
  assert.equal(caller.environment,undefined);
  assert.deepEqual(Object.keys(release.on),['workflow_call']);
  assert.deepEqual(Object.keys(release.on.workflow_call),['secrets']);
  assert.equal(release.concurrency,undefined);
  assert.deepEqual(release.env,workflow.env);
  for(const job of Object.values(release.jobs))assert.equal(job.concurrency,undefined);
  assert.deepEqual(release.jobs.reconcile.permissions,{contents:'write'});
  for(const name of ['build','release-platforms','assemble'])assert.deepEqual(release.jobs[name].permissions,{contents:'read',actions:'read'});
  assert.deepEqual(release.jobs.publish.permissions,{contents:'write',actions:'read'});
});

test('every active release stage installs policy tools and receives the same reserved plan before effects',()=>{
  const {reconcile}=release.jobs;
  const preflight=reconcile.steps.find(step=>step.id==='preflight');
  assert.equal(preflight.run,'bun install --cwd tools/release --frozen-lockfile --ignore-scripts\nbun scripts/release/release.mjs preflight\n');
  const upload=reconcile.steps.find(step=>step.uses?.startsWith('actions/upload-artifact@'));
  assert.equal(upload.if,"steps.preflight.outputs.state != 'skip'");
  assert.equal(upload.with.name,planName);
  assert.equal(upload.with.path,'release-plan.json');
  assert.equal(upload.with['if-no-files-found'],'error');
  assert.equal(upload.with.overwrite,false);
  assert.ok(reconcile.steps.indexOf(upload)>reconcile.steps.indexOf(preflight));
  for(const name of ['build','release-platforms','assemble','publish']){
    const {steps}=release.jobs[name];
    const plan=steps.find(step=>step.uses?.startsWith('actions/download-artifact@')&&step.with.name===planName);
    assert.ok(plan,name);assert.equal(plan.with.path,'.');assert.equal(plan.if,undefined);
    const install=steps.findIndex(step=>step.run==='bun install --cwd tools/release --frozen-lockfile --ignore-scripts');
    assert.ok(install>=0,name);
    for(const step of steps.filter(step=>step.run?.includes('bun scripts/release/release.mjs')||step.run?.includes('bun scripts/quality/ci-platform.mjs'))){
      assert.ok(steps.indexOf(plan)<steps.indexOf(step),name);
      assert.ok(install<steps.indexOf(step),name);
    }
  }
});

test('skip, reuse and published plans never admit signing and failed builders cannot assemble',()=>{
  const context={repository:'oDestroyeRo/openrayrag',ref:'refs/heads/main',event_name:'push'};
  const allowed=(expression,state,build='success',platforms='success',reconcile='success',github=context,assemble='success')=>{
    const needs={reconcile:{result:reconcile,outputs:{state}},build:{result:build},platforms:{result:platforms},assemble:{result:assemble}};
    return Function('github','needs','always',`return (${expression.replaceAll('needs.release-platforms','needs.platforms')});`)(github,needs,()=>true);
  };
  for(const state of ['build','reuse','published','skip']){
    for(const name of ['build','release-platforms'])assert.equal(allowed(release.jobs[name].if,state),state==='build');
    assert.equal(allowed(release.jobs.assemble.if,state),state!=='skip');
    assert.equal(allowed(release.jobs.publish.if,state),state!=='skip');
    for(const github of [{...context,ref:'refs/pull/1/merge',event_name:'pull_request'},{...context,event_name:'merge_group'},{...context,repository:'other/repo'}]){
      for(const job of Object.values(release.jobs))assert.equal(allowed(job.if,state,'success','success','success',github),false);
    }
  }
  for(const result of ['failure','cancelled','skipped','']){
    assert.equal(allowed(release.jobs.assemble.if,'build',result),false);
    assert.equal(allowed(release.jobs.assemble.if,'build','success',result),false);
    assert.equal(allowed(release.jobs.assemble.if,'reuse','skipped','skipped',result),false);
    assert.equal(allowed(release.jobs.publish.if,'reuse','skipped','skipped',result),false);
    assert.equal(allowed(release.jobs.publish.if,'build','success','success','success',context,result),false);
  }
  assert.ok(release.jobs.publish.if.startsWith('always()'));
  const signing=release.jobs.build.steps.filter(step=>JSON.stringify(step).includes('secrets.'));
  assert.equal(signing.length,2);
  for(const step of signing)assert.equal(step.if,"needs.reconcile.outputs.state == 'build'");
});

test('package smokes overlap, require both successes and finish cleanup before reporting a failure', async () => {
  const packages=[{binary:'deb',report:'deb.json'},{binary:'appimage',report:'appimage.json'}];
  for(const failing of [null,'deb','appimage']) {
    const started=[],finished=[],release=new Map();
    const check=async (binary,report)=>{
      started.push([binary,report]);
      await new Promise(resolve=>release.set(binary,resolve));
      finished.push(binary);
      if(binary===failing)throw new Error(`${binary} smoke failed`);
    };
    let settled=false;
    const outcome=packageSmokes(packages,check).then(()=>{settled=true;return null;},error=>{settled=true;return error;});
    assert.deepEqual(started,[['deb','deb.json'],['appimage','appimage.json']]);
    release.get('deb')();
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(settled,false);
    release.get('appimage')();
    const error=await outcome;
    assert.deepEqual(finished,['deb','appimage']);
    if(failing) {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length,1);
      assert.equal(error.errors[0].message,`${failing} smoke failed`);
    } else assert.equal(error,null);
  }
});
test('smoke packages support startup queries without gameplay or installation privileges',async()=>{
  for(const platform of Object.keys(platforms)){
    const c=packageConfig(platform,true);
    assert.equal(c.identifier,'com.rayrag.companion.ci');
    assert.deepEqual(c.app.security.capabilities,['ci-smoke']);assert.equal(c.bundle.createUpdaterArtifacts,false);
    assert.equal(packageConfig(platform,false).identifier,undefined);
  }
  assert.throws(()=>packageConfig('unknown',false));
  const capability=JSON.parse(await readFile(new URL('../../src-tauri/capabilities/ci-smoke.json',import.meta.url),'utf8'));
  assert.deepEqual(capability.webviews,['main']);
  assert.deepEqual(capability.permissions.toSorted(),[
    'core:event:allow-listen','core:event:allow-unlisten','core:window:allow-close',
    'allow-ci-smoke-report','allow-current-form','allow-save-current-form',
    'allow-settings-close-ready','allow-settings-close-cancel','allow-settings-close-complete',
    'allow-saved-login','allow-update-initialized','allow-update-status',
    'allow-update-startup-stopped','allow-update-continuation',
  ].toSorted());
});
test('application payload checks reject wrong architecture and truncated headers',()=>{
  const pe=Buffer.alloc(128);pe.write('MZ');pe.writeUInt32LE(64,60);pe.write('PE\0\0',64);pe.writeUInt16LE(0x8664,68);pe.writeUInt16LE(0x20b,88);
  assertArchitecture(pe,platforms.windows.target);pe.writeUInt16LE(0x14c,68);assert.throws(()=>assertArchitecture(pe,platforms.windows.target));
  const elf=Buffer.alloc(64);elf.set([127,69,76,70,2,1]);elf.writeUInt16LE(62,18);assertArchitecture(elf,platforms.linux.target);
  elf.writeUInt16LE(183,18);assert.throws(()=>assertArchitecture(elf,platforms.linux.target));
  for(const target of [platforms.windows.target,platforms.linux.target])assert.throws(()=>assertArchitecture(Buffer.alloc(4),target));
});

test('installer discovery ignores linked AppDir staging while retaining both Linux packages',async()=>{
  const root=await mkdtemp(join(tmpdir(),'rayrag-package-fixture-'));
  try {
    await mkdir(join(root,'deb'));await mkdir(join(root,'appimage','Rayrag.AppDir'),{recursive:true});
    await writeFile(join(root,'deb','app.deb'),'deb');await writeFile(join(root,'appimage','app.AppImage'),'image');
    await symlink(join(root,'deb'),join(root,'appimage','Rayrag.AppDir','staging-link'),process.platform==='win32'?'junction':'dir');
    assert.deepEqual((await installerFiles('linux',root)).map(path=>path.slice(root.length+1).replaceAll('\\','/')).sort(),['appimage/app.AppImage','deb/app.deb']);
  }finally{await rm(root,{recursive:true,force:true});}
});
