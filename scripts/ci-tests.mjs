import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { platforms, packageConfig, assertArchitecture, installerFiles } from './ci-platform.mjs';

const workflow=parse(await readFile(new URL('../.github/workflows/release.yml',import.meta.url),'utf8'));
test('main PRs and merge queue always run all native platform lanes',()=>{
  assert.deepEqual(workflow.on.pull_request.branches,['main']);
  assert.ok(Object.hasOwn(workflow.on,'merge_group'));
  const quality=workflow.jobs.quality;
  assert.equal(quality.strategy['fail-fast'],false);
  assert.deepEqual(quality.strategy.matrix.include.map(x=>[x.platform,x.target]),Object.entries(platforms).map(([name,s])=>[name,s.target]));
  assert.equal(quality.if,undefined);
  const source=quality.steps.map(x=>x.run||'').join('\n');
  for(const command of ['npm run build','npm test','cargo test --locked','cargo clippy','cargo fmt','ci-platform.mjs build'])assert.ok(source.includes(command),command);
  assert.ok(source.includes('xvfb-run'));
  assert.ok(source.includes('node --test scripts/*-tests.mjs'));
  const smoke=quality.steps.filter(step=>step.run?.includes('scripts/ci-platform.mjs build'));
  assert.equal(smoke.length,2);
  for(const step of smoke)assert.ok(step.run.endsWith('--smoke'));

});
test('aggregate cannot report success after failed, cancelled, skipped or missing lanes',()=>{
  const gate=workflow.jobs.verify;
  assert.equal(gate.name,'CI / required');assert.equal(gate.needs,'quality');assert.equal(gate.if,'always()');
  assert.equal(gate.steps.length,1);
  assert.equal(gate.steps[0].env.QUALITY_RESULT,'${{ needs.quality.result }}');
  assert.equal(gate.steps[0].run,'test "$QUALITY_RESULT" = success');
  assert.equal(workflow.jobs.reconcile.needs,'verify');
  assert.deepEqual(workflow.jobs.build.needs,['reconcile','release-platforms']);
  assert.deepEqual(workflow.jobs.publish.needs,['reconcile','build']);
});
test('only trusted main signs and centrally publishes every platform',()=>{
  for(const name of ['reconcile','release-platforms','build','publish']){
    assert.ok(workflow.jobs[name].if.includes("github.ref == 'refs/heads/main'"));
    assert.ok(workflow.jobs[name].if.includes("github.event_name == 'push'"));
  }
  const jobs=Object.entries(workflow.jobs).filter(([,job])=>JSON.stringify(job).includes('secrets.TAURI_SIGNING_PRIVATE_KEY'));
  assert.deepEqual(jobs.map(([name])=>name),['build']);
  for(const job of Object.values(workflow.jobs))for(const step of job.steps||[]){
    if(step.uses)assert.match(step.uses,/@[a-f0-9]{40}$/);
    if(step.uses?.startsWith('actions/checkout@')){assert.equal(step.with.ref,'${{ github.sha }}');assert.equal(step.with['persist-credentials'],false);}
  }
  for(const platform of ['windows','linux'])assert.ok(workflow.jobs.build.steps.some(s=>s.with?.path===`platform-bundles/${platform}`));
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
