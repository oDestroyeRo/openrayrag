import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { spawnSync } from 'node:child_process';
import { platforms, packageConfig, packageSmokes, assertArchitecture, installerFiles } from './ci-platform.mjs';

const workflow=parse(await readFile(new URL('../.github/workflows/release.yml',import.meta.url),'utf8'));
const release=parse(await readFile(new URL('../.github/workflows/release-publish.yml',import.meta.url),'utf8'));
const planName='release-plan-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}';
test('main PRs and merge queue always run all native platform lanes',()=>{
  assert.deepEqual(workflow.on.pull_request.branches,['main']);
  assert.ok(Object.hasOwn(workflow.on,'merge_group'));
  const quality=workflow.jobs.quality;
  assert.equal(quality.strategy['fail-fast'],false);
  assert.deepEqual(quality.strategy.matrix.include.map(x=>[x.platform,x.target]),Object.entries(platforms).map(([name,s])=>[name,s.target]));
  assert.equal(quality.if,undefined);
  const source=quality.steps.map(x=>x.run||'').join('\n');
  for(const command of ['npm ci','npm run check','ci-platform.mjs build'])assert.ok(source.includes(command),command);
  assert.ok(source.includes('xvfb-run'));
  assert.ok(source.indexOf('npm ci') < source.indexOf('npm run check'));
  assert.ok(!source.includes('cargo test')); // One owning source-check entry point.
  const smoke=quality.steps.filter(step=>step.run?.includes('scripts/ci-platform.mjs build'));
  assert.equal(smoke.length,2);
  for(const step of smoke)assert.ok(step.run.endsWith('--smoke'));

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
    if(step.uses)assert.match(step.uses,/@v\d+\.\d+\.\d+$/);
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
  const prepare=assemble.steps.findIndex(step=>step.run==='node scripts/release.mjs prepare');
  for(const step of downloads)assert.ok(assemble.steps.indexOf(step)<prepare);
  assert.ok(assemble.steps.slice(0,prepare).some(step=>step.run==='node scripts/release.mjs stamp'));
  assert.ok(assemble.steps.slice(0,prepare).some(step=>step.run?.includes('rustup toolchain install')));
  assert.ok(assemble.steps.some(step=>step.if==="needs.reconcile.outputs.state == 'reuse'"&&step.run==='node scripts/release.mjs restore'));
  for(const name of ['artifact-id','artifact-run-id','artifact-digest']) {
    assert.ok(assemble.outputs[name].includes(`needs.reconcile.outputs.${name}`));
  }
  assert.ok(!JSON.stringify(assemble).includes('secrets.'));
  const restore=publish.steps.find(step=>step.run==='node scripts/release.mjs restore');
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
  assert.equal(preflight.run,'npm ci --prefix tools/release\nnode scripts/release.mjs preflight\n');
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
    const install=steps.findIndex(step=>step.run==='npm ci --prefix tools/release');
    assert.ok(install>=0,name);
    for(const step of steps.filter(step=>step.run?.includes('node scripts/release.mjs')||step.run?.includes('node scripts/ci-platform.mjs'))){
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
test('smoke packages have separate identity and no gameplay or updater privileges',()=>{
  for(const platform of Object.keys(platforms)){
    const c=packageConfig(platform,true);
    assert.equal(c.identifier,'com.rayrag.companion.ci');
    assert.deepEqual(c.app.security.capabilities,['ci-smoke']);assert.equal(c.bundle.createUpdaterArtifacts,false);
    assert.equal(packageConfig(platform,false).identifier,undefined);
  }
  assert.throws(()=>packageConfig('unknown',false));
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
