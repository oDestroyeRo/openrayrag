import {
  validateAutomation,
  type AutomationSettingsInput as AutomationSettings,
} from '../settings/settings';
import { BitReader, BitWriter } from '../../shared/binary';
import {
  validateMemoRequest,
  memoCell,
  type MemoBinding,
  type MemoBindingInput,
  type MemoCell,
  type MemoSlot,
} from '../memo/memo-protocol';
import { revisionFor, type Revision } from '../../shared/domain-values';

export interface WarpBindingInput extends MemoBindingInput {
  generation: number;
  level: number;
  inventoryRevision: number;
  equipmentRevision: number;
  spRevision: number;
  skillsRevision: number;
}
export type WarpGeneration = Revision<'warp'>;
export interface WarpBinding extends MemoBinding {
  readonly generation: WarpGeneration;
  readonly level: 1 | 2 | 3 | 4;
  readonly inventoryRevision: Revision<'inventory'>;
  readonly equipmentRevision: Revision<'equipment'>;
  readonly spRevision: Revision<'sp'>;
  readonly skillsRevision: Revision<'skills'>;
}
export type WarpRequestInput =
  | {
      type: 'warpGround';
      slot: MemoSlot;
      target: { x: number; y: number };
      preview: WarpBindingInput;
    }
  | { type: 'warpActivate'; preview: WarpBindingInput };
/** Current evidence proposes activation; request validation owns admission at dispatch. */
export interface WarpActivationObservation {
  readonly type: 'warpActivate';
  readonly preview: Readonly<WarpBindingInput>;
}
export type WarpRequest =
  | Readonly<{
      type: 'warpGround';
      slot: MemoSlot;
      target: Readonly<{ x: MemoCell; y: MemoCell }>;
      preview: WarpBinding;
    }>
  | Readonly<{ type: 'warpActivate'; preview: WarpBinding }>;
/** Ground is admitted on prepare; activation stays observed until dispatch validation. */
export type PreparedWarpRequest =
  | Extract<WarpRequest, { type: 'warpGround' }>
  | WarpActivationObservation;
export type WarpWire =
  | { stage: 'ground'; level: number; x: number; y: number }
  | { stage: 'activate'; slot: MemoSlot };
const record = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw new Error('Invalid Warp Portal request.');
  return v as Record<string, unknown>;
};
const keys = (v: Record<string, unknown>, allowed: string[]) => {
  if (Object.keys(v).length !== allowed.length || Object.keys(v).some((k) => !allowed.includes(k)))
    throw new Error('Invalid Warp Portal fields.');
};
const integer = (v: unknown, min: number, max = 2147483647): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max)
    throw new Error('Invalid Warp Portal value.');
  return v;
};
export function validateWarpRequest(value: unknown): WarpRequest {
  const v = record(value);
  if (v.type !== 'warpGround' && v.type !== 'warpActivate')
    throw new Error('Unknown Warp Portal stage.');
  keys(v, v.type === 'warpGround' ? ['type', 'slot', 'target', 'preview'] : ['type', 'preview']);
  const p = record(v.preview);
  keys(p, [
    'world',
    'actorId',
    'incarnation',
    'connectionEpoch',
    'revision',
    'map',
    'x',
    'y',
    'generation',
    'level',
    'inventoryRevision',
    'equipmentRevision',
    'spRevision',
    'skillsRevision',
  ]);
  const base = validateMemoRequest({
    type: 'memoSave',
    slot: 0,
    preview: Object.fromEntries(
      ['world', 'actorId', 'incarnation', 'connectionEpoch', 'revision', 'map', 'x', 'y'].map(
        (k) => [k, p[k]],
      ),
    ),
  }).preview;
  const preview: WarpBinding = {
    ...base,
    generation: revisionFor('warp', integer(p.generation, 0)),
    level: integer(p.level, 1, 4) as WarpBinding['level'],
    inventoryRevision: revisionFor('inventory', integer(p.inventoryRevision, 1)),
    equipmentRevision: revisionFor('equipment', integer(p.equipmentRevision, 1)),
    spRevision: revisionFor('sp', integer(p.spRevision, 1)),
    skillsRevision: revisionFor('skills', integer(p.skillsRevision, 1)),
  };
  if (v.type === 'warpActivate') return { type: v.type, preview };
  const t = record(v.target);
  keys(t, ['x', 'y']);
  return {
    type: v.type,
    slot: integer(v.slot, 0, 3) as MemoSlot,
    target: { x: memoCell(integer(t.x, 0, 511)), y: memoCell(integer(t.y, 0, 511)) },
    preview,
  };
}
/** Dedicated owner only: generic skill validation deliberately rejects 55. */
export function warpCommand(wire: WarpWire): Uint8Array<ArrayBuffer> {
  const w = new BitWriter().u8(29);
  if (wire.stage === 'activate')
    return w
      .u8(5)
      .i16(55)
      .u8(integer(wire.slot, 0, 3) + 1)
      .finish();
  return w
    .u8(4)
    .i16(integer(wire.x, 0, 511))
    .i16(integer(wire.y, 0, 511))
    .u8(55)
    .u8(integer(wire.level, 1, 4))
    .finish();
}
export interface WarpStateEvent {
  type: 'warpState';
  state: 0 | 1;
}
export function decodeWarp(data: Uint8Array): WarpStateEvent[] | null {
  if (data[0] !== 97) return null;
  const r = new BitReader(data);
  r.u8();
  const state = r.u8();
  r.finish();
  if (state !== 0 && state !== 1) throw new Error('Unknown Warp Portal selection state.');
  return [{ type: 'warpState', state }];
}

