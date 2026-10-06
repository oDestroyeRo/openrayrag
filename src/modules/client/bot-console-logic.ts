import { filter, groupBy, map, mapValues, pipe, sort, sumBy, values } from 'remeda';
import { signedExperience } from '../session/run-experience-logic';
import type { Snapshot } from '../automation/engine';
import { validActorSnapshot } from '../world/actor-observations-logic';
import { itemName } from '../catalog/game-catalog';
import { actorKey } from '../combat/manual-target-view-logic';
import { isTalkNpc, isPlayerShop } from '../world/actor-interaction-logic';
import type { Position } from '../protocol/protocol';
import { BUILTIN_SERVICES, resolveServiceNpc } from '../services/npc-services-logic';
import { validateManualNpcTalkRequest, validateManualVendingViewRequest, type ManualNpcTalkRequest, type ManualVendingViewRequest } from '../services/manual-npc-talk-logic';

const observed = (value: unknown): string => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value.toLocaleString() : '—';

/** The displayed raster covers the full CSS box; map Y increases upwards. */
export function mapCoordinate(clientX: number, clientY: number,
  rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>, width: number, height: number): Position | null {
  if (![clientX, clientY, rect.left, rect.top, rect.width, rect.height, width, height].every(Number.isFinite)
    || rect.width <= 0 || rect.height <= 0 || width <= 0 || height <= 0) return null;
  const x = clientX - rect.left, y = clientY - rect.top;
  if (x < 0 || y < 0 || x >= rect.width || y >= rect.height) return null;
  return { x: Math.floor(x / rect.width * width), y: height - 1 - Math.floor(y / rect.height * height) };
}

export function consoleCharacterText(status: Snapshot | null): Record<string, string> {
  const stats = status?.character.stats, experience = status?.character.experience;
  return {
    levels: `${observed(stats?.level ?? status?.player?.level)} / ${observed(stats?.jobLevel)}`,
    weight: `${observed(stats?.weight)} / ${observed(stats?.maxWeight)}`,
    zeny: observed(stats?.zeny),
    experience: `Base EXP current ${observed(experience?.baseTotal)} (latest ${signedExperience(experience?.baseGained)}) · Job EXP current ${observed(experience?.jobTotal)} (latest ${signedExperience(experience?.jobGained)})`,
    'base-experience': `${observed(experience?.baseTotal)} (latest ${signedExperience(experience?.baseGained)})`,
    'job-experience': `${observed(experience?.jobTotal)} (latest ${signedExperience(experience?.jobGained)})`,
  };
}
export function consoleSelectedItem(status: Snapshot | null, value: string): { itemId: number; count: number } | null {
  if (!status?.character.inventoryKnown || !/^\d+$/.test(value)) return null;
  const itemId = Number(value);
  const count = pipe(status.character.inventory, filter(item => item.itemId === itemId), sumBy(item => item.count));
  return count > 0 ? { itemId, count } : null;
}
export function consoleInventorySignature(status: Snapshot | null, world: string | null): string {
  const character = status?.character;
  return JSON.stringify([world, character?.inventoryKnown, character ? map(character.inventory, item => [item.itemId, item.count]) : undefined]);
}
export function consoleDropTexts(status: Snapshot | null): string[] {
  return map(status?.drops ?? [], drop => `${itemName(drop.itemId)} × ${drop.count} · ${drop.x}, ${drop.y}`);
}
export function consoleRadarSignature({ status, map: code, width, height }: { status: Snapshot | null; map: string; width: number; height: number }): string {
  const navigation = status?.navigation, point = (position: Position) => [position.x, position.y];
  return JSON.stringify([code, width, height, status?.player ? point(status.player) : null,
    map(status?.monsters ?? [], point), map(consoleNpcs(status), point), map(consolePlayerShops(status), point), map(status?.drops ?? [], point), navigation?.goal ? point(navigation.goal) : null,
    map(navigation?.route ?? [], point), map(navigation?.leg ?? [], point)]);
}
export function consoleInventory(status: Snapshot | null): { itemId: number; count: number; label: string }[] {
  return pipe(status?.character.inventoryKnown ? status.character.inventory : [],
    filter(item => item.count > 0),
    // Prefix IDs so equal display names retain first-observed order even for numeric IDs.
    groupBy(item => `item:${item.itemId}`),
    mapValues(rows => ({ itemId: rows[0]!.itemId, count: sumBy(rows, row => row.count) })),
    values(),
    sort((a, b) => itemName(a.itemId).localeCompare(itemName(b.itemId))),
    map(({ itemId, count }) => ({ itemId, count, label: `${itemName(itemId)} × ${count}` })));
}
export function consoleMonsters(status: Snapshot | null): { key: string; attackable: boolean; text: string; label: string }[] {
  const actors = validActorSnapshot(status?.actorObservations) ? status!.actorObservations : null;
  const distance = (p: Position) => status?.player ? Math.max(Math.abs(p.x - status.player.x), Math.abs(p.y - status.player.y)) : 0;
  return pipe(status?.monsters ?? [], filter(monster => !monster.dead && monster.hp > 0),
    sort((a, b) => distance(a) - distance(b)), map(monster => {
    const actor = actors?.actors.find(row => row.id === monster.id && row.kind === 1);
    return { key: actor ? actorKey(actors!.world, actor.id, actor.incarnation) : `unavailable:${monster.id}`, attackable: !!actor,
      text: `${monster.name} · Lv ${monster.level}\n${monster.x}, ${monster.y} · HP ${monster.hp} / ${monster.maxHp}`, label: `Attack ${monster.name} #${monster.id}` };
  }));
}

