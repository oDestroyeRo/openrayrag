import { filter, groupBy, map, mapValues, pipe, sort, sumBy, values } from 'remeda';
import type { Snapshot } from '../automation/engine';
import { validActorSnapshot } from '../world/actor-observations-logic';
import { itemName } from '../catalog/game-catalog';
import { actorKey } from '../combat/manual-target-view-logic';
import type { Position } from '../protocol/protocol';

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
    experience: `Base EXP ${observed(experience?.baseTotal)} (+${observed(experience?.baseGained)}) · Job EXP ${observed(experience?.jobTotal)} (+${observed(experience?.jobGained)})`,
    'base-experience': `${observed(experience?.baseTotal)} (+${observed(experience?.baseGained)})`,
    'job-experience': `${observed(experience?.jobTotal)} (+${observed(experience?.jobGained)})`,
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
    map(status?.monsters ?? [], point), map(status?.drops ?? [], point), navigation?.goal ? point(navigation.goal) : null,
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
