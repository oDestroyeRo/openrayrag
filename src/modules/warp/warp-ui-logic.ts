import type { WarpSnapshot } from './warp';
import { validateWarpRequest } from './warp-protocol';
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const integer = (v: unknown, min = 0, max = 2147483647) =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
export function validWarpSnapshot(input: unknown): input is WarpSnapshot {
  const s = object(input),
    allowed = [
      'generation',
      'blocked',
      'pending',
      'state',
      'reason',
      'ready',
      'activation',
      'preview',
      'slots',
      'cost',
      'gems',
      'reserve',
      'selection',
      'resourceEvidence',
      'captured',
    ];
  if (
    Object.keys(s).length !== allowed.length ||
    Object.keys(s).some((k) => !allowed.includes(k)) ||
    !integer(s.generation) ||
    typeof s.blocked !== 'boolean' ||
    typeof s.pending !== 'boolean' ||
    (s.pending && !s.blocked) ||
    !['idle', 'groundSent', 'selectionObserved', 'activationSent', 'stopped', 'recovered'].includes(
      String(s.state),
    ) ||
    !['unknown', 'waiting', 'cleared'].includes(String(s.selection)) ||
    typeof s.reason !== 'string' ||
    s.reason.length > 768 ||
    typeof s.resourceEvidence !== 'string' ||
    s.resourceEvidence.length > 512 ||
    !integer(s.reserve, 0, 32767) ||
    !(s.cost === null || integer(s.cost)) ||
    !(s.gems === null || integer(s.gems)) ||
    !(
      s.slots === null ||
      (Array.isArray(s.slots) &&
        s.slots.length === 4 &&
        s.slots.every(
          (v) =>
            v === null ||
            (() => {
              const p = object(v);
              return (
                Object.keys(p).length === 3 &&
                typeof p.map === 'string' &&
                /^[a-zA-Z0-9_-]{1,64}$/.test(p.map) &&
                integer(p.x, 0, 32767) &&
                integer(p.y, 0, 32767)
              );
            })(),
        ))
    )
  )
    return false;
  if (s.captured !== null) {
    const c = object(s.captured),
      d = object(c.destination),
      g = object(c.ground);
    if (
      Object.keys(c).length !== 3 ||
      !integer(c.slot, 0, 3) ||
      Object.keys(g).length !== 2 ||
      !integer(g.x, 0, 511) ||
      !integer(g.y, 0, 511) ||
      Object.keys(d).length !== 3 ||
      typeof d.map !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(d.map) ||
      !integer(d.x, 0, 32767) ||
      !integer(d.y, 0, 32767)
    )
      return false;
  }
  try {
    if (s.ready !== null) {
      const p = validateWarpRequest({ type: 'warpActivate', preview: s.ready }).preview;
      if (s.blocked || p.generation !== s.generation || s.slots === null) return false;
    }
    if (s.preview !== null) {
      const p = validateWarpRequest(s.preview);
      if (p.preview.generation !== s.generation) return false;
    }
    if (s.activation !== null) {
      const a = validateWarpRequest(s.activation);
      if (
        a.type !== 'warpActivate' ||
        !s.blocked ||
        !s.pending ||
        s.state !== 'selectionObserved' ||
        a.preview.generation !== s.generation
      )
        return false;
    }
  } catch {
    return false;
  }
  return true;
}
