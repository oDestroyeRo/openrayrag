import type { Snapshot } from './engine';
import { validActorSnapshot } from './actor-observations';
import { itemName } from './game-catalog';
import { actorKey } from './manual-target-view';
import type { Position } from './protocol';

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
export function consoleInventory(status: Snapshot | null): { itemId: number; count: number; label: string }[] {
  const stock = new Map<number, number>();
  if (status?.character.inventoryKnown) for (const item of status.character.inventory) if (item.count > 0) stock.set(item.itemId, (stock.get(item.itemId) ?? 0) + item.count);
  return [...stock].sort(([a], [b]) => itemName(a).localeCompare(itemName(b)))
    .map(([itemId, count]) => ({ itemId, count, label: `${itemName(itemId)} × ${count}` }));
}
export function consoleMonsters(status: Snapshot | null): { key: string; attackable: boolean; text: string; label: string }[] {
  const actors = validActorSnapshot(status?.actorObservations) ? status!.actorObservations : null;
  const distance = (p: Position) => status?.player ? Math.max(Math.abs(p.x - status.player.x), Math.abs(p.y - status.player.y)) : 0;
  return (status?.monsters ?? []).filter(monster => !monster.dead && monster.hp > 0).sort((a, b) => distance(a) - distance(b)).map(monster => {
    const actor = actors?.actors.find(row => row.id === monster.id && row.kind === 1);
    return { key: actor ? actorKey(actors!.world, actor.id, actor.incarnation) : `unavailable:${monster.id}`, attackable: !!actor,
      text: `${monster.name} · Lv ${monster.level}\n${monster.x}, ${monster.y} · HP ${monster.hp} / ${monster.maxHp}`, label: `Attack ${monster.name} #${monster.id}` };
  });
}
