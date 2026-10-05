import { describe, expect, it } from 'vitest';
import { BitWriter } from './binary';
import { decodeWorld, validateWorldAction, worldCommand, WORLD_OP, type WorldAction } from './world-protocol';

const regular = (w: BitWriter, itemId = 512, count = 10) => w.i32(itemId).i16(count);
const partyMember = (w: BitWriter, online: boolean) => {
  w.i32(5).i32(online ? 100 : -1).i16(9).string('Raon').u8(1);
  if (online) w.string('prt_fild08').i32(70).i32(81).i32(20).i32(30);
  return w;
};

describe('world packet decoder', () => {
  it.each([0, 1, 255])('decodes the deployed one-member party header byte %i before its count', header => {
    // The deployed WebGL reader consumes an extra byte after PartyName; the
    // upstream source pin omits it. Leaving it unread shifts count 1 to 256+header.
    const bytes = partyMember(new BitWriter().u8(101).u8(1).i32(3).string('Helpers').u8(header).i32(1), true).finish();
    expect(decodeWorld(bytes)).toEqual([{ type: 'partyJoined', partyId: 3, name: 'Helpers', login: true,
      members: [{ memberId: 5, entityId: 100, level: 9, name: 'Raon', leader: true, map: 'prt_fild08', hp: 70, maxHp: 81, sp: 20, maxSp: 30 }] }]);
  });
  it('decodes the observed two-member snapshot with eight opaque trailing bytes', () => {
    const writer = new BitWriter().u8(101).u8(1).i32(3).string('Helpers').u8(1).i32(2);
    partyMember(writer, true);
    writer.i32(6).i32(0).i16(-1).string('Offline').u8(0);
    writer.take(Uint8Array.of(0, 255, 1, 128, 42, 99, 254, 2));
    expect(decodeWorld(writer.finish())).toMatchObject([{ type: 'partyJoined', partyId: 3, name: 'Helpers',
      members: [{ memberId: 5, entityId: 100, map: 'prt_fild08' }, { memberId: 6, entityId: 0, level: -1 }] }]);
  });
  it.each([1, 7, 9, 16])('rejects an unverified %i-byte party snapshot trailer', length => {
    const bytes = partyMember(new BitWriter().u8(101).u8(1).i32(3).string('Helpers').u8(0).i32(1), true)
      .take(new Uint8Array(length)).finish();
    expect(() => decodeWorld(bytes)).toThrow('Unknown packet trailer');
  });
  it('decodes one-bit booleans and ignores pooled-buffer bits outside the payload', () => {
    expect(decodeWorld(Uint8Array.from([77, 0, 123, 0, 0, 0, 1]))).toEqual([{ type: 'npcFocus', id: 123, focus: true }]);
    const bytes = new BitWriter().u8(77).u8(1).string('Kafra').string('Storage?').bool(true).finish();
    expect(decodeWorld(bytes)).toEqual([{ type: 'npcDialog', name: 'Kafra', text: 'Storage?', big: true }]);
    const pooled = Uint8Array.from(bytes); pooled[pooled.length - 1]! |= 128;
    expect(decodeWorld(pooled)).toEqual(decodeWorld(bytes));
  });
  it('preserves blank NPC options and their zero-based indexes', () => {
    const bytes = new BitWriter().u8(77).u8(2).i32(3).string('Storage').string('').string('Cancel').finish();
    expect(decodeWorld(bytes)).toEqual([{ type: 'npcOptions', options: ['Storage', '', 'Cancel'] }]);
  });
  it('consumes the server sprite position byte after the asset name', () => {
    // CommandBuilder.SendNpcShowSprite writes subtype4,string,byte position.
    expect(decodeWorld(Uint8Array.from([77, 4, 1, 0, 65, 0]))).toEqual([{ type: 'npcSprite', sprite: 'A', position: 0 }]);
    expect(() => decodeWorld(Uint8Array.from([77, 4, 1, 0, 65]))).toThrow('Truncated');
  });
  it.each([3, 5])('decodes NPC empty subtype %i', subtype => {
    expect(decodeWorld(Uint8Array.from([77, subtype]))).toEqual([{ type: subtype === 3 ? 'npcEnd' : 'npcRefine' }]);
  });
  it('ignores source-unverified NPC subtypes and unrelated opcodes', () => {
    expect(decodeWorld(Uint8Array.from([77, 7, 99, 0]))).toBeNull();
    expect(decodeWorld(Uint8Array.from([11, 1]))).toBeNull();
  });
  it('decodes buy and sell context separately', () => {
    // SendNpcSellToShop writes MaxLearnedLevelOfSkill as int32; buy is byte.
    expect(decodeWorld(Uint8Array.from([83, 0, 3, 0, 0, 0]))).toEqual([{ type: 'shopOpened', mode: 'sell', discountLevel: 3, entries: [] }]);
    const bytes = new BitWriter().u8(83).u8(1).u8(10).i32(1).i32(512).i32(100).finish();
    expect(decodeWorld(bytes)).toEqual([{ type: 'shopOpened', mode: 'buy', discountLevel: 10, entries: [{ itemId: 512, price: 100 }] }]);
    expect(() => decodeWorld(Uint8Array.from([83, 0, 3]))).toThrow('Truncated');
  });
  it('decodes storage snapshots and positive transfer deltas', () => {
    const opened = regular(new BitWriter().u8(84).u8(1).i32(1)).i32(0).finish();
    expect(decodeWorld(opened)).toEqual([{ type: 'storageOpened', items: [{ bagId: 512, itemId: 512, count: 10, type: 1 }] }]);
    const moved = regular(new BitWriter().u8(86).u8(1).i32(512).i16(2)).i32(100).i32(10).bool(true).finish();
    expect(decodeWorld(moved)).toEqual([{ type: 'storageMoved', item: { bagId: 512, itemId: 512, count: 10, type: 1 }, change: 2, currentWeight: 100, storageCount: 10, deposit: true }]);
  });
  it('decodes cart deltas in their distinct field order', () => {
    const bytes = regular(new BitWriter().u8(89).u8(2).i32(512).u8(1), 512, 2).i16(2).i32(400).i32(500).finish();
    expect(decodeWorld(bytes)).toEqual([{ type: 'cartMoved', direction: 2, item: { bagId: 512, itemId: 512, count: 2, type: 1 }, change: 2, cartWeight: 400, currentWeight: 500 }]);
  });
  it('decodes barter choice output and regular requirements', () => {
    const bytes = regular(new BitWriter().u8(85).u8(1).u8(1), 513, 1).i32(2).i32(100).i32(1).i32(512).i16(3).finish();
    expect(decodeWorld(bytes)).toEqual([{ type: 'barterOpened', offers: [{ item: { bagId: 513, itemId: 513, type: 1, count: 1 }, count: 2, zenyCost: 100, required: [{ itemId: 512, count: 3 }] }] }]);
  });
  it.each([true, false])('decodes online=%s party snapshots without guessing omitted fields', online => {
    const bytes = partyMember(new BitWriter().u8(101).u8(1).i32(3).string('Helpers').u8(0).i32(1), online).finish();
    const decoded = decodeWorld(bytes)!;
    expect(decoded[0]).toMatchObject({ type: 'partyJoined', partyId: 3, name: 'Helpers', login: true, members: [{ memberId: 5, entityId: online ? 100 : -1, name: 'Raon', leader: true }] });
    if (online) expect(decoded[0]).toMatchObject({ members: [{ map: 'prt_fild08', hp: 70, maxHp: 81, sp: 20, maxSp: 30 }] });
  });
  it('accepts the persisted offline party sentinel entityId0/level-1', () => {
    const bytes = new BitWriter().u8(101).u8(1).i32(3).string('Helpers').u8(0).i32(1)
      .i32(5).i32(0).i16(-1).string('Offline').u8(0).finish();
    expect(decodeWorld(bytes)).toEqual([{ type: 'partyJoined', partyId: 3, name: 'Helpers', login: true, members: [{ memberId: 5, entityId: 0, level: -1, name: 'Offline', leader: false }] }]);
  });
  it.each([32, 33, 256])('decodes a server party snapshot with %i members', count => {
    // Party.SerializePartyInfo writes the entire persisted roster as an int32
    // count; neither the pinned writer nor AddMember imposes a 32-member cap.
    const members = Array.from({ length: count }, (_, index) => ({
      memberId: index + 1, entityId: 0, level: -1, name: `Member ${index + 1}`, leader: false,
    }));
    const writer = new BitWriter().u8(101).u8(1).i32(3).string('Helpers').u8(0).i32(members.length);
    for (const row of members) writer.i32(row.memberId).i32(row.entityId).i16(row.level).string(row.name).u8(row.leader ? 1 : 0);
    expect(decodeWorld(writer.finish())).toEqual([{ type: 'partyJoined', partyId: 3, name: 'Helpers', login: true, members }]);
  });
  it.each([0, -1, 2_147_483_647])('rejects impossible party count %i before allocating the roster', count => {
    const bytes = new BitWriter().u8(101).u8(1).i32(3).string('Helpers').u8(0).i32(count).finish();
    expect(() => decodeWorld(bytes)).toThrow('Invalid party count');
  });
  it('rejects missing, duplicate and trailing data in a large party snapshot', () => {
    const packet = (count: number, duplicate = false) => {
      const writer = new BitWriter().u8(101).u8(1).i32(3).string('Helpers').u8(0).i32(count);
      for (let index = 0; index < 33; index++) writer.i32(duplicate && index === 32 ? 1 : index + 1).i32(0).i16(-1).string('').u8(0);
      return writer;
    };
    // Empty names give the minimum 13-byte record, making the count budget exact.
    expect(() => decodeWorld(packet(34).finish())).toThrow('Invalid party count');
    expect(() => decodeWorld(packet(33, true).finish())).toThrow('Duplicate party member');
    expect(() => decodeWorld(packet(33, true).take(new Uint8Array(8)).finish())).toThrow('Duplicate party member');
    expect(() => decodeWorld(packet(34).take(new Uint8Array(8)).finish())).toThrow('Invalid party count');
    expect(() => decodeWorld(packet(33).u8(0).finish())).toThrow('Unknown packet trailer');
    expect(() => decodeWorld(packet(33).finish().subarray(0, -1))).toThrow();
  });
  it('accepts an unknown map while a live party member finishes logging in', () => {
    const bytes = new BitWriter().u8(102).u8(3).i32(5).i32(100).i16(9).string('Raon').u8(0)
      .string('').i32(70).i32(81).i32(20).i32(30).finish();
    expect(decodeWorld(bytes)).toEqual([{ type: 'partyMember', change: 'login', member: { memberId: 5, entityId: 100, level: 9, name: 'Raon', leader: false, hp: 70, maxHp: 81, sp: 20, maxSp: 30 } }]);
  });
  it('still rejects an unknown live level and malformed known party maps', () => {
    const packet = (level: number, map: string) => new BitWriter().u8(102).u8(3).i32(5).i32(100).i16(level).string('Raon').u8(0)
      .string(map).i32(70).i32(81).i32(20).i32(30).finish();
    expect(() => decodeWorld(packet(-1, 'prontera'))).toThrow('party level');
    expect(() => decodeWorld(packet(9, '../secret'))).toThrow('map');
  });
  it('decodes invitation and party health/map updates', () => {
    expect(decodeWorld(new BitWriter().u8(100).i32(3).string('Helpers').string('Raon').finish())).toEqual([{ type: 'partyInvite', partyId: 3, name: 'Helpers', sender: 'Raon' }]);
    expect(decodeWorld(new BitWriter().u8(102).u8(8).i32(5).i32(7).i32(10).i32(2).i32(5).finish())).toEqual([{ type: 'partyHealth', memberId: 5, hp: 7, maxHp: 10, sp: 2, maxSp: 5 }]);
    expect(decodeWorld(new BitWriter().u8(102).u8(9).i32(5).string('prontera').finish())).toEqual([{ type: 'partyMap', memberId: 5, map: 'prontera' }]);
  });
  it.each([true, false])('decodes the deployed member update extension online=%s', online => {
    const writer = partyMember(new BitWriter().u8(WORLD_OP.partyUpdate).u8(2), online);
    const legacy = writer.finish();
    // The deployed V8 reader stops after the member record. Live subtype 2
    // has four additional bytes, whose meaning is unverified.
    expect(decodeWorld(writer.i32(0x12345678).finish())).toEqual(decodeWorld(legacy));
  });
  it.each([1, 2, 3, 5, 8])('rejects a member update with %i trailing bytes', length => {
    const bytes = partyMember(new BitWriter().u8(WORLD_OP.partyUpdate).u8(2), true)
      .take(new Uint8Array(length)).finish();
    expect(() => decodeWorld(bytes)).toThrow('Unknown packet trailer');
  });
  it.each([0, 3, 4])('rejects an unverified four-byte extension on member subtype %i', subtype => {
    const bytes = partyMember(new BitWriter().u8(WORLD_OP.partyUpdate).u8(subtype), true)
      .i32(0x12345678).finish();
    expect(() => decodeWorld(bytes)).toThrow('Unknown packet trailer');
  });
  it('validates member fields before accepting the deployed extension', () => {
    const bytes = new BitWriter().u8(WORLD_OP.partyUpdate).u8(2).i32(5).i32(100).i16(9)
      .string('Test').u8(0).string('prontera').i32(82).i32(81).i32(20).i32(30)
      .i32(0x12345678).finish();
    expect(() => decodeWorld(bytes)).toThrow('Invalid party health');
    expect(() => decodeWorld(bytes.subarray(0, 20))).toThrow('Truncated packet');
  });
  it('decodes vending own rows, viewed typed items, sales, and stop', () => {
    expect(decodeWorld(new BitWriter().u8(105).string('Supplies').i32(1).i32(512).i32(2).i32(30).finish())).toEqual([{ type: 'vendingStarted', name: 'Supplies', rows: [{ id: 512, count: 2, price: 30 }] }]);
    const viewed = regular(new BitWriter().u8(107).i32(123).string('Supplies').i32(1).i32(512).u8(1), 512, 2).i32(30).finish();
    expect(decodeWorld(viewed)).toEqual([{ type: 'vendingViewed', id: 123, name: 'Supplies', entries: [{ item: { bagId: 512, itemId: 512, type: 1, count: 2 }, price: 30 }] }]);
    expect(decodeWorld(new BitWriter().u8(108).i32(512).i32(1).finish())).toEqual([{ type: 'vendingSale', bagId: 512, count: 1 }]);
    expect(decodeWorld(Uint8Array.from([106]))).toEqual([{ type: 'vendingStopped' }]);
  });
  it.each([
    new BitWriter().u8(77).u8(2).i32(33).finish(),
    new BitWriter().u8(83).u8(1).u8(0).i32(601).finish(),
    new BitWriter().u8(101).u8(0).i32(1).string('P').u8(0).i32(33).finish(),
    new BitWriter().u8(89).u8(3).finish(),
    Uint8Array.from([77, 3, 0]),
    Uint8Array.from([77, 0, 1]),
  ])('rejects malformed known packets', bytes => { expect(() => decodeWorld(bytes)).toThrow(); });
});

