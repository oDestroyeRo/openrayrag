import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, copyFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APPIMAGE_RPATH, compareElfIdentity, compareDynamicIdentity, verifyAppImageExecutable } from './appimage-proof.mjs';

function fixture({ patched = false, reorder = false, extra = false } = {}) {
  const definitions = [
    { name: '.interp', type: 1, flags: 2n, data: Buffer.from('/lib64/ld-linux-x86-64.so.2\0') },
    { name: '.text', type: 1, flags: 6n, data: Buffer.from([0x31, 0xc0, 0xc3]) },
    { name: '.rodata', type: 1, flags: 2n, data: Buffer.from('stable application data\0') },
    { name: '.data', type: 1, flags: 3n, data: Buffer.from([3, 2, 1, 0]) },
    { name: '.bss', type: 8, flags: 3n, size: 1024 * 1024 },
    { name: '.note.gnu.build-id', type: 7, flags: 2n, data: Buffer.from([4, 3, 2, 1]) },
    { name: '.dynstr', type: 3, flags: 2n, data: Buffer.from(`\0symbol\0libc.so.6\0${patched ? APPIMAGE_RPATH + '\0' : ''}`) },
    { name: '.dynamic', type: 6, flags: 3n, entrySize: 16n, link: '.dynstr', data: Buffer.alloc(patched ? 48 : 32, patched ? 1 : 0) },
    { name: '.dynsym', type: 11, flags: 2n, entrySize: 24n, link: '.dynstr', data: Buffer.alloc(72) },
    { name: '.rela.dyn', type: 4, flags: 2n, entrySize: 24n, link: '.dynsym', info: '.data', data: Buffer.alloc(24, 7) },
  ];
  for (const [index, section] of definitions.entries()) section.address = BigInt(0x1000 + index * 0x100);
  if (patched) definitions.find(section => section.name === '.note.gnu.build-id').address += 0x2000n;
  if (reorder) definitions.reverse();
  if (extra) definitions.push({ name: '.injected', type: 1, flags: 6n, address: 0x5000n, data: Buffer.from([0xc3]) });
  const sections = [{ name: '', type: 0, flags: 0n, data: Buffer.alloc(0) }, ...definitions];
  sections.push({ name: '.shstrtab', type: 3, flags: 0n });
  const nameOffsets = new Map();
  let strings = '';
  for (const section of sections) { nameOffsets.set(section.name, strings.length); strings += section.name + '\0'; }
  sections.at(-1).data = Buffer.from(strings);
  const indexOf = name => name ? sections.findIndex(section => section.name === name) : 0;
  const symbols = sections.find(section => section.name === '.dynsym').data;
  symbols.writeUInt32LE(1, 24); // Ordinary function defined in .text.
  symbols[28] = 0x12;
  symbols.writeUInt16LE(indexOf('.text'), 30);
  symbols.writeBigUInt64LE(0x1100n, 32);
  symbols[52] = 3; // STT_SECTION whose section moves during metadata rewriting.
  symbols.writeUInt16LE(indexOf('.note.gnu.build-id'), 54);
  symbols.writeBigUInt64LE(sections[indexOf('.note.gnu.build-id')].address, 56);
  let offset = 128;
  for (const section of sections.slice(1)) {
    section.offset = offset;
    section.size ??= section.data.length;
    if (section.type !== 8) offset += section.size;
  }
  const table = Math.ceil(offset / 8) * 8;
  const bytes = Buffer.alloc(table + sections.length * 64);
  bytes.set([127, 69, 76, 70, 2, 1, 1]);
  bytes.writeUInt16LE(3, 16); bytes.writeUInt16LE(62, 18); bytes.writeUInt32LE(1, 20);
  bytes.writeBigUInt64LE(0x1100n, 24); bytes.writeBigUInt64LE(64n, 32);
  bytes.writeBigUInt64LE(BigInt(table), 40); bytes.writeUInt16LE(64, 52);
  bytes.writeUInt16LE(56, 54); bytes.writeUInt16LE(1, 56); bytes.writeUInt16LE(64, 58);
  bytes.writeUInt16LE(sections.length, 60); bytes.writeUInt16LE(sections.length - 1, 62);
  const headers = new Map(), offsets = new Map();
  for (const [index, section] of sections.entries()) {
    const at = table + index * 64;
    headers.set(section.name, at); offsets.set(section.name, section.offset ?? 0);
    bytes.writeUInt32LE(nameOffsets.get(section.name), at);
    bytes.writeUInt32LE(section.type, at + 4); bytes.writeBigUInt64LE(section.flags, at + 8);
    bytes.writeBigUInt64LE(section.address ?? 0n, at + 16);
    bytes.writeBigUInt64LE(BigInt(section.offset ?? 0), at + 24);
    bytes.writeBigUInt64LE(BigInt(section.size ?? 0), at + 32);
    bytes.writeUInt32LE(indexOf(section.link), at + 40);
    bytes.writeUInt32LE(typeof section.info === 'string' ? indexOf(section.info) : (section.info ?? 0), at + 44);
    bytes.writeBigUInt64LE(1n, at + 48); bytes.writeBigUInt64LE(section.entrySize ?? 0n, at + 56);
    if (section.type !== 8 && section.offset) section.data.copy(bytes, section.offset);
  }
  return { bytes, headers, offsets, table };
}