export const NPC_MAP_RADIUS = 4;
export interface ConsoleNpc extends Position {
  family: 'npc' | 'shop'; key: string; id: number; name: string; kindLabel: string; talkable: boolean; text: string; label: string;
}

export function consoleNpcs(status: Snapshot | null): ConsoleNpc[] {
  const actors = validActorSnapshot(status?.actorObservations) ? status!.actorObservations : null;
  const services = new Map<number, Set<string>>();
  for (const service of BUILTIN_SERVICES) {
    const resolved = resolveServiceNpc(service, status?.map ?? '', status?.actors ?? []);
    if (resolved.state !== 'resolved') continue;
    const labels = services.get(resolved.actor.id) ?? new Set<string>();
    labels.add(service.outcome.type === 'storageOpened' ? 'Storage' : service.outcome.type === 'arrival' ? 'Teleport' : 'Shop');
    services.set(resolved.actor.id, labels);
  }
  const distance = (p: Position) => status?.player ? Math.max(Math.abs(p.x - status.player.x), Math.abs(p.y - status.player.y)) : 0;
  return pipe(status?.actors ?? [], filter(npc => isTalkNpc(npc) && !npc.dead),
    sort((a, b) => distance(a) - distance(b) || a.id - b.id), map(npc => {
      const observed = actors?.actors.find(actor => actor.id === npc.id && actor.kind === npc.kind);
      const known = services.get(npc.id), kindLabel = known ? `NPC · ${[...known].join(' / ')}` : 'NPC';
      const name = npc.name || 'Unnamed NPC';
      return { family: 'npc' as const, key: observed ? actorKey(actors!.world, npc.id, observed.incarnation) : `unavailable:${npc.id}`,
        id: npc.id, name, x: npc.x, y: npc.y, kindLabel, talkable: !!observed,
        text: `${name} · ${kindLabel}\n${npc.x}, ${npc.y}`, label: `Talk to ${name} #${npc.id}` };
    }));
}

