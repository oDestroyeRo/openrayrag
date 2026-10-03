// Linuxdeploy changes RPATH after the raw Tauri application has been built.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';

export const APPIMAGE_RPATH = '$ORIGIN/../lib';
const MAX_BYTES = 512 * 1024 * 1024;
const ALLOC = 2n, NOBITS = 8, SYMTAB = 2, DYNSYM = 11;
const metadata = new Map([['.dynamic', 6], ['.dynstr', 3]]);
const requireValue = (ok, message) => { if (!ok) throw new Error(message); };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function boundedInteger(value, label) {
  requireValue(value <= BigInt(Number.MAX_SAFE_INTEGER), `ELF ${label} overflows a safe integer.`);
  return Number(value);
}
function range(bytes, offset, size, label) {
  requireValue(offset >= 0 && size >= 0 && offset <= bytes.length && size <= bytes.length - offset,
    `ELF ${label} is truncated or out of bounds.`);
  return bytes.subarray(offset, offset + size);
}

function parseElf(bytes) {
  requireValue(Buffer.isBuffer(bytes) && bytes.length <= MAX_BYTES, 'ELF exceeds the bounded file size.');
  range(bytes, 0, 64, 'header');
  requireValue(bytes.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70]))
    && bytes[4] === 2 && bytes[5] === 1 && bytes[6] === 1
    && bytes.readUInt16LE(18) === 62 && bytes.readUInt32LE(20) === 1,
  'Application is not an ELF64 little-endian Linux x64 executable.');
  requireValue([2, 3].includes(bytes.readUInt16LE(16)) && bytes.readUInt16LE(52) === 64,
    'Unsupported ELF executable header.');
  const table = boundedInteger(bytes.readBigUInt64LE(40), 'section table offset');
  const count = bytes.readUInt16LE(60), namesIndex = bytes.readUInt16LE(62);
  // Extended section numbering is unnecessary for the bounded application proof.
  requireValue(count > 1 && count < 0xff00 && namesIndex > 0 && namesIndex < count
    && bytes.readUInt16LE(58) === 64, 'Unsupported ELF section table.');
  range(bytes, table, count * 64, 'section table');
  const phCount = bytes.readUInt16LE(56);
  requireValue(phCount > 0 && phCount < 0xffff && bytes.readUInt16LE(54) === 56,
    'Unsupported ELF program table.');
  range(bytes, boundedInteger(bytes.readBigUInt64LE(32), 'program table offset'), phCount * 56, 'program table');
  const sections = [];
  for (let index = 0; index < count; index++) {
    const at = table + index * 64;
    const section = {
      index, nameOffset: bytes.readUInt32LE(at), type: bytes.readUInt32LE(at + 4),
      flags: bytes.readBigUInt64LE(at + 8), address: bytes.readBigUInt64LE(at + 16),
      offset: boundedInteger(bytes.readBigUInt64LE(at + 24), 'section offset'),
      size: boundedInteger(bytes.readBigUInt64LE(at + 32), 'section size'),
      link: bytes.readUInt32LE(at + 40), info: bytes.readUInt32LE(at + 44),
      alignment: bytes.readBigUInt64LE(at + 48), entrySize: bytes.readBigUInt64LE(at + 56),
    };
    requireValue(section.link < count, 'ELF section link is out of bounds.');
    requireValue(section.alignment === 0n || (section.alignment & (section.alignment - 1n)) === 0n,
      'ELF section alignment is invalid.');
    // SHT_NOBITS has a logical memory size but no bytes in the file (including .bss).
    section.contents = section.type === NOBITS ? null : range(bytes, section.offset, section.size, 'section contents');
    sections.push(section);
  }
  requireValue(sections[0].type === 0 && sections[0].size === 0 && sections[0].flags === 0n,
    'ELF null section is invalid.');
  const names = sections[namesIndex];
  requireValue(names.type === 3 && names.contents?.length > 0 && names.contents[0] === 0,
    'ELF section names are invalid.');
  const byName = new Map();
  for (const section of sections) {
    requireValue(section.nameOffset < names.size, 'ELF section name offset is out of bounds.');
    const end = names.contents.indexOf(0, section.nameOffset);
    requireValue(end >= 0 && end - section.nameOffset <= 256, 'ELF section name is unterminated or too long.');
    section.name = names.contents.toString('utf8', section.nameOffset, end);
    if (section.index === 0) continue;
    requireValue(section.name.length > 0 && !byName.has(section.name), 'ELF section names are empty or duplicated.');
    byName.set(section.name, section);
    if (section.flags & ALLOC) {
      requireValue(section.type !== 0, 'ELF allocated null section is invalid.');
      if (metadata.has(section.name)) {
        requireValue(section.type === metadata.get(section.name) && section.size > 0 && !(section.flags & 4n),
          `ELF ${section.name} metadata is invalid.`);
        if (section.name === '.dynamic') requireValue(section.entrySize === 16n && section.size % 16 === 0,
          'ELF dynamic entry layout is invalid.');
        else requireValue(section.contents[0] === 0 && section.contents.at(-1) === 0,
          'ELF dynamic strings are invalid.');
      }
    }
  }
  for (const [name, flags] of [['.text', 6n], ['.rodata', 2n]]) {
    const section = byName.get(name);
    requireValue(section?.type === 1 && (section.flags & 7n) === flags && section.size > 0,
      `ELF requires a real nonempty ${name} section.`);
  }
  for (const name of metadata.keys()) requireValue(byName.get(name)?.flags & ALLOC, `ELF requires allocated ${name}.`);
  return { bytes, sections, byName };
}

