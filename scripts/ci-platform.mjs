// Secret-free native packages for PRs, and same-source manual installers for releases.
import { execFileSync } from 'node:child_process';
import { readFile, readdir, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assetNames, platformReceipt, validatePlatformBuild, sha256 } from './release-core.mjs';
import { stampVersions } from './release.mjs';
import { nativeSmoke } from './native-smoke.mjs';
import { verifyAppImageExecutable } from './appimage-proof.mjs';
import { runLoggedProcess, smokePackagingEnvironment } from './process-diagnostics.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const platforms = {
  macos: { os:'darwin', arch:'arm64', target:'aarch64-apple-darwin', bundles:'app,dmg' },
  windows: { os:'win32', arch:'x64', target:'x86_64-pc-windows-msvc', bundles:'nsis' },
  linux: { os:'linux', arch:'x64', target:'x86_64-unknown-linux-gnu', bundles:'deb,appimage' },
};
function requireValue(ok, message) { if (!ok) throw new Error(message); }
const run = (file,args,options={}) => execFileSync(file,args,{cwd:root,stdio:['ignore','pipe','pipe'],...options});
export function assertArchitecture(bytes, target) {
  if (target === platforms.windows.target) {
    requireValue(bytes.length >= 64 && bytes.toString('ascii',0,2)==='MZ','Missing Windows executable header.');
    const offset=bytes.readUInt32LE(60);
    requireValue(offset+26<=bytes.length && bytes.toString('ascii',offset,offset+4)==='PE\0\0'
      && bytes.readUInt16LE(offset+4)===0x8664 && bytes.readUInt16LE(offset+24)===0x20b,'Application is not Windows x64.');
  } else if (target === platforms.linux.target) {
    requireValue(bytes.length>=64 && bytes.subarray(0,4).equals(Buffer.from([127,69,76,70]))
      && bytes[4]===2 && bytes[5]===1 && bytes.readUInt16LE(18)===62,'Application is not Linux x64.');
  } else throw new Error('Unsupported executable target.');
}
export function packageConfig(platform, smoke) {
  requireValue(Object.hasOwn(platforms,platform),'Unsupported package platform.');
  return {
    ...(smoke ? {identifier:'com.rayrag.companion.ci',app:{security:{capabilities:['ci-smoke']}}} : {}),
    bundle:{createUpdaterArtifacts:false,targets:platforms[platform].bundles.split(',')},
  };
}
async function walk(folder, skipLinks=false) {
  const items=[];
  for(const entry of await readdir(folder,{withFileTypes:true})) {
    const path=join(folder,entry.name);
    if(entry.isSymbolicLink()) { requireValue(skipLinks,'Package output contains a link.');continue; }
    if(entry.isDirectory())items.push(...await walk(path,skipLinks));
    else if(entry.isFile())items.push(path);
  }
  return items;
}
async function only(files,extension) {
  const found=files.filter(p=>p.endsWith(extension));
  requireValue(found.length===1,`Expected one ${extension} installer.`);
  return found[0];
}
async function matchingApplication(folder, binary) {
  const expected=sha256(await readFile(binary));
  const candidates=(await walk(folder,true)).filter(p=>basename(p)===basename(binary));
  const matches=[];
  for(const path of candidates)if(sha256(await readFile(path))===expected)matches.push(path);
  requireValue(matches.length===1,'Installer does not contain the exact built application.');
  return matches[0];
}
export async function installerFiles(platform,bundle) {
  const installerDirectory=join(bundle,platform==='windows'?'nsis':platform==='linux'?'deb':'dmg');
  const files=(await readdir(installerDirectory,{withFileTypes:true})).filter(entry=>entry.isFile()).map(entry=>join(installerDirectory,entry.name));
  if(platform==='linux')files.push(...(await readdir(join(bundle,'appimage'),{withFileTypes:true})).filter(entry=>entry.isFile()).map(entry=>join(bundle,'appimage',entry.name)));
  // Inspect installer files directly; AppDir staging trees contain library links.
  return files;
}
export async function packageSmokes(packages, check = nativeSmoke) {
  // Each smoke owns a private data/WebKit/DBus context. Await both cleanups even
  // if one fails, and retain its sequential save/reopen assertions.
  const outcomes = await Promise.allSettled(packages.map(({ binary, report }) => check(binary, report)));
  const errors = outcomes.filter(outcome => outcome.status === 'rejected').map(outcome => outcome.reason);
  if (errors.length) throw new AggregateError(errors, 'Packaged native smoke failed.');
}
async function inspect(platform,bundle,binary,version,identifier,smoke) {
  const files=await installerFiles(platform,bundle);
  const names=assetNames(version);
  const payload=new Map();
  const temporary=await mkdtemp(join(tmpdir(),'rayrag-package-check-'));
  try {
    if(platform==='windows') {
      assertArchitecture(await readFile(binary),platforms.windows.target);
      const installer=await only(files,'-setup.exe');
      const extract=join(temporary,'windows');
      const seven=join(process.env.ProgramFiles||'C:\\Program Files','7-Zip','7z.exe');
      run(seven,['x',installer,`-o${extract}`,'-y']);
      const packaged=await matchingApplication(extract,binary);
      if(smoke)await nativeSmoke(packaged,join(root,'reports/smoke.json'));
      payload.set(names.windows,await readFile(installer));
    } else if(platform==='linux') {
      assertArchitecture(await readFile(binary),platforms.linux.target);
      const deb=await only(files,'.deb'), appimage=await only(files,'.AppImage');
      requireValue(run('dpkg-deb',['--field',deb,'Architecture']).toString().trim()==='amd64','Debian package architecture differs.');
      requireValue(run('dpkg-deb',['--field',deb,'Version']).toString().trim()===version,'Debian package version differs.');
      const extract=join(temporary,'debian');
      run('dpkg-deb',['--extract',deb,extract]);
      const debBinary=await matchingApplication(extract,binary);
      run(appimage,['--appimage-extract'],{cwd:temporary});
      const staged=join(bundle,'appimage','Rayrag Companion.AppDir/usr/bin/rayrag-companion');
      const extracted=join(temporary,'squashfs-root/usr/bin/rayrag-companion');
      if(smoke)await writeFile(join(root,'reports/appimage-elf.txt'),[binary,staged].map(path=>run('readelf',['-lW','-SW','-dW',path]).toString()).join('\n'));
      await verifyAppImageExecutable(binary,staged,extracted);
      if(smoke)await packageSmokes([
        { binary: debBinary, report: join(root,'reports/smoke-deb.json') },
        { binary: join(temporary,'squashfs-root/AppRun'), report: join(root,'reports/smoke.json') },
      ]);
      payload.set(names.deb,await readFile(deb));payload.set(names.appimage,await readFile(appimage));
    } else {
      const app=join(bundle,'macos','Rayrag Companion.app');
      const executable=join(app,'Contents/MacOS/rayrag-companion');
      requireValue(run('lipo',['-archs',executable]).toString().trim()==='arm64','Application is not macOS ARM64.');
      run('codesign',['--verify','--deep','--strict',app]);
      const plist=join(app,'Contents/Info.plist');
      requireValue(run('plutil',['-extract','CFBundleIdentifier','raw',plist]).toString().trim()===identifier,'Application identifier differs.');
      requireValue(run('plutil',['-extract','CFBundleShortVersionString','raw',plist]).toString().trim()===version,'Application version differs.');
      const dmg=await only(files,'.dmg');run('hdiutil',['verify',dmg]);
      const mount=join(temporary,'mount');await mkdir(mount);
      run('hdiutil',['attach',dmg,'-readonly','-nobrowse','-mountpoint',mount]);
      try {
        run('python',['-c','import importlib.util,sys,pathlib; s=importlib.util.spec_from_file_location("release_native",sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); m.compare_apps(pathlib.Path(sys.argv[2]),pathlib.Path(sys.argv[3]))',join(root,'scripts/release-native.py'),app,join(mount,'Rayrag Companion.app')]);
      }finally {run('hdiutil',['detach',mount]);}
      if(smoke)await nativeSmoke(executable,join(root,'reports/smoke.json'));
      payload.set(names.dmg,await readFile(dmg));
    }
    return payload;
  } finally { await rm(temporary,{recursive:true,force:true}); }
}
export async function build(platform, mode) {
  const spec=platforms[platform];
  requireValue(spec && process.platform===spec.os && process.arch===spec.arch,'Wrong native package runner/architecture.');
  requireValue(mode==='--smoke'||mode==='--release','Choose the CI smoke or release package mode.');
  const smoke=mode==='--smoke';
  const environment={...process.env,...(platform==='linux'?{NO_STRIP:'1'}:{})};
  // Reject signing inputs before smoke version stamping or launching tools.
  const buildEnvironment=smoke?smokePackagingEnvironment(environment):environment;
  const sourceSha=run('git',['rev-parse','HEAD']).toString().trim();
  requireValue(sourceSha===process.env.GITHUB_SHA,'Checkout differs from the requested workflow source.');
  requireValue(/^[1-9]\d*$/.test(process.env.GITHUB_RUN_ID||'')&&/^[1-9]\d*$/.test(process.env.GITHUB_RUN_ATTEMPT||''),'Missing workflow identity.');
  if(smoke) {
    const count=run('git',['rev-list','--first-parent','--count','HEAD']).toString().trim();
    requireValue(/^[1-9]\d*$/.test(count),'Invalid preview source history.');
    await stampVersions(root,`0.2.${count}`);
  }
  const version=JSON.parse(await readFile(join(root,'package.json'),'utf8')).version;
  const config=packageConfig(platform,smoke);
  const args=['build','--target',spec.target,'--bundles',spec.bundles,'--config',JSON.stringify(config),'--ci','--no-binary-patching'];
  if(smoke)args.push('--features','ci-smoke');
  args.push('--','--locked');
  const command=[join(root,'node_modules/@tauri-apps/cli/tauri.js'),...args];
  if(smoke)await runLoggedProcess(process.execPath,command,{
    cwd:root,env:buildEnvironment,report:join(root,'reports',`package-${platform}.log`),
  });
  else execFileSync(process.execPath,command,{cwd:root,stdio:'inherit',env:buildEnvironment});
  const release=join(root,'src-tauri/target',spec.target,'release');
  const payload=await inspect(platform,join(release,'bundle'),join(release,`rayrag-companion${platform==='windows'?'.exe':''}`),version,smoke?'com.rayrag.companion.ci':'com.rayrag.companion',smoke);
  const folder=join(root,'platform-bundles',platform);
  await mkdir(folder,{recursive:true});requireValue((await readdir(folder)).length===0,'Refusing to mix package artifacts.');
  const identity={sourceSha,version}, workflow={runId:process.env.GITHUB_RUN_ID,runAttempt:process.env.GITHUB_RUN_ATTEMPT};
  if(platform!=='macos') {
    const receipt=platformReceipt(payload,identity,workflow,spec.target);
    payload.set('platform-build.json',Buffer.from(JSON.stringify(receipt,null,2)+'\n'));
    validatePlatformBuild(payload,identity,workflow,spec.target);
  }
  for(const [name,bytes] of payload)await writeFile(join(folder,name),bytes);
  console.log(`Verified ${platform} packages for ${sourceSha} at ${version}.`);
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const [command,platform,mode]=process.argv.slice(2);
  requireValue(command==='build','Unknown package command.');
  await build(platform,mode);
}
