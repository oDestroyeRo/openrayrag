/** Spawn metadata distinguishes a player's vending proxy from an ordinary NPC. */
interface InteractionActor { kind?: unknown; npcSpawn?: unknown }

export function isPlayerShop(actor: InteractionActor): boolean {
  const metadata = actor.npcSpawn;
  return actor.kind === 2 && !!metadata && typeof metadata === 'object'
    && 'displayType' in metadata && metadata.displayType === 3;
}

export function isTalkNpc(actor: InteractionActor): boolean {
  return (actor.kind === 2 || actor.kind === 4) && !isPlayerShop(actor);
}
