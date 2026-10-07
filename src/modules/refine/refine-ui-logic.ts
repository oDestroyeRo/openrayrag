import type { RefineSnapshot } from './refine';
const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const integer = (v: unknown, min: number, max: number) =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
function keys(v: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(v).every((key) => allowed.includes(key));
}
export function validRefineSnapshot(value: unknown): value is RefineSnapshot {
  const v = record(value);
  if (
    !keys(v, ['state', 'blocked', 'reason', 'preview', 'candidates', 'dialogueToken']) ||
    !['idle', 'preview', 'pending', 'improved', 'downgraded', 'uncertain', 'reconciled'].includes(
      String(v.state),
    ) ||
    typeof v.blocked !== 'boolean' ||
    typeof v.reason !== 'string' ||
    v.reason.length > 512 ||
    !Array.isArray(v.candidates) ||
    v.candidates.length > 200
  )
    return false;
  if (
    !v.candidates.every((entry) => {
      const row = record(entry);
      return (
        keys(row, ['bagId', 'itemId', 'name', 'refine']) &&
        integer(row.bagId, 1, 2147483647) &&
        integer(row.itemId, 1, 2147483647) &&
        typeof row.name === 'string' &&
        row.name.length <= 128 &&
        integer(row.refine, 0, 9)
      );
    })
  )
    return false;
  if (
    v.dialogueToken !== null &&
    (typeof v.dialogueToken !== 'string' || !/^[a-f0-9]{32}$/.test(v.dialogueToken))
  )
    return false;
  if (v.preview === null) return true;
  const p = record(v.preview);
  return (
    keys(p, [
      'token',
      'targetBagId',
      'itemId',
      'name',
      'startingRefine',
      'oreItemId',
      'zenyCost',
      'failurePossible',
      'npcId',
    ]) &&
    typeof p.token === 'string' &&
    /^[a-f0-9]{32}$/.test(p.token) &&
    integer(p.targetBagId, 1, 2147483647) &&
    integer(p.itemId, 1, 2147483647) &&
    typeof p.name === 'string' &&
    p.name.length <= 128 &&
    integer(p.startingRefine, 0, 9) &&
    integer(p.oreItemId, 1, 2147483647) &&
    integer(p.zenyCost, 1, 10000) &&
    typeof p.failurePossible === 'boolean' &&
    integer(p.npcId, 0, 2147483647)
  );
}
