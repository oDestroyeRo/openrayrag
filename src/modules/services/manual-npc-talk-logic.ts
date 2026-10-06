import { validateActionIdentity } from '../combat/manual-target-logic';
import type { UuidEngagementIdentity } from '../combat/attack-strategy-logic';
import { mapCode, type MapCode } from '../../shared/domain-values';

/** A map click binds both actors to their currently observed lifetimes. */
export type ManualNpcTalkRequest = Readonly<{
  type: 'manualNpcTalk';
  map: MapCode;
  owner: UuidEngagementIdentity;
  target: UuidEngagementIdentity;
}>;

export function validateManualNpcTalkRequest(value: unknown): ManualNpcTalkRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['type', 'map', 'owner', 'target'].includes(key)))
    throw new Error('Invalid manual NPC talk request.');
  const request = value as Record<string, unknown>;
  if (request.type !== 'manualNpcTalk') throw new Error('Invalid manual NPC talk request.');
  const map = mapCode(request.map);
  const owner = validateActionIdentity(request.owner), target = validateActionIdentity(request.target);
  if (target.world !== owner.world) throw new Error('NPC belongs to another world.');
  return { type: 'manualNpcTalk', map, owner, target };
}
