import { filter, find, map, sort } from "remeda";

// Pure ELF and loader comparison. File and tool effects stay in appimage-proof.
import { createHash } from 'node:crypto';

export const APPIMAGE_RPATH = '$ORIGIN/../lib';
export const MAX_BYTES = 512 * 1024 * 1024;
const ALLOC = 2n, NOBITS = 8, SYMTAB = 2, DYNSYM = 11;
const metadata = new Map([['.dynamic', 6], ['.dynstr', 3]]);
const pointerSections = new Map([
  [4n, ['.hash']], [5n, ['.dynstr']], [6n, ['.dynsym']], [7n, ['.rela.dyn']],
  [17n, ['.rel.dyn', '.rel.got']], [23n, ['.rela.plt', '.rel.plt']],
  [0x6ffffef5n, ['.gnu.hash']], [0x6ffffff0n, ['.gnu.version']],
  [0x6ffffffen, ['.gnu.version_r']],
]);
export const requireValue = (ok, message) => { if (!ok) throw new Error(message); };
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

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
  requireValue(count > 1 && count <= 8192 && namesIndex > 0 && namesIndex < count
    && bytes.readUInt16LE(58) === 64, 'Unsupported ELF section table.');
  range(bytes, table, count * 64, 'section table');
  const phCount = bytes.readUInt16LE(56);
  requireValue(phCount > 0 && phCount <= 256 && bytes.readUInt16LE(54) === 56,
    'Unsupported ELF program table.');
  const phOffset = boundedInteger(bytes.readBigUInt64LE(32), 'program table offset');
  range(bytes, phOffset, phCount * 56, 'program table');
  const programs = [];
  for (let index = 0; index < phCount; index++) {
    const at = phOffset + index * 56;
    const program = {
      type: bytes.readUInt32LE(at), flags: bytes.readUInt32LE(at + 4),
      offset: boundedInteger(bytes.readBigUInt64LE(at + 8), 'segment offset'),
      address: bytes.readBigUInt64LE(at + 16), physical: bytes.readBigUInt64LE(at + 24),
      fileSize: boundedInteger(bytes.readBigUInt64LE(at + 32), 'segment file size'),
      memorySize: boundedInteger(bytes.readBigUInt64LE(at + 40), 'segment memory size'),
      alignment: bytes.readBigUInt64LE(at + 48),
    };
    range(bytes, program.offset, program.fileSize, 'segment contents');
    requireValue(program.address + BigInt(program.memorySize) < (1n << 64n),
      'ELF segment address overflows.');
    requireValue(program.alignment === 0n || (program.alignment & (program.alignment - 1n)) === 0n,
      'ELF segment alignment is invalid.');
    if (program.type === 1) requireValue(program.fileSize <= program.memorySize
      && (program.alignment <= 1n || program.address % program.alignment === BigInt(program.offset) % program.alignment),
    'ELF LOAD mapping is invalid.');
    programs.push(program);
  }
  requireValue(programs.some(program => program.type === 1 && program.flags & 1),
    'ELF requires an executable LOAD segment.');
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
  return { bytes, sections, byName, programs, phOffset, phSize: phCount * 56, table };
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

