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
export type ManualVendingViewRequest = Omit<ManualNpcTalkRequest, 'type'> & Readonly<{ type: 'manualVendingView' }>;

export function validateManualNpcTalkRequest(value: unknown): ManualNpcTalkRequest {
  return validateManualInteraction(value, 'manualNpcTalk');
}

export function validateManualVendingViewRequest(value: unknown): ManualVendingViewRequest {
  return validateManualInteraction(value, 'manualVendingView');
}

function validateManualInteraction<T extends 'manualNpcTalk' | 'manualVendingView'>(value: unknown, type: T): Omit<ManualNpcTalkRequest, 'type'> & Readonly<{ type: T }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['type', 'map', 'owner', 'target'].includes(key)))
    throw new Error('Invalid manual interaction request.');
  const request = value as Record<string, unknown>;
  if (request.type !== type) throw new Error('Invalid manual interaction request.');
  const map = mapCode(request.map);
  const owner = validateActionIdentity(request.owner), target = validateActionIdentity(request.target);
  if (target.world !== owner.world) throw new Error('Actor belongs to another world.');
  return { type, map, owner, target };
}
