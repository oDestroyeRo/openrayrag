import { describe, expect, it } from 'vitest';
import { WorldState } from './world-state';
import { ActorObservations, evaluateActorPredicate } from './actor-observations';
import type { Entity } from './protocol';
import type { InventoryItem } from './protocol-feature';
import type { PartyMember } from './world-protocol';

const item = (count: number, bagId = 512): InventoryItem => ({ bagId, itemId: 512, type: 1, count });
const member: PartyMember = { memberId: 5, entityId: 100, name: 'Raon', level: 9, leader: true, map: 'prt_fild08', hp: 70, maxHp: 81, sp: 20, maxSp: 30 };

describe('server-owned world state', () => {
  it('invalidates old NPC contexts when focus changes or dialog advances', () => {
    const world = new WorldState(); world.reset('prt_fild08');
    world.apply({ type: 'npcFocus', id: 123, focus: true });
    world.apply({ type: 'npcOptions', options: ['Storage', '', 'Cancel'] });
    expect(world.npc).toMatchObject({ id: 123, mode: 'options', options: ['Storage', '', 'Cancel'] });
    world.apply({ type: 'npcDialog', name: 'Kafra', text: 'Hello', big: false });
    expect(world.npc.options).toEqual([]);
    world.apply({ type: 'npcFocus', id: 124, focus: true });
    expect(world.npc).toEqual({ id: 124, mode: 'idle', dialog: null, options: [] });
  });
  it('replaces storage snapshots and applies deposits as absolute counts', () => {
    const world = new WorldState();
    world.apply({ type: 'storageOpened', items: [item(10)] });
    world.apply({ type: 'storageMoved', item: item(12), change: 2, currentWeight: 50, storageCount: 12, deposit: true });
    expect(world.storage.get(512)?.count).toBe(12);
    world.apply({ type: 'storageMoved', item: item(2), change: 2, currentWeight: 70, storageCount: 10, deposit: false });
    expect(world.storage.get(512)?.count).toBe(10);
    world.apply({ type: 'storageOpened', items: [] });
    expect(world.storage.size).toBe(0);
  });
  it('does not reconstruct a missing storage snapshot from late transfers', () => {
    const world = new WorldState(); world.apply({ type: 'storageOpened', items: [item(10)] }); world.reset('prontera');
    world.apply({ type: 'storageMoved', item: item(12), change: 2, currentWeight: 50, storageCount: 12, deposit: true });
    expect(world.storage.size).toBe(0); expect(world.storageReady).toBe(false);
  });
  it('marks inconsistent withdrawal state unavailable instead of guessing counts', () => {
    const world = new WorldState(); world.apply({ type: 'storageOpened', items: [item(1)] });
    world.apply({ type: 'storageMoved', item: item(2), change: 2, currentWeight: 70, storageCount: 0, deposit: false });
    expect(world.storageReady).toBe(false); expect(world.storage.get(512)?.count).toBe(1);
  });
  it('uses cart absolute deposits and removal deltas without inventory mutation', () => {
    const world = new WorldState(); world.replaceCart([item(10)]);
    world.apply({ type: 'cartMoved', direction: 1, item: item(12), change: 2, cartWeight: 500, currentWeight: 50 });
    expect(world.cart.get(512)?.count).toBe(12);
    world.apply({ type: 'cartMoved', direction: 2, item: item(2), change: 2, cartWeight: 400, currentWeight: 150 });
    expect(world.cart.get(512)?.count).toBe(10);
    world.replaceCart(undefined); expect(world.cart.get(512)?.count).toBe(10); expect(world.hasCart).toBe(true);
  });
  it('preserves persistent party/cart across map changes but resets them on reconnect', () => {
    const world = new WorldState(); world.reset('prt_fild08'); world.replaceCart([item(10)]);
    world.apply({ type: 'partyJoined', partyId: 3, name: 'Helpers', login: true, members: [member] });
    world.apply({ type: 'vendingStarted', name: 'Shop', rows: [{ id: 512, count: 2, price: 30 }] });
    const generation = world.generation; world.reset('prontera', true);
    expect(world.generation).toBe(generation + 1); expect(world.party?.id).toBe(3); expect(world.cart.size).toBe(1); expect(world.vending).toBeNull();
    world.reset('prontera'); expect(world.party).toBeNull(); expect(world.cart.size).toBe(0); expect(world.hasCart).toBe(false);
  });
  it('updates party maps and HP/SP and clears membership on self removal', () => {
    const world = new WorldState(); world.apply({ type: 'partyJoined', partyId: 3, name: 'Helpers', login: true, members: [member] });
    world.apply({ type: 'partyMap', memberId: 5, map: 'prontera' });
    world.apply({ type: 'partyHealth', memberId: 5, hp: 50, maxHp: 81, sp: 10, maxSp: 30 });
    expect(world.party?.members.get(5)).toMatchObject({ map: 'prontera', hp: 50, sp: 10 });
    world.apply({ type: 'partyRemove', memberId: 5 }, 100); expect(world.party).toBeNull();
  });
  it('clears the whole party on known own-zero removal but does not treat offline zero as positive membership',()=>{
    for(const self of [null,1,0]){const world=new WorldState();world.apply({type:'partyJoined',partyId:3,name:'Helpers',login:false,members:[member,{...member,memberId:8,entityId:0,name:'Own'}]});
      world.apply({type:'partyRemove',memberId:8},self);if(self===0)expect(world.party).toBeNull();else expect([...world.party!.members.keys()]).toEqual([5]);}
  });
  it('tracks actual vending sales and clears an ended viewed store', () => {
    const world = new WorldState(); world.replaceCart([item(10)]);
    world.apply({ type: 'vendingStarted', name: 'Supplies', rows: [{ id: 512, count: 4, price: 30 }] });
    world.apply({ type: 'vendingSale', bagId: 512, count: 2 });
    expect(world.vending?.rows[0]?.count).toBe(2); expect(world.cart.get(512)?.count).toBe(8);
    world.apply({ type: 'vendingStopped' }); expect(world.vending).toBeNull(); expect(world.npc.mode).toBe('idle');
    world.apply({ type: 'vendingViewed', id: 200, name: 'Shop', entries: [{ item: item(2), price: 20 }] });
    expect(world.npc.mode).toBe('vending'); world.apply({ type: 'npcEnd' }); expect(world.viewedVending).toBeNull();
  });
  it('returns independent nested snapshots', () => {
    const world = new WorldState(); world.apply({ type: 'storageOpened', items: [{ ...item(1), type: 2, slots: [1, 2, 3, 4] }] });
    world.apply({ type: 'partyJoined', partyId: 3, name: 'Helpers', login: true, members: [member] });
    const snapshot = world.snapshot(); snapshot.storage[0]!.count = 9; snapshot.storage[0]!.slots![0] = 999; snapshot.party!.members[0]!.name = 'Changed';
    expect(world.storage.get(512)?.count).toBe(1); expect(world.storage.get(512)?.slots?.[0]).toBe(1); expect(world.party?.members.get(5)?.name).toBe('Raon');
  });
});