function dynamicEntries(elf) {
  const bytes = elf.byName.get('.dynamic').contents, entries = [];
  let terminated = false;
  for (let at = 0; at < bytes.length; at += 16) {
    const tag = bytes.readBigInt64LE(at), value = bytes.readBigUInt64LE(at + 8);
    if (tag === 0n) terminated = true;
    if (terminated) requireValue(tag === 0n && value === 0n, 'ELF dynamic NULL padding is invalid.');
    else entries.push({ tag, value });
  }
  requireValue(terminated, 'ELF dynamic entries are unterminated.');
  return entries;
}
function dynamicString(elf, value) {
  const strings = elf.byName.get('.dynstr').contents;
  const at = boundedInteger(value, 'dynamic string offset');
  requireValue(at < strings.length, 'ELF dynamic string offset is out of bounds.');
  const end = strings.indexOf(0, at);
  requireValue(end >= 0, 'ELF dynamic string is unterminated.');
  return { at, end, bytes: strings.subarray(at, end) };
}
function dynamicPointer(elf, tag, value) {
  for (const name of pointerSections.get(tag)) {
    const section = elf.byName.get(name);
    if (section && value >= section.address && value < section.address + BigInt(section.size))
      return `${name}:${value - section.address}`;
  }
  throw new Error(`ELF dynamic pointer ${tag} does not map its named section.`);
}
function compareLinkerMetadata(original, deployed) {
  const before = dynamicEntries(original), after = dynamicEntries(deployed);
  const isPath = entry => entry.tag === 15n || entry.tag === 29n;
  const oldPaths = filter(before, isPath), newPaths = filter(after, isPath);
  requireValue(oldPaths.length <= 2 && new Set(map(oldPaths, entry => entry.tag)).size === oldPaths.length
    && newPaths.length === Math.max(1, oldPaths.length), 'ELF RPATH entry inventory differs.');
  if (oldPaths.length === 0) requireValue(after[0].tag === 29n, 'ELF must prepend the Linuxdeploy RUNPATH entry.');
  else for (let index = 0; index < before.length; index++) if (isPath(before[index])) {
    const next = after[index];
    requireValue(next && (next.tag === before[index].tag
      || (before[index].tag === 15n && oldPaths.length === 1 && next.tag === 29n)), 'ELF RPATH entry ordering differs.');
  }
  const expectedString = Buffer.from(APPIMAGE_RPATH);
  for (const entry of newPaths) requireValue(dynamicString(deployed, entry.value).bytes.equals(expectedString),
    'ELF RPATH differs from the pinned Linuxdeploy path.');
  const left = filter(before, entry => !isPath(entry)), right = filter(after, entry => !isPath(entry));
  requireValue(left.length === right.length, 'ELF dynamic entry inventory differs.');
  for (let index = 0; index < left.length; index++) {
    const a = left[index], b = right[index];
    requireValue(a.tag === b.tag, 'ELF dynamic entry ordering differs.');
    if (pointerSections.has(a.tag)) requireValue(dynamicPointer(original, a.tag, a.value)
      === dynamicPointer(deployed, b.tag, b.value), `ELF dynamic pointer ${a.tag} differs.`);
    else if (a.tag === 10n) requireValue(a.value === BigInt(original.byName.get('.dynstr').size)
      && b.value === BigInt(deployed.byName.get('.dynstr').size), 'ELF dynamic string size differs.');
    else requireValue(a.value === b.value, `ELF dynamic tag ${a.tag} value differs.`);
  }
  requireValue(deployed.byName.get('.dynamic').size === original.byName.get('.dynamic').size
    + (oldPaths.length === 0 ? 16 : 0), 'ELF dynamic NULL padding size differs.');
  const a = original.byName.get('.dynstr').contents, b = deployed.byName.get('.dynstr').contents;
  requireValue(b.length === a.length || b.length === a.length + expectedString.length + 1,
    'ELF dynamic string inventory differs.');
  const oldRanges = map(oldPaths, entry => dynamicString(original, entry.value));
  const newRanges = map(newPaths, entry => dynamicString(deployed, entry.value));
  requireValue(newRanges.every(span => b.length > a.length ? span.at === a.length
    : oldRanges.some(old => old.at === span.at && span.end <= old.end)), 'ELF RPATH string placement differs.');
  for (let index = 0; index < b.length; index++) {
    if (newRanges.some(span => index >= span.at && index <= span.end)) continue;
    const oldPathByte = oldRanges.some(span => index >= span.at && index < span.end);
    requireValue(index < a.length && (b[index] === a[index] || (oldPathByte && b[index] === 88)),
      'ELF non-RPATH dynamic strings differ.');
  }
}

