import { validActorSnapshot } from './actor-observations-logic';
import type { CharacterSnapshot } from './character-state-logic';
import { manualTargetPolicy, validateManualTargetRequest, type ManualPreviewContext, type ManualTargetRequest } from './manual-target-logic';
import type { Entity, Position } from './protocol';
import type { Settings } from './settings';
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};

export const actorKey = (world: string, id: number, incarnation: number): string => `${world}:${id}:${incarnation}`;

/** Shared UI admission; the controller still rebuilds the route and checks receipts. */
export function manualTargetView(status: Record<string, unknown>, settings: Settings,
  command: { type: 'walk'; destination: Position } | { type: 'attack'; key: string }, timeoutSeconds: number,
  now: number): { request: ManualTargetRequest; context: ManualPreviewContext } {
  const actors = status.actorObservations;
  if (!validActorSnapshot(actors) || !actors.connected || actors.lastFrameAt === null
    || now < actors.at || now - actors.at > 15000 || actors.at < actors.lastFrameAt || actors.at - actors.lastFrameAt > 15000) {
    throw new Error('Manual command observations are stale or unavailable.');
  }
  const self = actors.actors.find(actor => actor.id === actors.selfId), player = status.player as Entity | null;
  if (!self || self.kind !== 0 || !player || player.id !== self.id || status.connected !== true
    || status.compatible !== true || typeof status.map !== 'string') throw new Error('A fresh verified current-map character is required.');
  const observed = command.type === 'attack'
    ? actors.actors.find(actor => actor.kind === 1 && actorKey(actors.world, actor.id, actor.incarnation) === command.key) : null;
  if (command.type === 'attack' && !observed) throw new Error('Selected monster is absent or replaced. Select its current identity again.');
  const request = validateManualTargetRequest({ type: 'manualTarget', map: status.map,
    owner: { world: actors.world, id: self.id, incarnation: self.incarnation },
    command: command.type === 'walk' ? command : { type: 'attack', target: { world: actors.world, id: observed!.id, incarnation: observed!.incarnation } },
    timeoutSeconds, policy: manualTargetPolicy(settings) });
  const target = observed ? (status.monsters as Entity[] ?? []).find(actor => actor.id === observed.id) ?? null : null;
  const world = object(status.world), npc = object(world.npc);
  return { request, context: { map: status.map, player, owner: request.owner, target,
    targetIdentity: observed ? { world: actors.world, id: observed.id, incarnation: observed.incarnation } : null,
    character: status.character as CharacterSnapshot, observations: { ...actors, candidateId: target?.id ?? null },
    interactionBusy: world.vending != null || npc.id != null || typeof npc.mode === 'string' && npc.mode !== 'idle' } };
}