describe('world-owned party observations', () => {
  const map = 'prt_fild08';
  const row = (id: number): PartyMember => ({ ...member, memberId: id, entityId: 100 + id, name: `Member${id}`, leader: id === 1 });
  const actor = (member: PartyMember): Entity => ({ id: member.entityId, name: member.name, kind: 0, classId: 0,
    level: member.level, hp: 81, maxHp: 81, x: 10, y: 10, dead: false, partyId: 3, partyName: 'Helpers' });
  function fixture(count = 1) {
    const observations = new ActorObservations(() => 1000), world = new WorldState();
    world.reset(map);
    const rows = Array.from({ length: 34 }, (_, index) => row(index + 1));
    for (const member of rows) observations.spawn(actor(member));
    observations.frame();
    world.observe({ type: 'partyJoined', partyId: 3, name: 'Helpers', login: false, members: rows.slice(0, count) }, observations, 0);
    const resource = (id: number) => evaluateActorPredicate({ field: 'actorSpPercent', actor: { scope: 'target' }, operator: 'gte', value: 0 },
      observations.snapshot(0, row(id).entityId, true));
    const bindings = () => [...world.party!.members.keys()].filter(id => world.partyActors.get(id));
    return { world, observations, rows, resource, bindings };
  }

  it('supplies detached prior rows and the mutated roster before binding revocation', () => {
    const f = fixture();
    expect(f.resource(1).state).toBe('matched');
    let observed = false;
    f.world.observe({ type: 'partyMap', memberId: 1, map: 'prontera' }, f.observations, 0, before => {
      observed = true;
      expect(before?.members.get(1)?.map).toBe(map);
      expect(f.world.party?.members.get(1)?.map).toBe('prontera');
      expect(f.world.partyActors.get(1)).not.toBeNull();
      before!.members.get(1)!.name = 'Detached';
      before!.members.delete(1);
    });
    expect(observed).toBe(true);
    expect(f.world.party?.members.get(1)?.name).toBe('Member1');
    expect(f.world.partyActors.get(1)).toBeNull();
    expect(f.resource(1).state).toBe('unavailable');
  });

  it.each([32, 33])('preserves a full %i-row roster and the separate incremental and actor-association limits', count => {
    const f = fixture(count), next = row(count + 1);
    expect(f.world.party?.members.size).toBe(count);
    expect(f.bindings()).toHaveLength(32);
    f.world.observe({ type: 'partyMember', change: 'add', member: next }, f.observations, 0);
    expect(f.world.party?.members.size).toBe(count);
    expect(f.world.party?.members.has(next.memberId)).toBe(false);
    expect(f.world.partyActors.get(next.memberId)).toBeNull();
    expect(f.resource(next.memberId).state).toBe('unavailable');

    const retained = row(count);
    f.world.observe({ type: 'partyMember', change: 'update', member: { ...retained, sp: 25 } }, f.observations, 0);
    expect(f.world.party?.members.get(count)?.sp).toBe(25);
    expect(f.world.partyActors.get(count) === null).toBe(count === 33);
    expect(f.bindings()).toHaveLength(32);

    // Removing a bound row frees association capacity. At 33 rows the existing
    // overflow row may update; at 32 rows a new incremental row may now enter.
    f.world.observe({ type: 'partyRemove', memberId: 1 }, f.observations, 0);
    expect(f.world.partyActors.get(1)).toBeNull();
    expect(f.resource(1).state).toBe('unavailable');
    f.world.observe({ type: 'partyMember', change: count === 33 ? 'update' : 'add', member: row(33) }, f.observations, 0);
    expect(f.world.party?.members.size).toBe(32);
    expect(f.bindings()).toHaveLength(32);
    expect(f.world.partyActors.get(33)).not.toBeNull();
    expect(f.resource(33).state).toBe('matched');
    f.world.observe({ type: 'partyMember', change: 'add', member: row(34) }, f.observations, 0);
    expect(f.world.party?.members.has(34)).toBe(false);
    expect(f.world.partyActors.get(34)).toBeNull();
  });

  it('uses overflow full-roster rows to revoke conflicting entity associations', () => {
    const f = fixture(32), duplicate = { ...row(1), memberId: 33 };
    f.world.observe({ type: 'partyJoined', partyId: 3, name: 'Helpers', login: false, members: [...f.rows.slice(0, 32), duplicate] }, f.observations, 0);
    expect(f.world.party?.members.size).toBe(33);
    expect(f.bindings()).toHaveLength(31);
    expect(f.world.partyActors.get(1)).toBeNull();
    expect(f.world.partyActors.get(33)).toBeNull();
    expect(f.resource(1).state).toBe('unavailable');
    f.world.observe({ type: 'partyRemove', memberId: 33 }, f.observations, 0);
    f.world.observe({ type: 'partyHealth', memberId: 1, hp: 70, maxHp: 81, sp: 20, maxSp: 30 }, f.observations, 0);
    expect(f.world.partyActors.get(1)).toBeNull();
    expect(f.resource(1).state).toBe('unavailable');
    f.world.observe({ type: 'partyMember', change: 'update', member: row(1) }, f.observations, 0);
    expect(f.world.partyActors.get(1)).not.toBeNull();
    expect(f.resource(1).state).toBe('matched');
  });
});