const relocatableNames = new Set(['.dynamic', '.dynstr', '.interp', ...[...pointerSections.values()].flat()]);
const relocatable = section => relocatableNames.has(section.name) || section.type === 7;
const roundUp = (value, alignment) => (value + alignment - 1n) / alignment * alignment;
const sameFields = (a, b, fields) => fields.every(field => a[field] === b[field]);
function mappedBy(section, program) {
  return section.address >= program.address
    && section.address + BigInt(section.size) <= program.address + BigInt(program.memorySize)
    && (section.type === NOBITS || (BigInt(section.offset) - BigInt(program.offset) === section.address - program.address
      && section.offset + section.size <= program.offset + program.fileSize));
}
function sectionLoads(elf, section) {
  // Thread-local NOBITS storage is instantiated by PT_TLS, not in the process
  // LOAD image. The TLS header itself must remain identical below.
  const segmentType = section.type === NOBITS && (section.flags & 1024n) ? 7 : 1;
  const mapped = filter(elf.programs, program => program.type === segmentType && mappedBy(section, program));
  requireValue(mapped.length > 0, `ELF ${section.name} is not mapped by a LOAD segment.`);
  return mapped;
}
function validateMetadataLoad(elf, program, moved) {
  requireValue(program.flags === 6 && program.fileSize === program.memorySize && program.physical === program.address,
    'ELF relocated metadata LOAD permissions or mapping differ.');
  const sections = sort(filter(moved, section => mappedBy(section, program)), (a, b) => a.offset - b.offset);
  requireValue(sections.length > 0, 'ELF new LOAD contains no relocated metadata.');
  const spans = map(sections, section => ({ offset: section.offset, size: section.size }));
  // Bundled Patchelf may place the actual section/program header table before
  // the relocated sections. These are the already parsed linker tables, not
  // an arbitrary unallocated payload.
  for (const [offset, size] of [[elf.table, elf.sections.length * 64], [elf.phOffset, elf.phSize]])
    if (offset >= program.offset && offset + size <= program.offset + program.fileSize) spans.push({ offset, size });
  let cursor = program.offset;
  for (const span of sort(spans, (a, b) => a.offset - b.offset)) {
    requireValue(span.offset === cursor, 'ELF new LOAD contains unexpected mapped data.');
    cursor += Number(roundUp(BigInt(span.size), 8n));
    requireValue(elf.bytes.subarray(span.offset + span.size, cursor).every(byte => byte === 0),
      'ELF metadata LOAD padding differs.');
  }
  requireValue(cursor === program.offset + program.fileSize, 'ELF metadata LOAD extent differs.');
}
function mappedHeader(elf, program, name) {
  const section = elf.byName.get(name);
  requireValue(section && program.offset === section.offset && program.address === section.address
    && program.physical === section.address && program.fileSize === section.size && program.memorySize === section.size,
    `ELF loader header does not map ${name}.`);
  return `${program.type}:${program.flags}:${program.alignment}:${name}`;
}
function canonicalHeaders(elf, original = elf) {
  const result = [];
  for (const program of filter(elf.programs, program => program.type !== 1)) {
    if (program.type === 2 || program.type === 3) result.push(mappedHeader(elf, program, program.type === 2 ? '.dynamic' : '.interp'));
    else if (program.type === 6) {
      requireValue(program.offset === elf.phOffset && program.fileSize === elf.phSize && program.memorySize === elf.phSize,
        'ELF PHDR table mapping differs.');
      const load = find(elf.programs, load => load.type === 1 && program.offset >= load.offset
        && program.offset + program.fileSize <= load.offset + load.fileSize
        && program.address - load.address === BigInt(program.offset - load.offset)
        && program.physical - load.physical === BigInt(program.offset - load.offset));
      requireValue(load, 'ELF PHDR table is not mapped by a LOAD segment.');
      result.push(`${program.type}:${program.flags}:${program.alignment}:program-table`);
    } else if (program.type === 0x6474e553) {
      const section = elf.byName.get('.note.gnu.property');
      if (section && program.offset === section.offset && program.address === section.address) {
        result.push(mappedHeader(elf, program, section.name));
      } else {
        // Ubuntu 22.04 Patchelf 0.14 retains this exact header when it relocates
        // the property section; its former bytes may overlap the enlarged PHDR
        // table. Preserve the original raw header, not a claimed current mapping.
        // Patchelf 0.18 also updates PT_GNU_PROPERTY in writeReplacedSections.
        const prior = find(original.programs, header => header.type === program.type
          && sameFields(header, program, Object.keys(program)));
        requireValue(prior, 'ELF retained GNU_PROPERTY header differs.');
        result.push(mappedHeader(original, prior, '.note.gnu.property'));
      }
    } else if (program.type === 4) {
      const notes = sort(filter([...elf.byName.values()], section => section.type === 7 && section.offset >= program.offset
        && section.offset + section.size <= program.offset + program.fileSize), (a, b) => a.offset - b.offset);
      requireValue(notes.length > 0 && program.fileSize === program.memorySize, 'ELF NOTE mapping is invalid.');
      let cursor = program.offset;
      for (const section of notes) {
        requireValue(section.offset === Number(roundUp(BigInt(cursor), section.alignment || 1n))
          && section.address - program.address === BigInt(section.offset - program.offset)
          && section.address - program.physical === BigInt(section.offset - program.offset), 'ELF NOTE mapping differs.');
        result.push(`${program.type}:${program.flags}:${program.alignment}:${section.name}`);
        cursor = section.offset + section.size;
      }
      requireValue(cursor === program.offset + program.fileSize, 'ELF NOTE extent differs.');
    } else result.push(map(Object.values(program), String).join(':'));
  }
  return sort(result, (a, b) => a < b ? -1 : a > b ? 1 : 0);
}
function compareProgramMappings(original, deployed) {
  const before = filter(original.programs, program => program.type === 1);
  const after = filter(deployed.programs, program => program.type === 1);
  for (const loads of [before, after]) requireValue(loads.every((program, index) => index === 0 || program.address > loads[index - 1].address),
    'ELF LOAD ordering differs.');
  requireValue(new Set(map(before, program => program.address)).size === before.length
    && new Set(map(after, program => program.address)).size === after.length, 'ELF LOAD addresses are duplicated.');
  const moved = [];
  for (const section of filter([...deployed.byName.values()], section => Boolean(section.flags & ALLOC))) {
    const old = original.byName.get(section.name);
    const leftLoads = sectionLoads(original, old), rightLoads = sectionLoads(deployed, section);
    if (section.address !== old.address) {
      requireValue(relocatable(section), `ELF ${section.name} executable/data address differs.`);
      moved.push(section);
    } else requireValue(sort(map(leftLoads, program => program.flags), (a, b) => String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0).join(',')
      === sort(map(rightLoads, program => program.flags), (a, b) => String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0).join(','), `ELF ${section.name} LOAD permissions differ.`);
  }
  const extra = filter(after, program => !before.some(old => old.address === program.address));
  requireValue(extra.length <= 1, 'ELF new LOAD inventory differs.');
  for (const left of before) {
    const right = find(after, program => program.address === left.address);
    requireValue(right && sameFields(left, right, ['flags', 'offset', 'address', 'physical', 'alignment']),
      'ELF existing LOAD permissions or mapping differ.');
    if (sameFields(left, right, ['fileSize', 'memorySize'])) continue;
    // Patchelf may extend its final RW LOAD rather than add another one.
    // https://github.com/NixOS/patchelf/blob/0.18.0/src/patchelf.cc#L802-L827
    const start = Number(roundUp(BigInt(original.bytes.length), 4096n));
    requireValue(left === before.at(-1) && extra.length === 0 && left.flags === 6
      && Number(roundUp(BigInt(left.offset + left.memorySize), 4096n)) === start
      && right.fileSize === right.memorySize && right.memorySize > left.memorySize,
    'ELF existing LOAD extent differs.');
    requireValue(deployed.bytes.subarray(left.offset + left.fileSize, left.offset + left.memorySize)
      .every(byte => byte === 0), 'ELF extended LOAD changes original zero-fill memory.');
    const extension = { ...right, offset: start, address: right.address + BigInt(start - right.offset),
      physical: right.physical + BigInt(start - right.offset), fileSize: right.offset + right.fileSize - start,
      memorySize: right.offset + right.memorySize - start };
    validateMetadataLoad(deployed, extension, moved);
  }
  if (extra.length) {
    // ET_DYN RPATH growth appends only replaced linker sections in one RW/NX
    // LOAD. Existing executable/data mappings remain byte-for-byte equivalent.
    // https://github.com/NixOS/patchelf/blob/0.18.0/src/patchelf.cc#L729-L827
    requireValue(original.bytes.readUInt16LE(16) === 3, 'Unsupported executable metadata LOAD relocation.');
    const added = extra[0], page = 4096n;
    const pageStart = added.address / page * page, pageEnd = roundUp(added.address + BigInt(added.memorySize), page);
    requireValue(added.offset >= original.bytes.length && added.alignment >= page
      && added.address % page === BigInt(added.offset) % page
      && before.every(program => pageEnd <= program.address / page * page
        || pageStart >= roundUp(program.address + BigInt(program.memorySize), page)),
      'ELF relocated metadata LOAD placement differs.');
    validateMetadataLoad(deployed, added, moved);
  }
  const leftHeaders = canonicalHeaders(original), rightHeaders = canonicalHeaders(deployed, original);
  requireValue(leftHeaders.length === rightHeaders.length && leftHeaders.every((header, index) => header === rightHeaders[index]),
    'ELF program loader headers differ.');
}

