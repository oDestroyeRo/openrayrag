import { describe, expect, it, vi } from 'vitest';
import { itemId, milliseconds, revisionFor, seconds } from '../../shared/domain-values';
import { memoCell, validateMemoRequest, type MemoRequest } from './memo-protocol';
import {
  fingerprint,
  identity,
  memoPreview,
  nextMemoGeneration,
  nextMemoRevision,
  type MemoRequestIdentity,
  type Receipt,
} from './memo-logic';
import { ManualMemo, type MemoContext } from './memo';
import { validateWarpRequest } from '../warp/warp-protocol';
import { groundSpReadback, nextWarpGeneration } from '../warp/warp-logic';

const binding = {
  world: 'aaaaaaaa-0000-4000-8000-000000000001',
  actorId: 0,
  incarnation: 1,
  connectionEpoch: 1,
  revision: 1,
  map: 'prt_fild08',
  x: 10,
  y: 20,
};
const rawMemo = () => ({ type: 'memoSave', slot: 0, preview: { ...binding } });
const rawWarp = () => ({
  type: 'warpGround',
  slot: 0,
  target: { x: 11, y: 20 },
  preview: {
    ...binding,
    generation: 0,
    level: 4,
    inventoryRevision: 1,
    equipmentRevision: 1,
    spRevision: 1,
    skillsRevision: 1,
  },
});
const context: MemoContext = {
  ...binding,
  ready: true,
  idle: true,
  walkable: true,
  canMemo: true,
  learnedWarp: 4,
};

describe('memo and Warp retained domains', () => {
  it('preserves request shapes, lowercase worlds and the existing first error', () => {
    expect(JSON.stringify(validateMemoRequest(rawMemo()))).toBe(JSON.stringify(rawMemo()));
    expect(JSON.stringify(validateWarpRequest(rawWarp()))).toBe(JSON.stringify(rawWarp()));
    expect(() => validateMemoRequest({ ...rawMemo(), slot: -1, preview: {} })).toThrow(
      'Invalid manual memo request.',
    );
    expect(() => validateWarpRequest({ ...rawWarp(), preview: {}, target: {} })).toThrow(
      'Invalid Warp Portal fields.',
    );
    const world = binding.world.toUpperCase();
    expect(() => validateMemoRequest({ ...rawMemo(), preview: { ...binding, world } })).toThrow(
      'Memo preview is invalid or incomplete.',
    );
    expect(() =>
      validateWarpRequest({ ...rawWarp(), preview: { ...rawWarp().preview, world } }),
    ).toThrow('Memo preview is invalid or incomplete.');
    expect(() => memoCell(512)).toThrow('Invalid memo cell');
  });

  it('detaches admitted requests and retains an admitted receipt after source mutation', () => {
    const warpInput = rawWarp(),
      warp = validateWarpRequest(warpInput);
    warpInput.target.x = 100;
    warpInput.preview.actorId = 7;
    expect(warp).toMatchObject({ target: { x: 11 }, preview: { actorId: 0 } });
    const send = vi.fn(),
      owner = new ManualMemo(send, () => 1000);
    owner.observeSlots([null, null, null, null], context);
    const request = { ...rawMemo(), preview: owner.snapshot(context).ready };
    owner.dispatch(request, context);
    request.preview = null;
    owner.observeNotification(0, context);
    owner.observeSlots(
      [{ map: binding.map, x: binding.x, y: binding.y }, null, null, null],
      context,
    );
    expect(owner.snapshot(context).state).toBe('confirmed');
    expect(send).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('detaches the previous location even when a memo preview is already current', () => {
    const owner = new ManualMemo(() => {}),
      location = { map: binding.map, x: binding.x, y: binding.y };
    owner.observeSlots([location, null, null, null], context);
    location.x = 30;
    const snapshot = owner.snapshot(context),
      preview = memoPreview(snapshot, 0);
    expect(preview.request).toBeNull();
    Reflect.set(preview.previous!, 'x', 40);
    expect(snapshot.slots![0]!.x).toBe(10);
    expect(owner.snapshot(context).slots![0]!.x).toBe(10);
  });

  it('saturates each local revision budget without creating an invalid branded value', () => {
    const maximum = 2147483647;
    expect(nextMemoRevision(revisionFor('memo', maximum - 1))).toBe(maximum);
    expect(nextMemoRevision(revisionFor('memo', maximum))).toBe(maximum);
    expect(nextMemoGeneration(revisionFor('memo-generation', maximum))).toBe(maximum);
    expect(nextWarpGeneration(revisionFor('warp', maximum))).toBe(maximum);
  });

  it('requires the next SP revision and exact debit while preserving raw numeric observations', () => {
    const request = validateWarpRequest(rawWarp());
    if (request.type !== 'warpGround') throw new Error('Expected ground request');
    const readback = groundSpReadback({ request, sp: 100.5, cost: 26.5 });
    expect(readback({ sp: 74, revision: 2 })).toBe(true);
    expect(readback({ sp: 74, revision: 1 })).toBe(false);
    expect(readback({ sp: 74, revision: 3 })).toBe(false);
    expect(readback({ sp: null, revision: 2 })).toBe(false);
    expect(readback({ sp: 73, revision: 2 })).toBe(false);
  });

  it('checks identity, revision and time dimensions at actual policy consumers', () => {
    if (false) {
      const memo: MemoRequest = validateMemoRequest(rawMemo()),
        warp = validateWarpRequest(rawWarp());
      // @ts-expect-error item IDs cannot identify the actor captured by a memo receipt
      fingerprint({ ...memo, preview: { ...memo.preview, actorId: itemId(1) } });
      // @ts-expect-error memo receipt revisions cannot use the Warp lifecycle channel
      fingerprint({ ...memo, preview: { ...memo.preview, revision: revisionFor('warp', 1) } });
      fingerprint({
        ...memo,
        // @ts-expect-error the connection fence cannot use an inventory revision
        preview: { ...memo.preview, connectionEpoch: revisionFor('inventory', 1) },
      });
      // @ts-expect-error lifecycle advancement cannot consume a memo observation revision
      nextWarpGeneration(memo.preview.revision);
      const seen = new Set<MemoRequestIdentity>();
      seen.add(fingerprint(memo));
      // @ts-expect-error lifetime comparison evidence cannot become a retained request correlation key
      seen.add(identity(memo.preview));
      if (warp.type === 'warpGround') {
        groundSpReadback({
          request: {
            ...warp,
            // @ts-expect-error SP readback cannot be fenced by an inventory revision
            preview: { ...warp.preview, spRevision: revisionFor('inventory', 1) },
          },
          sp: 100,
          cost: 26,
        });
        groundSpReadback({
          // @ts-expect-error ground request cells cannot use item identities
          request: { ...warp, target: { ...warp.target, x: itemId(11) } },
          sp: 100,
          cost: 26,
        });
        // @ts-expect-error request target cells are readonly
        warp.target.x = memoCell(12);
      }
      const receipt: Receipt = {
        request: memo,
        before: [null, null, null, null],
        notified: false,
        ambiguous: false,
        since: milliseconds(1000),
        deadline: milliseconds(11000),
      };
      // @ts-expect-error receipt deadlines use milliseconds, not seconds
      const wrongTime: Receipt = { ...receipt, deadline: seconds(11000) };
      // @ts-expect-error admitted actor identity is readonly
      memo.preview.actorId = itemId(1);
      const snapshot = new ManualMemo(() => {}).snapshot(context);
      // @ts-expect-error slot projections expose detached readonly locations
      snapshot.slots![0]!.x = 12;
      void wrongTime;
    }
  });
});