function linkedName(elf, index) {
  requireValue(index < elf.sections.length, 'ELF section reference is out of bounds.');
  return index === 0 ? null : elf.sections[index].name;
}
function sectionInfo(elf, section) {
  return section.type === 4 || section.type === 9 || (section.flags & 64n)
    ? linkedName(elf, section.info) : section.info;
}
function sameAlignment(left, right) {
  if (left.alignment === right.alignment) return true;
  // writeReplacedSections uses sizeof(Elf_Off), retaining smaller note alignment:
  // https://github.com/NixOS/patchelf/blob/0.18.0/src/patchelf.cc#L640-L677
  const relocatedAlignment = left.type === 7 && left.alignment < 8n ? left.alignment : 8n;
  return left.offset !== right.offset && left.address !== right.address && right.alignment === relocatedAlignment;
}

function compareSymbols(original, deployed, left, right) {
  requireValue(left.entrySize === 24n && left.size % 24 === 0, `ELF ${left.name} symbol layout is invalid.`);
  // Patchelf rewriteHeaders remaps st_shndx after sorting section headers and
  // rewrites STT_SECTION st_value to that section's address. No other bytes are
  // excused: https://github.com/NixOS/patchelf/blob/0.18.0/src/patchelf.cc#L1170-L1194
  for (let at = 0; at < left.size; at += 24) {
    const a = Buffer.from(left.contents.subarray(at, at + 24));
    const b = Buffer.from(right.contents.subarray(at, at + 24));
    const ai = a.readUInt16LE(6), bi = b.readUInt16LE(6);
    const aSection = ai > 0 && ai < 0xff00, bSection = bi > 0 && bi < 0xff00;
    requireValue(aSection === bSection && (aSection
      ? linkedName(original, ai) === linkedName(deployed, bi) : ai === bi), `ELF ${left.name} symbol section differs.`);
    if (aSection) {
      a.writeUInt16LE(0, 6); b.writeUInt16LE(0, 6);
      if ((a[4] & 15) === 3 && (b[4] & 15) === 3) {
        requireValue(a.readBigUInt64LE(8) === original.sections[ai].address
          && b.readBigUInt64LE(8) === deployed.sections[bi].address, `ELF ${left.name} section symbol value is invalid.`);
        a.writeBigUInt64LE(0n, 8); b.writeBigUInt64LE(0n, 8);
      }
    }
    requireValue(a.equals(b), `ELF ${left.name} symbol contents differ.`);
    // .dynstr can move/grow for RPATH; imported/exported symbol names cannot change.
    const nameAt = a.readUInt32LE(0);
    requireValue(symbolName(original, left, nameAt) === symbolName(deployed, right, nameAt),
      `ELF ${left.name} symbol name differs.`);
  }
}
function symbolName(elf, symbols, at) {
  const strings = elf.sections[symbols.link];
  requireValue(strings?.type === 3 && at < strings.size, 'ELF symbol string offset is invalid.');
  const end = strings.contents.indexOf(0, at);
  requireValue(end >= 0, 'ELF symbol string is unterminated.');
  return strings.contents.subarray(at, end).toString('hex');
}

