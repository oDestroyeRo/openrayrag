import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdtemp, mkdir, writeFile, copyFile, readFile, rm, open, symlink, rename, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APPIMAGE_RPATH, compareElfIdentity, compareDynamicIdentity, executableBytes, verifyAppImageExecutable } from './appimage-proof.mjs';

const noFollow = typeof constants.O_NOFOLLOW === 'number' && constants.O_NOFOLLOW !== 0;

test('executable reads fail closed when no-follow support is unavailable', { skip: noFollow }, async () => {
  await assert.rejects(executableBytes('unused'), /no-follow file support/);
});

test('executable reads reject symlinks, nonregular files and oversized sparse files', { skip: !noFollow }, async () => {
  const folder = await mkdtemp(join(tmpdir(), 'rayrag-appimage-files-'));
  try {
    const regular = join(folder, 'regular'), linked = join(folder, 'linked'), oversized = join(folder, 'oversized');
    await writeFile(regular, 'retained executable bytes');
    await symlink(regular, linked);
    assert.equal((await executableBytes(regular)).toString(), 'retained executable bytes');
    await assert.rejects(executableBytes(linked), { code: 'ELOOP' });
    await assert.rejects(executableBytes(folder), /bounded regular executable/);
    const file = await open(oversized, 'wx');
    try { await file.truncate(512 * 1024 * 1024 + 1); } finally { await file.close(); }
    await assert.rejects(executableBytes(oversized), /bounded regular executable/);
    const fifo = join(folder, 'fifo');
    execFileSync('mkfifo', [fifo]);
    await assert.rejects(executableBytes(fifo), /bounded regular executable/);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('executable reads retain the checked handle across pathname replacement', { skip: !noFollow }, async t => {
  const folder = await mkdtemp(join(tmpdir(), 'rayrag-appimage-replace-'));
  try {
    const path = join(folder, 'executable');
    await writeFile(path, 'checked bytes');
    const file = await open(path, 'r'), prototype = Object.getPrototypeOf(file);
    await file.close();
    const stat = prototype.stat;
    let replaced = false;
    t.mock.method(prototype, 'stat', async function (...args) {
      const result = await stat.apply(this, args);
      if (!replaced) {
        replaced = true;
        await rename(path, join(folder, 'retained'));
        await writeFile(path, 'redirected bytes');
      }
      return result;
    });
    assert.equal((await executableBytes(path)).toString(), 'checked bytes');
    assert.equal((await executableBytes(path)).toString(), 'redirected bytes');
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('executable reads bound concurrent growth and close the rejected handle', { skip: !noFollow }, async t => {
  const folder = await mkdtemp(join(tmpdir(), 'rayrag-appimage-growth-'));
  try {
    const path = join(folder, 'executable');
    await writeFile(path, 'checked bytes');
    const file = await open(path, 'r'), prototype = Object.getPrototypeOf(file);
    await file.close();
    const stat = prototype.stat;
    let closed = false;
    t.mock.method(prototype, 'stat', async function (...args) {
      const result = await stat.apply(this, args);
      await appendFile(path, ' appended after inspection');
      const close = this.close;
      t.mock.method(this, 'close', async function (...args) {
        closed = true;
        return close.apply(this, args);
      });
      return result;
    });
    await assert.rejects(executableBytes(path), /size changed while reading/);
    assert.equal(closed, true);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

function fixture({ patched = false, reorder = false, extra = false, relocateInterp = false, property = false, extendMetadata = false,
  metadataBelowOffset = false, mappedSectionTable = false } = {}) {
  const definitions = [
    { name: '.interp', type: 1, flags: 2n, offset: 0x300, data: Buffer.from('/lib64/ld-linux-x86-64.so.2\0') },
    { name: '.text', type: 1, flags: 6n, offset: 0x1000, data: Buffer.from([0x31, 0xc0, 0xc3]) },
    { name: '.rodata', type: 1, flags: 2n, offset: 0x2000, data: Buffer.from('stable application data\0') },
    { name: '.data', type: 1, flags: 3n, offset: 0x3000, data: Buffer.from([3, 2, 1, 0]) },
    { name: '.bss', type: 8, flags: 3n, offset: 0x4000, size: 1024 * 1024 },
    { name: '.note.gnu.build-id', type: 7, flags: 2n, offset: 0x340, data: Buffer.from([4, 3, 2, 1]) },
    { name: '.dynstr', type: 3, flags: 2n, offset: 0x380, data: Buffer.from(`\0symbol\0libc.so.6\0${patched ? APPIMAGE_RPATH + '\0' : ''}`) },
    { name: '.dynamic', type: 6, flags: 3n, offset: 0x3010, entrySize: 16n, link: '.dynstr', data: Buffer.alloc(patched ? 160 : 144) },
    { name: '.dynsym', type: 11, flags: 2n, offset: 0x3c0, entrySize: 24n, link: '.dynstr', data: Buffer.alloc(72) },
    { name: '.rela.dyn', type: 4, flags: 2n, offset: 0x430, entrySize: 24n, link: '.dynsym', info: '.data', data: Buffer.alloc(24, 7) },
  ];
  if (property) definitions.push({ name: '.note.gnu.property', type: 7, flags: 2n, offset: 0x480, alignment: 8n,
    data: Buffer.from('040000002000000005000000474e5500020000c0040000000300000000000000028000c0040000000100000000000000', 'hex') });
  if (extendMetadata || metadataBelowOffset) Object.assign(definitions.find(section => section.name === '.bss'), { offset: 0x30a0, size: 0x100 });
  for (const section of definitions) { section.address = BigInt(section.offset); section.alignment ??= 1n; section.size ??= section.data.length; }
  const sectionOf = name => definitions.find(section => section.name === name);
  const metadataStart = metadataBelowOffset ? 0x8000 : 0x4000;
  const metadataAddress = extendMetadata || metadataBelowOffset ? 0x4000n : 0x104000n;
  let metadataEnd = metadataStart + (patched && mappedSectionTable ? (definitions.length + 2 + (extra ? 1 : 0)) * 64 : 0);
  if (patched) for (const name of ['.dynstr', '.dynamic', ...(relocateInterp ? ['.interp'] : []), ...(property ? ['.note.gnu.property'] : [])]) {
    const section = sectionOf(name);
    section.offset = metadataEnd; section.address = metadataAddress + BigInt(metadataEnd - metadataStart); section.alignment = 8n;
    metadataEnd += Math.ceil(section.size / 8) * 8;
  }
  const entries = [
    ...(patched ? [[29n, 18n]] : []), [1n, 8n], [5n, sectionOf('.dynstr').address],
    [10n, BigInt(sectionOf('.dynstr').size)], [6n, sectionOf('.dynsym').address],
    [7n, sectionOf('.rela.dyn').address], [12n, 0x1000n], [13n, 0x1001n], [30n, 8n], [0n, 0n],
  ];
  for (const [index, [tag, value]] of entries.entries()) {
    sectionOf('.dynamic').data.writeBigInt64LE(tag, index * 16);
    sectionOf('.dynamic').data.writeBigUInt64LE(value, index * 16 + 8);
  }
  if (reorder) definitions.reverse();
  if (extra) definitions.push({ name: '.injected', type: 1, flags: 6n, offset: 0x2100, address: 0x2100n, alignment: 1n, data: Buffer.from([0xc3]), size: 1 });
  const sections = [{ name: '', type: 0, flags: 0n, data: Buffer.alloc(0) }, ...definitions];
  sections.push({ name: '.shstrtab', type: 3, flags: 0n, offset: extendMetadata ? 0x3400 : 0x3100, alignment: 1n });
  const nameOffsets = new Map();
  let strings = '';
  for (const section of sections) { nameOffsets.set(section.name, strings.length); strings += section.name + '\0'; }
  sections.at(-1).data = Buffer.from(strings); sections.at(-1).size = strings.length;
  const indexOf = name => name ? sections.findIndex(section => section.name === name) : 0;
  const symbols = sectionOf('.dynsym').data;
  symbols.writeUInt32LE(1, 24); symbols[28] = 0x12;
  symbols.writeUInt16LE(indexOf('.text'), 30); symbols.writeBigUInt64LE(0x1000n, 32);
  symbols[52] = 3;
  symbols.writeUInt16LE(indexOf('.dynstr'), 54); symbols.writeBigUInt64LE(sectionOf('.dynstr').address, 56);
  const phCount = (patched && !extendMetadata ? 10 : 9) + (property ? 1 : 0);
  const table = patched && mappedSectionTable ? metadataStart : extendMetadata ? 0x3500 : 0x3200;
  const bytes = Buffer.alloc(patched ? metadataEnd + 1 : table + sections.length * 64);
  bytes.set([127, 69, 76, 70, 2, 1, 1]);
  bytes.writeUInt16LE(3, 16); bytes.writeUInt16LE(62, 18); bytes.writeUInt32LE(1, 20);
  bytes.writeBigUInt64LE(0x1000n, 24); bytes.writeBigUInt64LE(64n, 32);
  bytes.writeBigUInt64LE(BigInt(table), 40); bytes.writeUInt16LE(64, 52);
  bytes.writeUInt16LE(56, 54); bytes.writeUInt16LE(phCount, 56); bytes.writeUInt16LE(64, 58);
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
    bytes.writeBigUInt64LE(section.alignment ?? 0n, at + 48); bytes.writeBigUInt64LE(section.entrySize ?? 0n, at + 56);
    if (section.type !== 8 && section.offset) section.data.copy(bytes, section.offset);
  }
  const programs = [
    [6, 4, 64, 64n, phCount * 56, phCount * 56, 8n],
    [3, 4, sectionOf('.interp').offset, sectionOf('.interp').address, sectionOf('.interp').size, sectionOf('.interp').size, 1n],
    [1, 4, 0, 0n, 0x500, 0x500, 4096n], [1, 5, 0x1000, 0x1000n, 3, 3, 4096n],
    [1, 4, 0x2000, 0x2000n, sectionOf('.rodata').size, sectionOf('.rodata').size, 4096n],
    [1, 6, 0x3000, 0x3000n, patched && extendMetadata ? metadataEnd - 0x3000 : 0xa0,
      extendMetadata ? (patched ? metadataEnd - 0x3000 : 0x1a0) : metadataBelowOffset ? 0x1a0 : 0x101000, 4096n],
    [2, 6, sectionOf('.dynamic').offset, sectionOf('.dynamic').address, sectionOf('.dynamic').size, sectionOf('.dynamic').size, 8n],
    [4, 4, 0x340, 0x340n, 4, 4, 4n], [0x6474e551, 6, 0, 0n, 0, 0, 16n],
    ...(property ? [[0x6474e553, 4, patched && property === 'relocated' ? sectionOf('.note.gnu.property').offset : 0x480,
      patched && property === 'relocated' ? sectionOf('.note.gnu.property').address : 0x480n, 48, 48, 8n]] : []),
    ...(patched && !extendMetadata ? [[1, 6, metadataStart, metadataAddress, metadataEnd - metadataStart, metadataEnd - metadataStart, 4096n]] : []),
  ];
  const programHeaders = [];
  for (const [index, [type, flags, offset, address, fileSize, memorySize, alignment]] of programs.entries()) {
    const at = 64 + index * 56; programHeaders.push(at);
    bytes.writeUInt32LE(type, at); bytes.writeUInt32LE(flags, at + 4);
    bytes.writeBigUInt64LE(BigInt(offset), at + 8); bytes.writeBigUInt64LE(address, at + 16); bytes.writeBigUInt64LE(address, at + 24);
    bytes.writeBigUInt64LE(BigInt(fileSize), at + 32); bytes.writeBigUInt64LE(BigInt(memorySize), at + 40); bytes.writeBigUInt64LE(alignment, at + 48);
  }
  return { bytes, headers, offsets, table, programHeaders };
}

test('accepts metadata growth, section reordering and only documented symbol remapping', () => {
  const original = fixture(), deployed = fixture({ patched: true, reorder: true });
  const sections = compareElfIdentity(original.bytes, deployed.bytes);
  assert.ok(sections.includes('.text')); assert.ok(sections.includes('.bss'));
  assert.ok(original.bytes.length < 32 * 1024, 'NOBITS remains a logical size rather than file contents');
});

test('accepts only documented word alignment of relocated sections', () => {
  const original = fixture(), deployed = fixture({ patched: true, relocateInterp: true });
  compareElfIdentity(original.bytes, deployed.bytes);
  deployed.bytes.writeBigUInt64LE(16n, deployed.headers.get('.interp') + 48);
  assert.throws(() => compareElfIdentity(original.bytes, deployed.bytes), /metadata differs/);
});

test('preserves property notes with exactly retained or correctly relocated GNU_PROPERTY headers', () => {
  for (const property of ['retained', 'relocated']) {
    const original = fixture({ property }), deployed = fixture({ patched: true, property });
    compareElfIdentity(original.bytes, deployed.bytes);
    const at = deployed.programHeaders.find(at => deployed.bytes.readUInt32LE(at) === 0x6474e553);
    deployed.bytes.writeUInt32LE(5, at + 4);
    assert.throws(() => compareElfIdentity(original.bytes, deployed.bytes), /GNU_PROPERTY|loader/);
  }
  const original = fixture({ property: 'retained' }), deployed = fixture({ patched: true, property: 'retained' });
  deployed.bytes[deployed.offsets.get('.note.gnu.property')] ^= 1;
  assert.throws(() => compareElfIdentity(original.bytes, deployed.bytes), /section contents differ/);
});

test('extending a RW LOAD preserves original zero-fill memory when it becomes file-backed', () => {
  const original = fixture({ extendMetadata: true }), deployed = fixture({ patched: true, extendMetadata: true });
  compareElfIdentity(original.bytes, deployed.bytes);
  deployed.bytes[0x30a0] = 99;
  assert.throws(() => compareElfIdentity(original.bytes, deployed.bytes), /zero-fill memory/);
});

test('metadata LOAD may map parsed section headers with a virtual address below its file offset', () => {
  const original = fixture({ metadataBelowOffset: true });
  const deployed = fixture({ patched: true, metadataBelowOffset: true, mappedSectionTable: true });
  compareElfIdentity(original.bytes, deployed.bytes);
  const padding = deployed.offsets.get('.dynamic') - 1;
  deployed.bytes[padding] = 99;
  assert.throws(() => compareElfIdentity(original.bytes, deployed.bytes), /LOAD padding/);
});

function dynamicSlot(bytes, tag) {
  const table = Number(bytes.readBigUInt64LE(40)), count = bytes.readUInt16LE(60);
  for (let index = 0; index < count; index++) {
    const at = table + index * bytes.readUInt16LE(58);
    if (bytes.readUInt32LE(at + 4) !== 6) continue;
    const offset = Number(bytes.readBigUInt64LE(at + 24)), size = Number(bytes.readBigUInt64LE(at + 32));
    for (let entry = offset; entry < offset + size; entry += 16)
      if (bytes.readBigInt64LE(entry) === tag) return entry;
  }
  throw new Error(`Fixture has no dynamic tag ${tag}.`);
}
function executableLoad(bytes) {
  const offset = Number(bytes.readBigUInt64LE(32));
  for (let index = 0; index < bytes.readUInt16LE(56); index++) {
    const at = offset + index * bytes.readUInt16LE(54);
    if (bytes.readUInt32LE(at) === 1 && bytes.readUInt32LE(at + 4) & 1) return at;
  }
  throw new Error('Fixture has no executable LOAD.');
}

test('rejects altered DT_INIT, DT_FINI, DT_FLAGS, pointer offsets and dynamic ordering', () => {
  const original = fixture();
  for (const tag of [12n, 13n, 30n, 5n]) {
    const deployed = fixture({ patched: true });
    deployed.bytes.writeBigUInt64LE(0xdeadbeefn, dynamicSlot(deployed.bytes, tag) + 8);
    assert.throws(() => compareElfIdentity(original.bytes, deployed.bytes), /dynamic.*(differ|map)/);
  }
  const deployed = fixture({ patched: true });
  const init = dynamicSlot(deployed.bytes, 12n), fini = dynamicSlot(deployed.bytes, 13n);
  const initBytes = Buffer.from(deployed.bytes.subarray(init, init + 16));
  deployed.bytes.copy(deployed.bytes, init, fini, fini + 16); initBytes.copy(deployed.bytes, fini);
  assert.throws(() => compareElfIdentity(original.bytes, deployed.bytes), /dynamic entry ordering/);
  const padding = fixture({ patched: true });
  padding.bytes.writeBigUInt64LE(1n, dynamicSlot(padding.bytes, 0n) + 8);
  assert.throws(() => compareElfIdentity(original.bytes, padding.bytes), /NULL padding/);
});

test('rejects altered executable LOAD permissions, mappings, extent and loader flags', () => {
  const original = fixture();
  for (const mutation of ['writable', 'not-executable', 'address', 'extent', 'alignment', 'stack', 'metadata-executable']) {
    const deployed = fixture({ patched: true }), at = executableLoad(deployed.bytes);
    if (mutation === 'writable') deployed.bytes.writeUInt32LE(7, at + 4);
    if (mutation === 'not-executable') deployed.bytes.writeUInt32LE(4, at + 4);
    if (mutation === 'address') { deployed.bytes.writeBigUInt64LE(0x5000n, at + 16); deployed.bytes.writeBigUInt64LE(0x5000n, at + 24); }
    if (mutation === 'extent') { deployed.bytes.writeBigUInt64LE(4n, at + 32); deployed.bytes.writeBigUInt64LE(4n, at + 40); }
    if (mutation === 'alignment') deployed.bytes.writeBigUInt64LE(8192n, at + 48);
    if (mutation === 'stack') deployed.bytes.writeUInt32LE(7, deployed.programHeaders[8] + 4);
    if (mutation === 'metadata-executable') deployed.bytes.writeUInt32LE(7, deployed.programHeaders[9] + 4);
    assert.throws(() => compareElfIdentity(original.bytes, deployed.bytes), /LOAD|loader/);
  }
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

test('extracted executable must exactly match the post-Linuxdeploy staging hash', { skip: !noFollow }, async () => {
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
  const source = join(folder, 'fixture.c'), original = join(folder, 'original');
  const staged = join(folder, 'staged'), extracted = join(folder, 'extracted');
  try {
    await writeFile(source, '#include <stdio.h>\nstatic const char message[] = "AppImage native identity fixture";\nint main(void) { puts(message); return 0; }\n');
    execFileSync('cc', [source, '-o', original, '-Wl,--build-id', '-Wl,-z,now'], { timeout: 30_000 });
    await copyFile(original, staged);
    execFileSync('patchelf', ['--set-rpath', APPIMAGE_RPATH, staged], { timeout: 30_000 });
    await copyFile(staged, extracted);
    const result = await verifyAppImageExecutable(original, staged, extracted);
    assert.equal(result.stagedSha256, result.extractedSha256);
    assert.notEqual(result.originalSha256, result.extractedSha256);
    assert.equal(result.rpath, APPIMAGE_RPATH);
    assert.match(execFileSync(extracted, [], { encoding: 'utf8', timeout: 30_000 }), /native identity fixture/);
    const pristine = await readFile(staged);
    for (const mutation of ['writable-load', 12n, 13n, 30n]) {
      const bytes = Buffer.from(pristine);
      if (mutation === 'writable-load') {
        const at = executableLoad(bytes);
        bytes.writeUInt32LE(bytes.readUInt32LE(at + 4) | 2, at + 4);
      } else bytes.writeBigUInt64LE(0xdeadbeefn, dynamicSlot(bytes, mutation) + 8);
      // Matching staged/extracted hashes must not conceal a loader mutation.
      await writeFile(staged, bytes); await writeFile(extracted, bytes);
      await assert.rejects(verifyAppImageExecutable(original, staged, extracted), /LOAD|dynamic/);
    }
    await writeFile(staged, pristine);
    const mutated = Buffer.from(pristine);
    mutated[Number(mutated.readBigUInt64LE(40))] ^= 1;
    await writeFile(extracted, mutated);
    await assert.rejects(verifyAppImageExecutable(original, staged, extracted), /post-Linuxdeploy AppDir/);
  } catch (error) {
    if (process.env.CI === 'true') {
      try {
        await mkdir('reports', { recursive: true });
        const reports = [];
        for (const [name, path] of [['original', original], ['staged', staged]]) {
          reports.push(`${name}\n${execFileSync('readelf', ['-lW', '-SW', '-dW', path], { encoding: 'utf8', timeout: 30_000, maxBuffer: 128 * 1024 })}`);
          const bytes = await readFile(path);
          if (bytes.length < 32 * 1024) await writeFile(join('reports', `appimage-fixture-${name}.elf`), bytes);
        }
        await writeFile(join('reports', 'appimage-fixture-elf.txt'), reports.join('\n'));
      } catch { /* Diagnostics must preserve the original test failure. */ }
    }
    throw error;
  } finally { await rm(folder, { recursive: true, force: true }); }
});
