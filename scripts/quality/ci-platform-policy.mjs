// Pure native package configuration and executable contracts.
/** @type {Readonly<Record<import("../shared/tooling-domain-values.mjs").PackagePlatform, import("../shared/tooling-domain-values.mjs").PackagePlatformSpec>>} */
export const platforms = {
  macos: { os:'darwin', arch:'arm64', target:'aarch64-apple-darwin', bundles:'app,dmg' },
  windows: { os:'win32', arch:'x64', target:'x86_64-pc-windows-msvc', bundles:'nsis' },
  linux: { os:'linux', arch:'x64', target:'x86_64-unknown-linux-gnu', bundles:'deb,appimage' },
};
function requireValue(ok, message) { if (!ok) throw new Error(message); }
/** @param {Buffer} bytes @param {import('../shared/tooling-domain-values.mjs').PackageTarget} target */
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
/** @param {import('../shared/tooling-domain-values.mjs').PackagePlatform} platform @param {boolean} smoke */
export function packageConfig(platform, smoke) {
  requireValue(Object.hasOwn(platforms,platform),'Unsupported package platform.');
  return {
    ...(smoke ? {identifier:'com.rayrag.companion.ci',app:{security:{capabilities:['ci-smoke']}}} : {}),
    bundle:{createUpdaterArtifacts:false,targets:platforms[platform].bundles.split(',')},
  };
}
/** @param {import('../shared/tooling-domain-values.mjs').PackagePlatform} platform @param {boolean} smoke */
export function packageBuildArgs(platform, smoke) {
  const spec = platforms[platform];
  const config = packageConfig(platform, smoke);
  return [
    'build', '--target', spec.target, '--bundles', spec.bundles,
    '--config', JSON.stringify(config), '--ci', '--no-binary-patching',
    ...(smoke ? ['--features', 'ci-smoke'] : []), '--', '--locked',
  ];
}