export function consolePlayerShops(status: Snapshot | null): ConsoleNpc[] {
  const actors = validActorSnapshot(status?.actorObservations) ? status!.actorObservations : null;
  const distance = (p: Position) => status?.player ? Math.max(Math.abs(p.x - status.player.x), Math.abs(p.y - status.player.y)) : 0;
  return pipe(status?.actors ?? [], filter(actor => isPlayerShop(actor) && !actor.dead),
    sort((a, b) => distance(a) - distance(b) || a.id - b.id), map(shop => {
      const observed = actors?.actors.find(actor => actor.id === shop.id && actor.kind === shop.kind);
      const name = shop.name || 'Unnamed player shop';
      return { family: 'shop' as const, key: observed ? actorKey(actors!.world, shop.id, observed.incarnation) : `unavailable:${shop.id}`,
        id: shop.id, name, x: shop.x, y: shop.y, kindLabel: 'Player shop', talkable: !!observed,
        text: `${name} · Player shop\n${shop.x}, ${shop.y}`, label: `View shop ${name} #${shop.id}` };
    }));
}

/** One hit test for both marker families; ties select the lowest actor ID. */
export function consoleInteractionAt({ status, clientX, clientY, rect, width, height }: {
  status: Snapshot | null; clientX: number; clientY: number;
  rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>; width: number; height: number;
}): ConsoleNpc | null {
  if (!mapCoordinate(clientX, clientY, rect, width, height)) return null;
  const radiusX = Math.max(8, NPC_MAP_RADIUS * rect.width / width), radiusY = Math.max(8, NPC_MAP_RADIUS * rect.height / height);
  const radius = Math.max(radiusX, radiusY);
  let nearest: ConsoleNpc | null = null, best = Infinity;
  for (const actor of [...consoleNpcs(status), ...consolePlayerShops(status)]) {
    const x = rect.left + (actor.x + .5) / width * rect.width;
    const y = rect.top + (height - .5 - actor.y) / height * rect.height;
    const distance = Math.hypot(clientX - x, clientY - y);
    const hit = actor.family === 'shop' ? Math.abs(clientX - x) <= radiusX && Math.abs(clientY - y) <= radiusY : distance <= radius;
    if (hit && (distance < best || distance === best && actor.id < nearest!.id)) {
      nearest = actor; best = distance;
    }
  }
  return nearest;
}

export function consoleNpcTalk(status: Snapshot | null, key: string, now: number): ManualNpcTalkRequest {
  return validateManualNpcTalkRequest(consoleInteractionRequest(status, key, now, 'npc'));
}

export function consoleVendingView(status: Snapshot | null, key: string, now: number): ManualVendingViewRequest {
  return validateManualVendingViewRequest(consoleInteractionRequest(status, key, now, 'shop'));
}

function consoleInteractionRequest(status: Snapshot | null, key: string, now: number, family: 'npc' | 'shop') {
  const actors = status?.actorObservations;
  if (!validActorSnapshot(actors) || !actors.connected || actors.lastFrameAt === null
    || now < actors.at || now - actors.at > 15000 || actors.at < actors.lastFrameAt || actors.at - actors.lastFrameAt > 15000)
    throw new Error('NPC and player shop observations are stale or unavailable.');
  const self = actors.actors.find(actor => actor.id === actors.selfId), player = status!.player;
  if (!status!.connected || !status!.compatible || !self || self.kind !== 0 || !player || player.id !== self.id || player.dead || player.hp <= 0)
    throw new Error('A fresh living character is required to interact.');
  const target = actors.actors.find(actor => actorKey(actors.world, actor.id, actor.incarnation) === key);
  const current = target && status!.actors.find(actor => actor.id === target.id && actor.kind === target.kind);
  if (!current || current.dead || !(family === 'shop' ? isPlayerShop(current) : isTalkNpc(current)))
    throw new Error('Selected NPC or player shop is absent, replaced or changed. Select its current identity again.');
  return { type: family === 'shop' ? 'manualVendingView' : 'manualNpcTalk', map: status!.map,
    owner: { world: actors.world, id: self.id, incarnation: self.incarnation },
    target: { world: actors.world, id: current.id, incarnation: target!.incarnation } };
}
