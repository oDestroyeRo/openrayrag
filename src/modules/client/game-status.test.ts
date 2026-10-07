import { describe, expect, it } from 'vitest';
import { CompanionController } from '../runtime/controller';
import { DEFAULT_MAP_POLICY } from '../navigation/map-policy';
import { statusHeartbeatFresh, validStatus } from './game-status';
import type { Entity } from '../protocol/protocol';
const player: Entity = {
  id: 1,
  kind: 0,
  classId: 0,
  name: 'Fixture',
  level: 1,
  hp: 100,
  maxHp: 100,
  x: 169,
  y: 193,
  dead: false,
  statuses: [],
};
describe('native full status and heartbeat boundary during route planning', () => {
  it('accepts fresh resource predicates through the canonical status boundary and retains other owners', () => {
    const c = new CompanionController(
      () => {},
      () => 100_000,
    );
    c.connect(true);
    c.engine.receive([
      { type: 'enter', id: 1, map: 'prt_fild08' },
      { type: 'spawn', entity: { ...player, sp: 50, maxSp: 100 } },
    ]);
    c.world.reset('prt_fild08');
    const status = {
      ...c.snapshot(),
      sessionId: 'offline-resource-fixture',
      login: { phase: 'complete', message: '' },
      reconnectAvailable: false,
      mapInfo: { code: 'prt_fild08', name: 'Field', source: 'observed', monsters: [] },
    };
    expect(validStatus(status)).toBe(true);
    expect(validStatus({ ...status, initialFieldEntryPending: true })).toBe(true);
    expect(validStatus({ ...status, initialFieldEntryPending: 'pending' })).toBe(false);
    const historical = { ...status };
    delete historical.initialFieldEntryPending;
    expect(validStatus(historical)).toBe(true);
    expect(status.actorObservations.actors[0]).toMatchObject({
      hp: { value: 100, max: 100, source: 'spawn' },
      sp: { value: 50, max: 100, source: 'spawn' },
    });
    for (const connectionMode of ['botOnly', 'gameClient'])
      expect(validStatus({ ...status, connectionMode })).toBe(true);
    expect(validStatus({ ...status, connectionMode: 'unverified' })).toBe(false);
    expect(status.memo).toBeDefined();
    expect(status.socket).toBeDefined();
    expect(status.manualTarget).toBeDefined();
    const malformed = structuredClone(status);
    Object.assign(malformed.actorObservations.actors[0]!.hp!, { max: 0 });
    expect(validStatus(malformed)).toBe(false);
    expect(validStatus({ ...status, memo: { ...status.memo, blocked: 'invalid' } })).toBe(false);
    expect(validStatus({ ...status, socket: { ...status.socket, pending: 'invalid' } })).toBe(
      false,
    );
  });
  it('accepts real planning telemetry through the full predicate and keeps heartbeat fresh past seven seconds', () => {
    const c = new CompanionController(
      () => {},
      () => 100_000,
    );
    c.connect(true);
    c.engine.receive([
      { type: 'enter', id: 1, map: 'prt_fild08' },
      { type: 'spawn', entity: player },
    ]);
    c.world.reset('prt_fild08');
    c.travel.start('prt_fild08', player, 'payon', 10, true, {
      ...DEFAULT_MAP_POLICY,
      mode: 'weighted',
    });
    let receivedAt = 100_000;
    try {
      for (let seconds = 0; seconds <= 8; seconds++) {
        const status = {
          ...c.snapshot(),
          sessionId: 'offline-fixture',
          login: { phase: 'complete', message: '' },
          reconnectAvailable: false,
          mapInfo: { code: 'prt_fild08', name: 'Field', source: 'observed', monsters: [] },
        };
        expect(status.travel.state).toBe('planning');
        expect(status.state).toBe('running');
        expect(validStatus(status)).toBe(true);
        expect(status.memo).toBeDefined();
        expect(status.socket).toBeDefined();
        expect(validStatus({ ...status, memo: { ...status.memo, blocked: 'invalid' } })).toBe(
          false,
        );
        expect(validStatus({ ...status, socket: { ...status.socket, pending: 'invalid' } })).toBe(
          false,
        );
        receivedAt = 100_000 + seconds * 1000;
        expect(statusHeartbeatFresh(receivedAt, receivedAt + 1000)).toBe(true);
      }
      expect(statusHeartbeatFresh(receivedAt, receivedAt + 7001)).toBe(false);
    } finally {
      c.stop();
    }
  });
});
