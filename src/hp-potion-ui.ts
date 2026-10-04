import { itemName } from './game-catalog';
import { DEFAULT_HP_POTIONS, HP_POTION_IDS, type HpPotionSettings } from './hp-potions';

interface PotionRow {
  root: HTMLDivElement;
  choice: HTMLInputElement;
  position: HTMLSpanElement;
  stock: HTMLSpanElement;
  earlier: HTMLButtonElement;
  later: HTMLButtonElement;
}

function setText(element: HTMLElement, text: string): void {
  if (element.textContent !== text) element.textContent = text;
}
function inputNumber(input: HTMLInputElement): number { return input.value.trim() === '' ? NaN : Number(input.value); }

/** Edits one policy; inventory updates only refresh labels, never send actions. */
export class HpPotionUi {
  readonly root = document.createElement('section');
  private readonly mode = document.createElement('select');
  private readonly belowPercent = this.numberInput('belowPercent', 'Use below HP %', 1, 100);
  private readonly minStock = this.numberInput('minStock', 'Keep quantity of each potion', 0, 9999);
  private readonly cooldownSeconds = this.numberInput('cooldownSeconds', 'Shared cooldown, seconds', 1, 3600);
  private readonly list = document.createElement('div');
  private readonly guide = document.createElement('p');
  private readonly stopWarning = document.createElement('p');
  private readonly rows = new Map<number, PotionRow>();
  private itemIds: number[] = [];
  private locked = false;

  constructor(private readonly changed: () => void, private readonly stopLimit: () => number) {
    this.root.className = 'hp-potion-panel manual-group';
    this.root.id = 'hp-potions';
    const title = document.createElement('h2'); title.textContent = 'Automatic HP potions';
    const scope = document.createElement('p'); scope.className = 'hint';
    scope.textContent = 'Supports the eight HP potions below. SP potions, status potions and food are excluded. Advanced recovery item rules keep priority for their configured items.';
    const grid = document.createElement('div'); grid.className = 'form-grid';
    this.mode.id = 'hp-potion-mode'; this.mode.dataset.config = 'true';
    for (const [value, text] of [['off', 'Off'], ['any', 'Any carried HP potion'], ['selected', 'Choose potions']] as const) {
      const option = document.createElement('option'); option.value = value; option.textContent = text; this.mode.append(option);
    }
    grid.append(this.label('HP potion selection', this.mode), ...[this.belowPercent, this.minStock, this.cooldownSeconds].map(input => this.label(input.ariaLabel ?? '', input)));
    this.guide.className = 'hint'; this.guide.ariaLive = 'polite';
    this.stopWarning.className = 'notice error'; this.stopWarning.ariaLive = 'polite';
    this.list.className = 'hp-potion-list';
    this.root.append(title, scope, grid, this.guide, this.stopWarning, this.list);
    for (const itemId of HP_POTION_IDS) this.addPotion(itemId);
    this.mode.addEventListener('change', () => {
      if (this.locked) return;
      // Choosing the mode is an explicit opt-in. A visible Red Potion choice
      // keeps the first selection valid; no game command is sent here.
      if (this.mode.value === 'selected' && this.itemIds.length === 0) this.itemIds = [501];
      this.syncChoices(); this.changed();
    });
    for (const input of [this.belowPercent, this.minStock, this.cooldownSeconds]) input.addEventListener('input', () => {
      if (this.locked) return;
      this.syncGuidance(); this.changed();
    });
    this.write(DEFAULT_HP_POTIONS);
    this.update(undefined);
  }

  read(): HpPotionSettings {
    return { mode: this.mode.value as HpPotionSettings['mode'], itemIds: [...this.itemIds],
      belowPercent: inputNumber(this.belowPercent), minStock: inputNumber(this.minStock), cooldownSeconds: inputNumber(this.cooldownSeconds) };
  }

  write(settings: HpPotionSettings): void {
    this.mode.value = settings.mode;
    this.itemIds = [...settings.itemIds];
    for (const key of ['belowPercent', 'minStock', 'cooldownSeconds'] as const) {
      const value = String(settings[key]);
      if (this[key].value !== value) this[key].value = value;
    }
    this.syncChoices();
  }

  lock(locked: boolean): void { this.locked = locked; this.syncChoices(); }

  update(character: unknown): void {
    const value = character && typeof character === 'object' ? character as Record<string, unknown> : {};
    let stock: Map<number, number> | null = null;
    if (value.inventoryKnown === true && Array.isArray(value.inventory)) {
      stock = new Map();
      for (const entry of value.inventory) {
        const row = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
        if (!Number.isInteger(row.itemId) || Number(row.itemId) < 1 || Number(row.itemId) > 2147483647 || !Number.isInteger(row.count) || Number(row.count) < 0 || Number(row.count) > 32767) { stock = null; break; }
        const itemId = Number(row.itemId);
        stock.set(itemId, (stock.get(itemId) ?? 0) + Number(row.count));
      }
    }
    for (const [itemId, row] of this.rows) setText(row.stock, stock === null ? 'Carried: unknown' : `Carried: ${stock.get(itemId) ?? 0}`);
    this.syncGuidance();
  }