test('accepts metadata growth, section reordering and only documented symbol remapping', () => {
  const original = fixture(), deployed = fixture({ patched: true, reorder: true });
  const sections = compareElfIdentity(original.bytes, deployed.bytes);
  assert.ok(sections.includes('.text')); assert.ok(sections.includes('.bss'));
  assert.ok(original.bytes.length < 4096, 'NOBITS remains a logical size rather than file contents');
});

test('accepts only documented word alignment of relocated sections', () => {
  const original = fixture(), deployed = fixture({ patched: true });
  const at = deployed.headers.get('.interp');
  deployed.bytes.writeBigUInt64LE(0x9000n, at + 16);
  deployed.bytes.writeBigUInt64LE(8n, at + 48);
  const size = Number(original.bytes.readBigUInt64LE(original.headers.get('.interp') + 32));
  const contents = Buffer.from(original.bytes.subarray(original.offsets.get('.interp'), original.offsets.get('.interp') + size));
  // Move into a new bounded range to avoid overwriting existing sections.
  const moved = Buffer.concat([deployed.bytes, contents]);
  moved.writeBigUInt64LE(BigInt(deployed.bytes.length), at + 24);
  compareElfIdentity(original.bytes, moved);
  moved.writeBigUInt64LE(16n, at + 48);
  assert.throws(() => compareElfIdentity(original.bytes, moved), /metadata differs/);
});

test('rejects code, data, build ID, relocations and ordinary symbol changes', () => {
  for (const name of ['.text', '.rodata', '.data', '.interp', '.note.gnu.build-id', '.rela.dyn', '.dynsym']) {
    const original = fixture(), deployed = fixture({ patched: true });
    const at = deployed.offsets.get(name) + (name === '.dynsym' ? 32 : 0);
    deployed.bytes[at] ^= 1;
    assert.throws(() => compareElfIdentity(original.bytes, deployed.bytes), /differ/, name);
  }
  const original = fixture(), deployed = fixture({ patched: true });
  deployed.bytes[deployed.offsets.get('.dynstr') + 1] ^= 1;
  assert.throws(() => compareElfIdentity(original.bytes, deployed.bytes), /symbol name differs/);
});

test('rejects a symbol assigned to another section or an invalid section-symbol value', () => {
  const original = fixture();
  for (const kind of ['section', 'value', 'index']) {
    const deployed = fixture({ patched: true, reorder: true });
    const at = deployed.offsets.get('.dynsym');
    if (kind === 'section') deployed.bytes.writeUInt16LE(1, at + 30);
    if (kind === 'index') deployed.bytes.writeUInt16LE(1000, at + 30);
    if (kind === 'value') deployed.bytes.writeBigUInt64LE(0n, at + 56);
    assert.throws(() => compareElfIdentity(original.bytes, deployed.bytes), /symbol|reference/);
  }
});

test('preserves allocated section inventory, flags, type, logical size and layout', () => {
  const original = fixture();
  assert.throws(() => compareElfIdentity(original.bytes, fixture({ extra: true }).bytes), /inventory differs/);
  for (const mutation of ['flags', 'type', 'size', 'alignment', 'entry', 'link']) {
    const deployed = fixture({ patched: true });
    const at = deployed.headers.get('.bss');
    if (mutation === 'flags') deployed.bytes.writeBigUInt64LE(7n, at + 8);
    if (mutation === 'type') deployed.bytes.writeUInt32LE(1, at + 4);
    if (mutation === 'size') deployed.bytes.writeBigUInt64LE(2n, at + 32);
    if (mutation === 'alignment') deployed.bytes.writeBigUInt64LE(8n, at + 48);
    if (mutation === 'entry') deployed.bytes.writeBigUInt64LE(8n, at + 56);
    if (mutation === 'link') deployed.bytes.writeUInt32LE(1, at + 40);
    assert.throws(() => compareElfIdentity(original.bytes, deployed.bytes), /differs|bounds/);
  }
  const deployed = fixture({ patched: true });
  deployed.bytes.writeBigUInt64LE(0n, deployed.headers.get('.dynamic') + 8);
  assert.throws(() => compareElfIdentity(original.bytes, deployed.bytes), /allocated .dynamic/);
});

test('requires real nonempty allocated code and read-only data', () => {
  for (const name of ['.text', '.rodata']) for (const kind of ['empty', 'nobits', 'unallocated', 'executable-data']) {
    const bad = fixture(), at = bad.headers.get(name);
    if (kind === 'empty') bad.bytes.writeBigUInt64LE(0n, at + 32);
    if (kind === 'nobits') bad.bytes.writeUInt32LE(8, at + 4);
    if (kind === 'unallocated') bad.bytes.writeBigUInt64LE(0n, at + 8);
    if (kind === 'executable-data') bad.bytes.writeBigUInt64LE(name === '.text' ? 2n : 6n, at + 8);
    assert.throws(() => compareElfIdentity(bad.bytes, bad.bytes), /real nonempty/);
  }
});