export function compareElfIdentity(originalBytes, deployedBytes) {
  const original = parseElf(originalBytes), deployed = parseElf(deployedBytes);
  requireValue(original.bytes.subarray(0, 32).equals(deployed.bytes.subarray(0, 32))
    && original.bytes.readUInt32LE(48) === deployed.bytes.readUInt32LE(48), 'ELF executable identity/entry point differs.');
  const allocated = elf => [...elf.byName.values()].filter(section => section.flags & ALLOC);
  const before = allocated(original), after = allocated(deployed);
  requireValue(before.length === after.length, 'ELF allocated section inventory differs.');
  for (const left of before) {
    const right = deployed.byName.get(left.name);
    requireValue(right && right.type === left.type && right.flags === left.flags
      && sameAlignment(left, right) && right.entrySize === left.entrySize
      && linkedName(original, left.link) === linkedName(deployed, right.link)
      && sectionInfo(original, left) === sectionInfo(deployed, right), `ELF ${left.name} section metadata differs.`);
    // Linuxdeploy's only intended mutation is RPATH in .dynamic/.dynstr. Its
    // default usr/bin path is pinned by appdir.cpp deployExecutable:
    // https://github.com/linuxdeploy/linuxdeploy/blob/07333c6/src/core/appdir.cpp#L434-L449
    if (metadata.has(left.name)) continue;
    requireValue(left.size === right.size, `ELF ${left.name} section size differs.`);
    if (left.type === SYMTAB || left.type === DYNSYM) compareSymbols(original, deployed, left, right);
    else if (left.type !== NOBITS) requireValue(left.contents.equals(right.contents), `ELF ${left.name} section contents differ.`);
  }
  return before.map(section => section.name).sort();
}

export function compareDynamicIdentity(original, deployed) {
  requireValue(Array.isArray(original.needed) && Array.isArray(deployed.needed)
    && original.needed.length === deployed.needed.length
    && original.needed.every((name, index) => name === deployed.needed[index]), 'AppImage needed libraries differ.');
  requireValue(typeof original.interpreter === 'string' && original.interpreter.startsWith('/')
    && original.interpreter === deployed.interpreter, 'AppImage ELF interpreter differs.');
  requireValue(deployed.rpath === APPIMAGE_RPATH, 'AppImage RPATH differs from the pinned Linuxdeploy path.');
}
function dynamicIdentity(path) {
  const output = option => execFileSync('patchelf', [option, path], {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  }).replace(/\r?\n$/, '');
  const needed = output('--print-needed');
  return { needed: needed === '' ? [] : needed.split('\n'), interpreter: output('--print-interpreter'), rpath: output('--print-rpath') };
}
async function executableBytes(path) {
  const stat = await lstat(path);
  requireValue(stat.isFile() && stat.size <= MAX_BYTES, 'AppImage proof requires a bounded regular executable file.');
  return readFile(path);
}

export async function verifyAppImageExecutable(original, staged, extracted) {
  const [rawBytes, stagedBytes, extractedBytes] = await Promise.all([original, staged, extracted].map(executableBytes));
  const originalSha256 = sha256(rawBytes), stagedSha256 = sha256(stagedBytes), extractedSha256 = sha256(extractedBytes);
  requireValue(stagedSha256 === extractedSha256, 'AppImage extracted executable differs from the post-Linuxdeploy AppDir executable.');
  const allocatedSections = compareElfIdentity(rawBytes, extractedBytes);
  const dynamic = dynamicIdentity(extracted);
  compareDynamicIdentity(dynamicIdentity(original), dynamic);
  return { originalSha256, stagedSha256, extractedSha256, allocatedSections, ...dynamic };
}