  private numberInput(key: string, text: string, min: number, max: number): HTMLInputElement {
    const input = document.createElement('input'); input.type = 'number'; input.id = `hp-potion-${key}`;
    input.ariaLabel = text; input.min = String(min); input.max = String(max); input.step = '1'; input.dataset.config = 'true';
    return input;
  }

  private label(text: string, input: HTMLInputElement | HTMLSelectElement): HTMLLabelElement {
    const label = document.createElement('label'); label.className = 'form-field';
    const title = document.createElement('span'); title.textContent = text; label.append(title, input); return label;
  }

  private addPotion(itemId: number): void {
    const root = document.createElement('div'); root.className = 'hp-potion-row'; root.dataset.itemId = String(itemId);
    const label = document.createElement('label'); label.className = 'hp-potion-choice';
    const choice = document.createElement('input'); choice.type = 'checkbox'; choice.dataset.config = 'true'; choice.dataset.potion = String(itemId);
    const name = document.createElement('span'); name.textContent = itemName(itemId);
    const position = document.createElement('span'); position.className = 'hp-potion-position';
    const stock = document.createElement('span'); stock.className = 'hp-potion-stock';
    label.append(choice, name); root.append(position, label, stock);
    const buttons = document.createElement('div'); buttons.className = 'button-row';
    const button = (direction: -1 | 1): HTMLButtonElement => {
      const result = document.createElement('button'); result.type = 'button'; result.className = 'secondary compact'; result.dataset.config = 'true';
      result.textContent = direction < 0 ? 'Earlier' : 'Later'; result.ariaLabel = `Move ${itemName(itemId)} ${direction < 0 ? 'earlier' : 'later'}`;
      result.addEventListener('click', () => {
        if (result.disabled || this.locked || this.mode.value !== 'selected') return;
        const index = this.itemIds.indexOf(itemId), other = index + direction;
        if (index < 0 || other < 0 || other >= this.itemIds.length) return;
        [this.itemIds[index], this.itemIds[other]] = [this.itemIds[other]!, this.itemIds[index]!];
        this.syncChoices(); this.changed();
      }); return result;
    };
    const earlier = button(-1), later = button(1); buttons.append(earlier, later); root.append(buttons);
    const select = () => {
      if (this.locked || this.mode.value !== 'selected') return;
      if (choice.checked === this.itemIds.includes(itemId)) return;
      this.itemIds = choice.checked ? [...this.itemIds.filter(id => id !== itemId), itemId] : this.itemIds.filter(id => id !== itemId);
      this.syncChoices(); this.changed();
    };
    // Commit before input bubbles to Main, which refreshes and locks the form.
    choice.addEventListener('input', select);
    choice.addEventListener('change', select);
    this.rows.set(itemId, { root, choice, position, stock, earlier, later }); this.list.append(root);
  }

  private syncChoices(): void {
    const selected = this.mode.value === 'selected', any = this.mode.value === 'any';
    const order = selected ? [...this.itemIds, ...HP_POTION_IDS.filter(id => !this.itemIds.includes(id))] : [...HP_POTION_IDS];
    for (let index = 0; index < order.length; index++) {
      const row = this.rows.get(order[index]!)!;
      // Retain row/input identity; move only rows whose preference changed.
      if (this.list.children[index] !== row.root) this.list.insertBefore(row.root, this.list.children[index] ?? null);
    }
    this.mode.disabled = this.locked;
    for (const input of [this.belowPercent, this.minStock, this.cooldownSeconds]) input.disabled = this.locked;
    for (const [itemId, row] of this.rows) {
      const index = this.itemIds.indexOf(itemId);
      row.choice.checked = any || index >= 0; row.choice.disabled = this.locked || !selected;
      row.earlier.hidden = row.later.hidden = !selected || index < 0;
      row.earlier.disabled = this.locked || !selected || index <= 0;
      row.later.disabled = this.locked || !selected || index < 0 || index === this.itemIds.length - 1;
      setText(row.position, selected && index >= 0 ? `${index + 1}.` : any ? `${HP_POTION_IDS.indexOf(itemId) + 1}.` : '');
    }
    this.syncGuidance();
  }

  private syncGuidance(): void {
    setText(this.guide, this.mode.value === 'off' ? 'Automatic HP potions are off. Your choices are retained.' : this.mode.value === 'selected' && this.itemIds.length === 0
      ? 'Choose at least one HP potion before saving or starting the bot.'
      : 'Earlier available potions are used first. Each keeps the configured reserve, and all share one cooldown. Your choices are retained when you switch modes.');
    if (this.mode.value === 'off') { this.stopWarning.hidden = true; setText(this.stopWarning, ''); return; }
    const stop = this.stopLimit(), threshold = inputNumber(this.belowPercent);
    const warn = Number.isFinite(stop) && Number.isFinite(threshold) && threshold <= stop;
    this.stopWarning.hidden = !warn;
    setText(this.stopWarning, warn ? `The bot stops at ${stop}% HP before using potions. Set “Use below HP %” above ${stop}% to heal before that limit. The stop limit remains unchanged.` : '');
  }
}