/** Read only the bounded ordinary initialization packets; no login credentials. */
export function warpInitializationPacket(
  data: Uint8Array,
): { type: 'enterRequest'; character: string } | { type: 'playerReady' } | null {
  if (data[0] === 2 && data.length === 1) return { type: 'playerReady' };
  if (data[0] !== 3) return null;
  try {
    const r = new BitReader(data);
    r.u8();
    if (r.bool()) return null;
    const character = r.string(96);
    r.finish();
    if (!character || character.length > 48) return null;
    return { type: 'enterRequest', character };
  } catch {
    return null;
  }
}

export type WarpPreviewRequest =
  | { type: 'warpGround'; slot: MemoSlot; target: { x: number; y: number } }
  | { type: 'warpActivate' };

export function validateWarpEnvelope(
  value: unknown,
  preview: boolean,
): { request: WarpRequest | WarpPreviewRequest; policy: AutomationSettings } {
  const v = record(value);
  if (new TextEncoder().encode(JSON.stringify(value)).length > 65_536)
    throw new Error('Warp request exceeds its 65,536-byte limit.');
  const { policy, ...raw } = v;
  if (!policy || typeof policy !== 'object' || Array.isArray(policy))
    throw new Error('Current manual protection settings are required.');
  const checked = validateAutomation(policy as AutomationSettings);
  if (
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      new TextEncoder().encode(checked.follow.name),
    ) !== checked.follow.name
  )
    throw new Error('Incomplete policy Unicode.');
  if (!preview) return { request: validateWarpRequest(raw), policy: structuredClone(checked) };
  keys(raw, raw.type === 'warpGround' ? ['type', 'slot', 'target'] : ['type']);
  if (raw.type === 'warpActivate')
    return { request: { type: 'warpActivate' }, policy: structuredClone(checked) };
  if (raw.type !== 'warpGround') throw new Error('Invalid Warp preview stage.');
  const t = record(raw.target);
  keys(t, ['x', 'y']);
  return {
    request: {
      type: 'warpGround',
      slot: integer(raw.slot, 0, 3) as MemoSlot,
      target: { x: integer(t.x, 0, 511), y: integer(t.y, 0, 511) },
    },
    policy: structuredClone(checked),
  };
}
export function officialWarpSkill(data: Uint8Array): boolean {
  if (data[0] !== 29) return false;
  try {
    const r = new BitReader(data);
    r.u8();
    const mode = r.u8();
    if (mode === 5) return r.i16() === 55;
    if (mode === 4) {
      r.i16();
      r.i16();
      return r.u8() === 55;
    }
    if (mode === 1) {
      r.i32();
      return r.u8() === 55;
    }
  } catch {}
  return false;
}
