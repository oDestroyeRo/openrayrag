import type { ExpandedAction, FeatureEvent } from '../protocol/protocol-feature';

/** Execution evidence shared by active and canceled receipt owners. Cast/impact
 * packets and a nearby ground position never acknowledge this request. */
export function matchesSkillExecution(
  action: Extract<ExpandedAction, { type: 'skill' }>,
  event: FeatureEvent | { type: string },
  playerId: number | null,
): boolean {
  if (playerId === null || event.type !== 'skillResult') return false;
  const result = event as Extract<FeatureEvent, { type: 'skillResult' }>;
  if (
    result.indirect ||
    result.source !== playerId ||
    result.skillId !== action.skillId ||
    result.level !== action.level
  )
    return false;
  if (action.mode === 'self')
    return result.mode === 'self' || (result.mode === 'target' && result.target === playerId);
  if (result.mode !== action.mode) return false;
  return action.mode === 'target'
    ? result.target === action.target
    : result.targetPosition?.x === action.position.x &&
        result.targetPosition?.y === action.position.y;
}

/** HealHandler's living-player branch: damage/HP changes are not receipts. */
export function matchesPartyHealExecution(
  action: Extract<ExpandedAction, { type: 'skill' }>,
  event: FeatureEvent | { type: string },
  playerId: number | null,
): boolean {
  if (
    action.skillId !== 41 ||
    action.mode !== 'target' ||
    !matchesSkillExecution(action, event, playerId) ||
    event.type !== 'skillResult'
  )
    return false;
  const result = event as Extract<FeatureEvent, { type: 'skillResult' }>;
  return (
    result.indirect === false &&
    result.result === 2 &&
    result.hits === 0 &&
    (result.attacker === undefined || result.attacker === -1 || result.attacker === playerId)
  );
}