export function compareElfIdentity(originalBytes, deployedBytes) {
  const original = parseElf(originalBytes), deployed = parseElf(deployedBytes);
  requireValue(original.bytes.subarray(0, 32).equals(deployed.bytes.subarray(0, 32))
    && original.bytes.readUInt32LE(48) === deployed.bytes.readUInt32LE(48), 'ELF executable identity/entry point differs.');
  const allocated = elf => filter([...elf.byName.values()], section => Boolean(section.flags & ALLOC));
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
  compareLinkerMetadata(original, deployed);
  compareProgramMappings(original, deployed);
  return sort(map(before, section => section.name), (a, b) => a < b ? -1 : a > b ? 1 : 0);
}

export function compareDynamicIdentity(original, deployed) {
  requireValue(Array.isArray(original.needed) && Array.isArray(deployed.needed)
    && original.needed.length === deployed.needed.length
    && original.needed.every((name, index) => name === deployed.needed[index]), 'AppImage needed libraries differ.');
  requireValue(typeof original.interpreter === 'string' && original.interpreter.startsWith('/')
    && original.interpreter === deployed.interpreter, 'AppImage ELF interpreter differs.');
  requireValue(deployed.rpath === APPIMAGE_RPATH, 'AppImage RPATH differs from the pinned Linuxdeploy path.');
}