describe('normal world action writers', () => {
  it.each<[WorldAction, number[]]>([
    [{ type: 'npcTalk', id: 123 }, [76, 123, 0, 0, 0]],
    [{ type: 'npcAdvance' }, [78]],
    [{ type: 'npcOption', index: 2 }, [79, 2, 0, 0, 0]],
    [{ type: 'storage', operation: 'close' }, [86, 0]],
    [{ type: 'storage', operation: 'deposit', bagId: 1, count: 2 }, [86, 1, 1, 0, 0, 0, 2, 0, 0, 0]],
    [{ type: 'storage', operation: 'withdraw', bagId: 1, count: 2 }, [86, 2, 1, 0, 0, 0, 2, 0, 0, 0]],
    [{ type: 'shop', mode: 'sell', rows: [{ id: 1, count: 2 }] }, [87, 1, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0]],
    [{ type: 'shop', mode: 'buy', rows: [] }, [87, 0, 0, 0, 0]],
    [{ type: 'cart', direction: 1, bagId: 123, count: 2 }, [89, 123, 0, 0, 0, 2, 0, 1]],
    [{ type: 'npcBarterCancel' }, [88, 255, 255, 255, 255]],
    [{ type: 'npcBarter', choice: 0, count: 2, bagIds: [123] }, [88, 0, 0, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0, 123, 0, 0, 0]],
    [{ type: 'partyInviteId', id: 123 }, [100, 0, 123, 0, 0, 0]],
    [{ type: 'partyInviteName', name: 'A' }, [100, 1, 1, 0, 65]],
    [{ type: 'partyAccept', partyId: 3 }, [101, 3, 0, 0, 0]],
    [{ type: 'partyCreate', name: 'P' }, [99, 1, 0, 80, 255, 255, 255, 255]],
    [{ type: 'partyLeave' }, [102, 0]],
    [{ type: 'partyLeader', memberId: 5 }, [102, 1, 5, 0, 0, 0]],
    [{ type: 'partyRemove', memberId: 5 }, [102, 2, 5, 0, 0, 0]],
    [{ type: 'partyDisband' }, [102, 3, 255, 255, 255, 255]],
    [{ type: 'vendingStop' }, [106]],
    [{ type: 'vendingView', id: 123 }, [107, 123, 0, 0, 0]],
    [{ type: 'vendingPurchase', rows: [{ id: 1, count: 2 }] }, [109, 1, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0]],
    [{ type: 'vendingStart', name: 'S', rows: [{ id: 1, count: 2, price: 3 }] }, [105, 1, 0, 83, 1, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0]],
  ])('matches source request bytes for $0.type', (action, bytes) => { expect([...worldCommand(action)]).toEqual(bytes); });
  it.each([
    { type: 'npcAdvance', id: 1 }, { type: 'npcTalk', id: -1 }, { type: 'npcOption', index: 32 },
    { type: 'partyCreate', name: 'x'.repeat(33) }, { type: 'vendingStart', name: 'Shop', rows: [] },
    { type: 'npcBarter', choice: 0, count: 100, bagIds: [] }, { type: 'npcBarter', choice: 0, count: 1, bagIds: Array.from({ length: 11 }, (_, i) => i + 1) },
    { type: 'cart', direction: 3, bagId: 1, count: 1 },
    { type: 'shop', mode: 'buy', rows: [{ id: 1, count: 1 }, { id: 1, count: 2 }] },
    { type: 'adminTeleport', map: 'prontera' }, { type: 'npcTalk', id: NaN },
  ])('rejects invalid or unscoped actions %j', action => { expect(() => validateWorldAction(action)).toThrow(); });
  it('does not accidentally expose privileged opcodes', () => {
    expect(Object.values(WORLD_OP).some(opcode => opcode >= 64 && opcode <= 75)).toBe(false);
  });
});
