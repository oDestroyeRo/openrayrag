import {
  mapCoordinate,
  consoleCharacterText,
  consoleInventory,
  consoleMonsters,
  consoleNpcs,
  consolePlayerShops,
  consoleInteractionAt,
  consoleNpcTalk,
  consoleVendingView,
  NPC_MAP_RADIUS,
  consoleSelectedItem,
  consoleInventorySignature,
  consoleDropTexts,
  consoleRadarSignature,
} from './bot-console-logic';
export { mapCoordinate } from './bot-console-logic';
import type { Snapshot } from '../automation/engine';
import { ITEM_CATALOG, itemName } from '../catalog/game-catalog';
import { previewManualTarget } from '../combat/manual-target';
import { manualTargetView } from '../combat/manual-target-view';
import { NAVIGATION_MAPS, searchGrid } from '../navigation/navigation';
import { paintMapCollision } from '../navigation/map-raster';
import type { Position } from '../protocol/protocol';
import type { SettingsInput } from '../settings/settings';

interface Hooks {
  settings(): SettingsInput;
  command(request: Record<string, unknown>): Promise<unknown>;
  notify(text: string, error?: boolean): void;
  account(): void;
  lootSettings(): void;
  manualTools(): void;
  npcDialogue(id: number): void;
  playerShop(id: number): void;
}
/** Projection only. Manual commands enter the existing receipt-owning controller. */
export class BotConsole {
  private status: Snapshot | null = null;
  private locked = true;
  private lockReason = 'Connect a verified character to use manual controls.';
  private pending = false;
  private rasterMap = '';
  private raster: HTMLCanvasElement | null = null;
  private mapSignature: string | null = null;
  private dropTexts: string[] | null = null;
  private inventorySignature = '';
  private inventoryWorld: string | null = null;
  private readonly monsters = new Map<
    string,
    { root: HTMLElement; text: HTMLElement; button: HTMLButtonElement }
  >();
  private readonly npcs = new Map<
    string,
    { root: HTMLElement; text: HTMLElement; button: HTMLButtonElement }
  >();
  private readonly shops = new Map<
    string,
    { root: HTMLElement; text: HTMLElement; button: HTMLButtonElement }
  >();
  private itemRequest: { world: string | null } | null = null;
  private readonly canvas: HTMLCanvasElement;
  private readonly x: HTMLInputElement;
  private readonly y: HTMLInputElement;
  private readonly items: HTMLSelectElement;
  private readonly use: HTMLButtonElement;
  constructor(
    private readonly host: HTMLElement,
    private readonly hooks: Hooks,
  ) {
    this.canvas = this.get('radar');
    this.x = this.get('console-walk-x');
    this.y = this.get('console-walk-y');
    this.canvas.addEventListener('contextrestored', () => {
      this.rasterMap = '';
      this.raster = null;
      this.mapSignature = null;
      this.drawMap();
    });
    this.items = this.get('console-item');
    this.use = this.get('console-use-item');
    this.canvas.addEventListener('click', (event) => {
      const rect = this.canvas.getBoundingClientRect();
      const point = mapCoordinate(
        event.clientX,
        event.clientY,
        rect,
        this.canvas.width,
        this.canvas.height,
      );
      const npc =
        this.raster && this.rasterMap === this.status?.map
          ? consoleInteractionAt({
              status: this.status,
              clientX: event.clientX,
              clientY: event.clientY,
              rect,
              width: this.canvas.width,
              height: this.canvas.height,
            })
          : null;
      if (npc) {
        this.operation(() => this.interact(npc.key, npc.family));
        return;
      }
      if (point)
        this.operation(async () => {
          if (!this.status || this.rasterMap !== this.status.map || !this.raster)
            throw new Error('Current map collision is unavailable.');
          this.x.value = String(point.x);
          this.y.value = String(point.y);
          await this.target({ type: 'walk', destination: point });
        });
    });
    this.canvas.addEventListener('mousemove', (event) => {
      const npc =
        this.raster && this.rasterMap === this.status?.map
          ? consoleInteractionAt({
              status: this.status,
              clientX: event.clientX,
              clientY: event.clientY,
              rect: this.canvas.getBoundingClientRect(),
              width: this.canvas.width,
              height: this.canvas.height,
            })
          : null;
      this.canvas.title = npc
        ? `${npc.name} · ${npc.kindLabel} · ${npc.x}, ${npc.y} · Click to ${npc.family === 'shop' ? 'view shop' : 'talk'}`
        : 'Click ground to walk, an NPC to talk, or a player shop to view its stock.';
    });
    this.get('console-walk-form').addEventListener('submit', (event) => {
      event.preventDefault();
      this.operation(() => {
        if (![this.x.value, this.y.value].every((value) => /^\d+$/.test(value.trim())))
          throw new Error('Enter whole map coordinates.');
        return this.target({
          type: 'walk',
          destination: { x: Number(this.x.value), y: Number(this.y.value) },
        });
      });
    });
    this.items.addEventListener('change', () => this.itemControls());
    this.use.addEventListener('click', () =>
      this.operation(async () => {
        const item = this.selectedItem();
        if (!item || ITEM_CATALOG[item.itemId]?.useType !== 1)
          throw new Error(
            'Choose a known untargeted usable item. Targeted items require the manual tools.',
          );
        this.itemRequest = { world: this.world() };
        this.get('console-item-result').textContent =
          `${itemName(item.itemId)} use requested. Shared action receipts below show observed outcomes.`;
        try {
          await this.hooks.command({ type: 'useItem', itemId: item.itemId });
        } catch (error) {
          this.itemRequest = null;
          this.get('console-item-result').textContent =
            error instanceof Error ? error.message : 'Item request unavailable.';
          throw error;
        }
      }),
    );
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
  private world(): string | null {
    return this.status?.actorObservations?.world ?? null;
  }
  private async interact(key: string, family: 'npc' | 'shop'): Promise<void> {
    const request =
      family === 'shop'
        ? consoleVendingView(this.status, key, Date.now())
        : consoleNpcTalk(this.status, key, Date.now());
    this.get('console-action').textContent =
      family === 'shop'
        ? 'View shop requested · waiting for stock from the server.'
        : 'Talk requested · waiting for NPC dialogue from the server.';
    this.get('console-action').hidden = false;
    await this.hooks.command(request);
    if (family === 'shop') this.hooks.playerShop(request.target.id);
    else this.hooks.npcDialogue(request.target.id);
  }
  private async target(
    command: { type: 'walk'; destination: Position } | { type: 'attack'; key: string },
  ): Promise<void> {
    if (!this.status) throw new Error('Connect a verified character first.');
    const { request, context } = manualTargetView(
      this.status as unknown as Record<string, unknown>,
      this.hooks.settings(),
      command,
    );
    const route = previewManualTarget(request, context);
    this.get('console-action').textContent =
      `${command.type === 'walk' ? 'Walk' : 'Attack'} requested · ${Math.max(0, route.length - 1)} route cells · waiting for controller observations.`;
    this.get('console-action').hidden = false;
    await this.hooks.command(request as unknown as Record<string, unknown>);
  }
  private operation(action: () => Promise<void>): void {
    if (this.locked || this.pending) {
      this.hooks.notify(this.lockReason, true);
      return;
    }
    this.pending = true;
    this.refreshLocks();
    void Promise.resolve()
      .then(action)
      .catch((error) => {
        const reason =
          error instanceof Error
            ? error.message
            : typeof error === 'string'
              ? error
              : 'Manual action is unavailable.';
        this.get('console-action').textContent = reason;
        this.hooks.notify(reason, true);
        this.get('console-action').hidden = false;
      })
      .finally(() => {
        this.pending = false;
        this.refreshLocks();
      });
  }
  lock(locked: boolean, reason: string): void {
    this.locked = locked;
    this.lockReason = reason;
    this.refreshLocks();
  }
  private refreshLocks(): void {
    const disabled = this.locked || this.pending;
    this.get('console-lock').textContent = this.locked
      ? this.lockReason
      : this.pending
        ? 'Requesting one action…'
        : 'Manual controls ready · one action at a time';
    this.canvas.setAttribute('aria-disabled', String(disabled));
    this.canvas.classList.toggle('console-map-locked', disabled);
    this.x.disabled = disabled;
    this.y.disabled = disabled;
    this.items.disabled = this.status?.character.inventoryKnown !== true;
    this.get<HTMLButtonElement>('console-walk').disabled =
      disabled || !searchGrid(this.status?.map ?? '');
    for (const row of this.monsters.values()) row.button.disabled = disabled;
    for (const row of [...this.npcs.values(), ...this.shops.values()])
      row.button.disabled = disabled;
    this.itemControls();
  }
  private selectedItem(): { itemId: number; count: number } | null {
    return this.status?.character.inventoryKnown
      ? consoleSelectedItem(this.status, this.items.value)
      : null;
  }
  private itemControls(): void {
    const item = this.selectedItem(),
      info = item ? ITEM_CATALOG[item.itemId] : undefined;
    this.use.disabled = this.locked || this.pending || !item || info?.useType !== 1;
    this.get('console-item-info').textContent = !this.status?.character.inventoryKnown
      ? 'Inventory has not been observed.'
      : !item
        ? this.items.value
          ? `${itemName(Number(this.items.value))} is no longer carried. Choose another observed item.`
          : 'Choose an observed item. No item is selected automatically.'
        : `${itemName(item.itemId)} · ${item.count} observed · ${info?.useType === 1 ? 'Untargeted use' : info?.useType === 2 ? 'Requires an explicit target in manual tools' : 'No verified direct-use action'}`;
  }
  render(status: Snapshot | null): void {
    this.status = status;
    for (const [id, text] of Object.entries(consoleCharacterText(status)))
      this.get(`console-${id}`).textContent = text;
    const character = status?.character,
      signature = consoleInventorySignature(status, this.world());
    if (signature !== this.inventorySignature) {
      this.inventorySignature = signature;
      const selected = this.inventoryWorld === this.world() ? this.items.value : '',
        stock = consoleInventory(status);
      this.inventoryWorld = this.world();
      this.items.replaceChildren();
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = 'Choose an item';
      this.items.append(placeholder);
      for (const { itemId, label } of stock) {
        const option = document.createElement('option');
        option.value = String(itemId);
        option.textContent = label;
        this.items.append(option);
      }
      if (selected !== '' && !stock.some((item) => item.itemId === Number(selected))) {
        const unavailable = document.createElement('option');
        unavailable.value = selected;
        unavailable.disabled = true;
        unavailable.textContent = `${itemName(Number(selected))} · ${character?.inventoryKnown ? 'no longer carried' : 'stock unobserved'}`;
        this.items.append(unavailable);
      }
      this.items.value = selected;
      this.get('console-stock-count').textContent = character?.inventoryKnown
        ? `${stock.length} item types`
        : 'Not observed';
    }
    const live = new Set<string>(),
      list = this.get('monster-list');
    for (const monster of consoleMonsters(status)) {
      const key = monster.key;
      live.add(key);
      let row = this.monsters.get(key);
      if (!row) {
        const root = document.createElement('div'),
          text = document.createElement('span'),
          button = document.createElement('button');
        root.className = 'console-actor-row';
        button.type = 'button';
        button.className = 'secondary compact';
        button.textContent = 'Attack';
        button.addEventListener('click', () =>
          this.operation(() => this.target({ type: 'attack', key })),
        );
        root.append(text, button);
        list.append(root);
        row = { root, text, button };
        this.monsters.set(key, row);
      }
      row.text.textContent = monster.text;
      row.button.hidden = !monster.attackable;
      row.button.setAttribute('aria-label', monster.label);
    }
    for (const [key, row] of this.monsters)
      if (!live.has(key)) {
        row.root.remove();
        this.monsters.delete(key);
      }
    // The empty placeholder is a separate node so telemetry never replaces focused action buttons.
    let empty = list.querySelector<HTMLElement>('.console-empty');
    if (!empty) {
      list.textContent = '';
      for (const row of this.monsters.values()) list.append(row.root);
      empty = document.createElement('p');
      empty.className = 'console-empty';
      list.append(empty);
    }
    empty.hidden = live.size > 0;
    empty.textContent = 'No living monsters observed.';
    for (const family of ['npc', 'shop'] as const) {
      const list = this.get(family === 'npc' ? 'console-npcs' : 'console-player-shops');
      const rows = family === 'npc' ? this.npcs : this.shops,
        live = new Set<string>();
      for (const actor of family === 'npc' ? consoleNpcs(status) : consolePlayerShops(status)) {
        const key = actor.key;
        live.add(key);
        let row = rows.get(key);
        if (!row) {
          const root = document.createElement('div'),
            text = document.createElement('span'),
            button = document.createElement('button');
          root.className = 'console-actor-row';
          button.type = 'button';
          button.className = 'secondary compact';
          button.textContent = family === 'npc' ? 'Talk' : 'View shop';
          button.addEventListener('click', () => this.operation(() => this.interact(key, family)));
          root.append(text, button);
          list.append(root);
          row = { root, text, button };
          rows.set(key, row);
        }
        row.text.textContent = actor.text;
        row.button.hidden = !actor.talkable;
        row.button.setAttribute('aria-label', actor.label);
      }
      for (const [key, row] of rows)
        if (!live.has(key)) {
          row.root.remove();
          rows.delete(key);
        }
      let empty = list.querySelector<HTMLElement>('.console-empty');
      if (!empty) {
        list.textContent = '';
        for (const row of rows.values()) list.append(row.root);
        empty = document.createElement('p');
        empty.className = 'console-empty';
        list.append(empty);
      }
      empty.hidden = live.size > 0;
      empty.textContent = family === 'npc' ? 'No NPCs observed.' : 'No player shops observed.';
    }
    const dropTexts = consoleDropTexts(status);
    if (
      this.dropTexts?.length !== dropTexts.length ||
      dropTexts.some((text, index) => text !== this.dropTexts![index])
    ) {
      const drops = this.get('console-drops');
      drops.replaceChildren();
      for (const text of dropTexts) {
        const row = document.createElement('p');
        row.textContent = text;
        drops.append(row);
      }
      if (!dropTexts.length) drops.textContent = 'No drops observed.';
      this.dropTexts = dropTexts;
    }
    const manual = status?.manualTarget;
    this.get('console-target-result').textContent =
      manual && manual.sequence > 0
        ? `Latest bounded command #${manual.sequence}: ${manual.state} · ${manual.reason}${manual.settling ? ' · awaiting movement/Stop reconciliation' : ''}`
        : 'No bounded command observed.';
    this.get('console-target-result').hidden = !manual || manual.sequence <= 0;
    const request = this.itemRequest,
      result = status?.actionResult;
    if (request && request.world !== this.world()) {
      this.get('console-item-result').textContent =
        'Previous item request. Shared action receipts below show observed outcomes.';
      this.itemRequest = null;
    }
    this.get('console-latest-action').textContent =
      result && result.sequence > 0
        ? `Latest controller action #${result.sequence}: ${result.status === 'confirmed' ? 'receipt confirmed' : result.status === 'failed' ? 'failed or unresolved' : result.status} · ${result.reason}`
        : 'No controller action receipt observed.';
    this.drawMap();
    this.refreshLocks();
  }
  private drawMap(): void {
    const status = this.status,
      canvas = this.canvas,
      ctx = canvas.getContext('2d');
    if (!ctx) return;
    const map = status?.map ?? '';
    if (this.rasterMap !== map) {
      this.rasterMap = map;
      this.raster = null;
      const grid = searchGrid(map);
      if (grid) {
        const raster = document.createElement('canvas');
        raster.width = grid.width;
        raster.height = grid.height;
        const context = raster.getContext('2d');
        if (context) {
          const image = context.createImageData(grid.width, grid.height);
          paintMapCollision(grid, image.data);
          context.putImageData(image, 0, 0);
          this.raster = raster;
        }
      }
    }
    const width = this.raster?.width ?? 400,
      height = this.raster?.height ?? 400;
    const resized = canvas.width !== width || canvas.height !== height;
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    canvas.style.aspectRatio = `${width} / ${height}`;
    const n = status?.navigation;
    this.get('navigation-info').textContent = n
      ? `${n.width} × ${n.height} · ${n.reachable.toLocaleString()} reachable · ${n.blocked.toLocaleString()} blocked · ${n.excluded.toLocaleString()} portal exclusions${n.routeLength ? ` · ${n.routeLength} route cells` : ''}${n.ready ? '' : ' · character outside verified safe ground'}`
      : map
        ? `Collision unavailable for ${map}. ${NAVIGATION_MAPS.length} maps supported.`
        : 'Connect a character to inspect its field.';
    const signature = consoleRadarSignature({ status, map, width, height });
    if (!resized && signature === this.mapSignature) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!this.raster) {
      ctx.font = '13px system-ui';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#94a3b8';
      ctx.fillText('Waiting for verified map collision', canvas.width / 2, canvas.height / 2);
      this.mapSignature = signature;
      return;
    }
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.raster, 0, 0);
    const route = (cells: Position[], color: string, width: number) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      cells.forEach((p, i) => {
        if (i) ctx.lineTo(p.x + 0.5, canvas.height - 0.5 - p.y);
        else ctx.moveTo(p.x + 0.5, canvas.height - 0.5 - p.y);
      });
      ctx.stroke();
    };
    route(n?.route ?? [], '#7dd3fc', 1.6);
    route(n?.leg ?? [], '#d9f99d', 2.2);
    const dot = (p: Position, color: string, radius: number) => {
      ctx.fillStyle = color;
      ctx.strokeStyle = '#091122';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(p.x + 0.5, canvas.height - 0.5 - p.y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    };
    for (const monster of status?.monsters ?? []) dot(monster, '#fdba74', 2.5);
    for (const drop of status?.drops ?? []) dot(drop, '#c4b5fd', 2);
    for (const npc of consoleNpcs(status)) {
      const x = npc.x + 0.5,
        y = canvas.height - 0.5 - npc.y,
        r = NPC_MAP_RADIUS;
      ctx.fillStyle = '#67e8f9';
      ctx.strokeStyle = '#091122';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r, y);
      ctx.lineTo(x, y + r);
      ctx.lineTo(x - r, y);
      ctx.lineTo(x, y - r);
      ctx.fill();
      ctx.stroke();
    }
    for (const shop of consolePlayerShops(status)) {
      const x = shop.x + 0.5,
        y = canvas.height - 0.5 - shop.y,
        r = NPC_MAP_RADIUS;
      ctx.fillStyle = '#f9a8d4';
      ctx.strokeStyle = '#091122';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x - r, y - r);
      ctx.lineTo(x + r, y - r);
      ctx.lineTo(x + r, y + r);
      ctx.lineTo(x - r, y + r);
      ctx.lineTo(x - r, y - r);
      ctx.fill();
      ctx.stroke();
    }
    if (n?.goal) dot(n.goal, '#7dd3fc', 3.5);
    if (status?.player) dot(status.player, '#86efac', 4);
    this.mapSignature = signature;
  }
}
