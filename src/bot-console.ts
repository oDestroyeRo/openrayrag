import { validActorSnapshot } from './actor-observations';
import type { Snapshot } from './engine';
import { ITEM_CATALOG, itemName } from './game-catalog';
import { previewManualTarget } from './manual-target';
import { actorKey, manualTargetView } from './manual-target-view';
import { GridNavigator, NAVIGATION_MAPS, searchGrid } from './navigation';
import type { Position } from './protocol';
import type { Settings } from './settings';

interface Hooks {
  settings(): Settings;
  command(request: Record<string, unknown>): Promise<unknown>;
  notify(text: string, error?: boolean): void;
  account(): void;
  lootSettings(): void;
  manualTools(): void;
}
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

/** Projection only. Manual commands enter the existing receipt-owning controller. */
export class BotConsole {
  private status: Snapshot | null = null;
  private locked = true;
  private lockReason = 'Connect a verified character to use manual controls.';
  private pending = false;
  private rasterMap = '';
  private raster: HTMLCanvasElement | null = null;
  private inventorySignature = '';
  private inventoryWorld: string | null = null;
  private readonly monsters = new Map<string, { root: HTMLElement; text: HTMLElement; button: HTMLButtonElement }>();
  private itemRequest: { world: string | null } | null = null;
  private readonly canvas: HTMLCanvasElement;
  private readonly x: HTMLInputElement;
  private readonly y: HTMLInputElement;
  private readonly items: HTMLSelectElement;
  private readonly use: HTMLButtonElement;
  constructor(private readonly host: HTMLElement, private readonly hooks: Hooks) {
    this.canvas = this.get('radar'); this.x = this.get('console-walk-x'); this.y = this.get('console-walk-y');
    this.items = this.get('console-item'); this.use = this.get('console-use-item');
    this.canvas.addEventListener('click', event => {
      const point = mapCoordinate(event.clientX, event.clientY, this.canvas.getBoundingClientRect(), this.canvas.width, this.canvas.height);
      if (point) this.operation(async () => {
        if (!this.status || this.rasterMap !== this.status.map || !this.raster) throw new Error('Current map collision is unavailable.');
        this.x.value = String(point.x); this.y.value = String(point.y);
        await this.target({ type: 'walk', destination: point });
      });
    });
    this.get('console-walk-form').addEventListener('submit', event => {
      event.preventDefault(); this.operation(() => {
        if (![this.x.value, this.y.value].every(value => /^\d+$/.test(value.trim()))) throw new Error('Enter whole map coordinates.');
        return this.target({ type: 'walk', destination: { x: Number(this.x.value), y: Number(this.y.value) } });
      });
    });
    this.items.addEventListener('change', () => this.itemControls());
    this.use.addEventListener('click', () => this.operation(async () => {
      const item = this.selectedItem();
      if (!item || ITEM_CATALOG[item.itemId]?.useType !== 1) throw new Error('Choose a known untargeted usable item. Targeted items require the manual tools.');
      this.itemRequest = { world: this.world() };
      this.get('console-item-result').textContent = `${itemName(item.itemId)} requested · outcome unconfirmed. Latest action receipts below are shared controller observations.`;
      try { await this.hooks.command({ type: 'useItem', itemId: item.itemId }); }
      catch (error) { this.itemRequest = null; this.get('console-item-result').textContent = error instanceof Error ? error.message : 'Item request unavailable.'; throw error; }
    }));
    this.get('console-loot-settings').addEventListener('click', () => this.hooks.lootSettings());
    this.get('console-item-tools').addEventListener('click', () => this.hooks.manualTools());
    this.get('open').addEventListener('click', () => this.hooks.account());
    this.get('console-action').hidden = true;
    this.render(null);
  }
  private get<T extends HTMLElement>(id: string): T {
    const node = this.host.querySelector<T>(`#${id}`);
    if (!node) throw new Error(`Bot console mount missing: ${id}`);
    return node;
  }
  private world(): string | null { return this.status?.actorObservations?.world ?? null; }
  private async target(command: { type: 'walk'; destination: Position } | { type: 'attack'; key: string }): Promise<void> {
    if (!this.status) throw new Error('Connect a verified character first.');
    const { request, context } = manualTargetView(this.status as unknown as Record<string, unknown>, this.hooks.settings(), command);
    const route = previewManualTarget(request, context);
    this.get('console-action').textContent = `${command.type === 'walk' ? 'Walk' : 'Attack'} requested · ${Math.max(0, route.length - 1)} route cells · waiting for controller observations.`;
    this.get('console-action').hidden = false;
    await this.hooks.command(request as unknown as Record<string, unknown>);
  }
  private operation(action: () => Promise<void>): void {
    if (this.locked || this.pending) { this.hooks.notify(this.lockReason, true); return; }
    this.pending = true; this.refreshLocks();
    void Promise.resolve().then(action).catch(error => {
      const reason = error instanceof Error ? error.message : typeof error === 'string' ? error : 'Manual action is unavailable.';
      this.get('console-action').textContent = reason; this.hooks.notify(reason, true);
      this.get('console-action').hidden = false;
    }).finally(() => { this.pending = false; this.refreshLocks(); });
  }
  lock(locked: boolean, reason: string): void { this.locked = locked; this.lockReason = reason; this.refreshLocks(); }
  private refreshLocks(): void {
    const disabled = this.locked || this.pending;
    this.get('console-lock').textContent = this.locked ? this.lockReason : this.pending ? 'Requesting one action…' : 'Manual controls ready · one action at a time';
    this.canvas.setAttribute('aria-disabled', String(disabled)); this.canvas.classList.toggle('console-map-locked', disabled);
    this.x.disabled = disabled; this.y.disabled = disabled; this.items.disabled = disabled || this.status?.character.inventoryKnown !== true;
    this.get<HTMLButtonElement>('console-walk').disabled = disabled || !searchGrid(this.status?.map ?? '');
    for (const row of this.monsters.values()) row.button.disabled = disabled;
    this.itemControls();
  }
  private selectedItem(): { itemId: number; count: number } | null {
    if (!this.status?.character.inventoryKnown || !/^\d+$/.test(this.items.value)) return null;
    const itemId = Number(this.items.value);
    const count = this.status.character.inventory.filter(item => item.itemId === itemId).reduce((sum, item) => sum + item.count, 0);
    return count > 0 ? { itemId, count } : null;
  }
  private itemControls(): void {
    const item = this.selectedItem(), info = item ? ITEM_CATALOG[item.itemId] : undefined;
    this.use.disabled = this.locked || this.pending || !item || info?.useType !== 1;
    this.get('console-item-info').textContent = !this.status?.character.inventoryKnown ? 'Inventory has not been observed.'
      : !item ? 'Choose an observed item. No item is selected automatically.'
      : `${itemName(item.itemId)} · ${item.count} observed · ${info?.useType === 1 ? 'Untargeted use' : info?.useType === 2 ? 'Requires an explicit target in manual tools' : 'No verified direct-use action'}`;
  }
  render(status: Snapshot | null): void {
    this.status = status;
    const stats = status?.character.stats, experience = status?.character.experience;
    this.get('console-levels').textContent = `${observed(stats?.level ?? status?.player?.level)} / ${observed(stats?.jobLevel)}`;
    this.get('console-weight').textContent = `${observed(stats?.weight)} / ${observed(stats?.maxWeight)}`;
    this.get('console-zeny').textContent = observed(stats?.zeny);
    this.get('console-experience').textContent = `Base EXP ${observed(experience?.baseTotal)} (+${observed(experience?.baseGained)}) · Job EXP ${observed(experience?.jobTotal)} (+${observed(experience?.jobGained)})`;
    this.get('console-base-experience').textContent = `${observed(experience?.baseTotal)} (+${observed(experience?.baseGained)})`;
    this.get('console-job-experience').textContent = `${observed(experience?.jobTotal)} (+${observed(experience?.jobGained)})`;
    const character = status?.character, signature = JSON.stringify([this.world(), character?.inventoryKnown, character?.inventory.map(item => [item.itemId, item.count])]);
    if (signature !== this.inventorySignature) {
      this.inventorySignature = signature;
      const selected = this.inventoryWorld === this.world() ? this.items.value : '', stock = new Map<number, number>();
      this.inventoryWorld = this.world();
      if (character?.inventoryKnown) for (const item of character.inventory) if (item.count > 0) stock.set(item.itemId, (stock.get(item.itemId) ?? 0) + item.count);
      this.items.replaceChildren();
      const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = 'Choose an item'; this.items.append(placeholder);
      for (const [itemId, count] of [...stock].sort(([a], [b]) => itemName(a).localeCompare(itemName(b)))) {
        const option = document.createElement('option'); option.value = String(itemId); option.textContent = `${itemName(itemId)} × ${count}`; this.items.append(option);
      }
      this.items.value = stock.has(Number(selected)) && selected !== '' ? selected : '';
      this.get('console-stock-count').textContent = character?.inventoryKnown ? `${stock.size} item types` : 'Not observed';
    }
    const actors = validActorSnapshot(status?.actorObservations) ? status!.actorObservations : null;
    const live = new Set<string>(), list = this.get('monster-list');
    const nearby = (status?.monsters ?? []).filter(monster => !monster.dead && monster.hp > 0).sort((a, b) => {
      const distance = (p: Position) => status?.player ? Math.max(Math.abs(p.x - status.player.x), Math.abs(p.y - status.player.y)) : 0;
      return distance(a) - distance(b);
    });
    for (const monster of nearby) {
      const actor = actors?.actors.find(row => row.id === monster.id && row.kind === 1);
      const key = actor ? actorKey(actors!.world, actor.id, actor.incarnation) : `unavailable:${monster.id}`;
      live.add(key); let row = this.monsters.get(key);
      if (!row) {
        const root = document.createElement('div'), text = document.createElement('span'), button = document.createElement('button');
        root.className = 'console-actor-row'; button.type = 'button'; button.className = 'secondary compact'; button.textContent = 'Attack';
        button.addEventListener('click', () => this.operation(() => this.target({ type: 'attack', key })));
        root.append(text, button); list.append(root); row = { root, text, button }; this.monsters.set(key, row);
      }
      row.text.textContent = `${monster.name} · Lv ${monster.level}\n${monster.x}, ${monster.y} · HP ${monster.hp} / ${monster.maxHp}`;
      row.button.hidden = !actor; row.button.setAttribute('aria-label', `Attack ${monster.name} #${monster.id}`);
    }
    for (const [key, row] of this.monsters) if (!live.has(key)) { row.root.remove(); this.monsters.delete(key); }
    // The empty placeholder is a separate node so telemetry never replaces focused action buttons.
    let empty = list.querySelector<HTMLElement>('.console-empty');
    if (!empty) { list.textContent = ''; for (const row of this.monsters.values()) list.append(row.root); empty = document.createElement('p'); empty.className = 'console-empty'; list.append(empty); }
    empty.hidden = live.size > 0; empty.textContent = 'No living monsters observed.';
    const drops = this.get('console-drops'); drops.replaceChildren();
    for (const drop of status?.drops ?? []) { const row = document.createElement('p'); row.textContent = `${itemName(drop.itemId)} × ${drop.count} · ${drop.x}, ${drop.y}`; drops.append(row); }
    if (!drops.childElementCount) drops.textContent = 'No drops observed.';
    const manual = status?.manualTarget;
    this.get('console-target-result').textContent = manual && manual.sequence > 0
      ? `Latest bounded command #${manual.sequence}: ${manual.state} · ${manual.reason}${manual.settling ? ' · awaiting movement/Stop reconciliation' : ''}` : 'No bounded command observed.';
    this.get('console-target-result').hidden = !manual || manual.sequence <= 0;
    const request = this.itemRequest, result = status?.actionResult;
    if (request && request.world !== this.world()) { this.get('console-item-result').textContent = 'Connection changed. The previous item outcome is not confirmed here.'; this.itemRequest = null; }
    this.get('console-latest-action').textContent = result && result.sequence > 0
      ? `Latest controller action #${result.sequence}: ${result.status === 'confirmed' ? 'receipt confirmed' : result.status === 'failed' ? 'failed or unresolved' : result.status} · ${result.reason}` : 'No controller action receipt observed.';
    this.drawMap(); this.refreshLocks();
  }
  private drawMap(): void {
    const status = this.status, canvas = this.canvas, ctx = canvas.getContext('2d'); if (!ctx) return;
    const map = status?.map ?? '';
    if (this.rasterMap !== map) {
      this.rasterMap = map; this.raster = null; const grid = searchGrid(map);
      if (grid) {
        const nav = new GridNavigator(grid), raster = document.createElement('canvas'); raster.width = grid.width; raster.height = grid.height;
        const context = raster.getContext('2d');
        if (context) {
          const image = context.createImageData(grid.width, grid.height);
          for (let y = 0; y < grid.height; y++) for (let x = 0; x < grid.width; x++) {
            const state = nav.tileState({ x, y }), color = state === 'blocked' ? [9, 17, 34] : state === 'portal' ? [121, 79, 48] : [41, 67, 58];
            image.data.set([...color, 255], (x + (grid.height - 1 - y) * grid.width) * 4);
          }
          context.putImageData(image, 0, 0); this.raster = raster;
        }
      }
    }
    canvas.width = this.raster?.width ?? 400; canvas.height = this.raster?.height ?? 400; canvas.style.aspectRatio = `${canvas.width} / ${canvas.height}`;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const n = status?.navigation;
    this.get('navigation-info').textContent = n ? `${n.width} × ${n.height} · ${n.reachable.toLocaleString()} reachable · ${n.blocked.toLocaleString()} blocked · ${n.excluded.toLocaleString()} portal exclusions${n.routeLength ? ` · ${n.routeLength} route cells` : ''}${n.ready ? '' : ' · character outside verified safe ground'}`
      : map ? `Collision unavailable for ${map}. ${NAVIGATION_MAPS.length} maps supported.` : 'Connect a character to inspect its field.';
    if (!this.raster) { ctx.font = '13px system-ui'; ctx.textAlign = 'center'; ctx.fillStyle = '#94a3b8'; ctx.fillText('Waiting for verified map collision', canvas.width / 2, canvas.height / 2); return; }
    ctx.imageSmoothingEnabled = false; ctx.drawImage(this.raster, 0, 0);
    const route = (cells: Position[], color: string, width: number) => {
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath();
      cells.forEach((p, i) => { if (i) ctx.lineTo(p.x + .5, canvas.height - .5 - p.y); else ctx.moveTo(p.x + .5, canvas.height - .5 - p.y); }); ctx.stroke();
    };
    route(n?.route ?? [], '#7dd3fc', 1.6); route(n?.leg ?? [], '#d9f99d', 2.2);
    const dot = (p: Position, color: string, radius: number) => {
      ctx.fillStyle = color; ctx.strokeStyle = '#091122'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(p.x + .5, canvas.height - .5 - p.y, radius, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    };
    for (const monster of status?.monsters ?? []) dot(monster, '#fdba74', 2.5);
    for (const drop of status?.drops ?? []) dot(drop, '#c4b5fd', 2);
    if (n?.goal) dot(n.goal, '#7dd3fc', 3.5); if (status?.player) dot(status.player, '#86efac', 4);
  }
}