test('rejects architecture, format, truncation, overflow and invalid section names', () => {
  const original = fixture();
  const mutations = [
    bytes => bytes.writeUInt16LE(183, 18), bytes => bytes[4] = 1, bytes => bytes[5] = 2,
    bytes => bytes[6] = 0, bytes => bytes.writeUInt16LE(1, 16),
    bytes => bytes.writeBigUInt64LE(0xffffffffffffffffn, 40),
    bytes => bytes.writeBigUInt64LE(0xffffffffffffffffn, original.headers.get('.text') + 24),
    bytes => bytes.writeBigUInt64LE(0xffffffffffffffffn, original.headers.get('.bss') + 32),
    bytes => bytes.writeUInt16LE(0, 60), bytes => bytes.writeUInt16LE(0xffff, 62),
    bytes => bytes.writeBigUInt64LE(BigInt(bytes.length - 1), 32),
    bytes => bytes.writeBigUInt64LE(BigInt(bytes.length), original.headers.get('.text') + 24),
    bytes => bytes.writeUInt32LE(0xffffffff, original.headers.get('.text')),
    bytes => bytes.writeUInt32LE(bytes.readUInt32LE(original.headers.get('.rodata')), original.headers.get('.text')),
    bytes => bytes.fill(0x41, original.offsets.get('.shstrtab'), original.table),
    bytes => bytes.writeBigUInt64LE(3n, original.headers.get('.data') + 48),
    bytes => bytes.writeUInt32LE(1000, original.headers.get('.rela.dyn') + 44),
  ];
  for (const mutate of mutations) {
    const bytes = Buffer.from(original.bytes); mutate(bytes);
    assert.throws(() => compareElfIdentity(original.bytes, bytes));
  }
  for (const length of [0, 4, 63, 127, original.bytes.length - 1])
    assert.throws(() => compareElfIdentity(original.bytes, original.bytes.subarray(0, length)), /truncated|bounds/);
});

const dynamic = { needed: ['libc.so.6', 'libm.so.6'], interpreter: '/lib64/ld-linux-x86-64.so.2', rpath: APPIMAGE_RPATH };
test('requires unchanged needed-library order, interpreter and exact relocatable RPATH', () => {
  compareDynamicIdentity({ ...dynamic, rpath: '' }, dynamic);
  for (const changed of [
    { needed: ['libm.so.6', 'libc.so.6'] }, { needed: ['libc.so.6'] },
    { needed: [...dynamic.needed, 'libc.so.6'] }, { needed: ['libc.so.7', 'libm.so.6'] },
    { interpreter: '/unexpected/loader' }, { rpath: '' }, { rpath: APPIMAGE_RPATH + ':$ORIGIN' },
    { rpath: '/usr/lib' }, { rpath: APPIMAGE_RPATH + '\n' },
  ]) assert.throws(() => compareDynamicIdentity(dynamic, { ...dynamic, ...changed }), /differ/);
});

test('extracted executable must exactly match the post-Linuxdeploy staging hash', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'rayrag-appimage-hash-'));
  try {
    const original = join(folder, 'original'), staged = join(folder, 'staged'), extracted = join(folder, 'extracted');
    await writeFile(original, fixture().bytes); await writeFile(staged, fixture({ patched: true }).bytes);
    await writeFile(extracted, fixture({ patched: true, reorder: true }).bytes);
    await assert.rejects(verifyAppImageExecutable(original, staged, extracted), /post-Linuxdeploy AppDir/);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('native Linux compiler + patchelf RPATH rewrite preserves executable identity', {
  skip: process.platform !== 'linux' || process.arch !== 'x64',
}, async () => {
  const folder = await mkdtemp(join(tmpdir(), 'rayrag-appimage-native-'));
  try {
    const source = join(folder, 'fixture.c'), original = join(folder, 'original');
    const staged = join(folder, 'staged'), extracted = join(folder, 'extracted');
    await writeFile(source, '#include <stdio.h>\nstatic const char message[] = "AppImage native identity fixture";\nint main(void) { puts(message); return 0; }\n');
    execFileSync('cc', [source, '-o', original, '-Wl,--build-id'], { timeout: 30_000 });
    await copyFile(original, staged);
    execFileSync('patchelf', ['--set-rpath', APPIMAGE_RPATH, staged], { timeout: 30_000 });
    await copyFile(staged, extracted);
    const result = await verifyAppImageExecutable(original, staged, extracted);
    assert.equal(result.stagedSha256, result.extractedSha256);
    assert.notEqual(result.originalSha256, result.extractedSha256);
    assert.equal(result.rpath, APPIMAGE_RPATH);
    assert.match(execFileSync(extracted, [], { encoding: 'utf8', timeout: 30_000 }), /native identity fixture/);
    const mutated = await readFile(extracted);
    mutated[Number(mutated.readBigUInt64LE(40))] ^= 1;
    await writeFile(extracted, mutated);
    await assert.rejects(verifyAppImageExecutable(original, staged, extracted), /post-Linuxdeploy AppDir/);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
