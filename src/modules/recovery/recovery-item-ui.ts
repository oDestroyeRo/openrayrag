import { filter, map } from 'effect/Array';
import {
  carriedRecoveryItem,
  recoveryChoices,
  recoveryInventory,
  recoveryStockSummary,
  type RecoveryInventory,
} from './recovery-item-ui-logic';
import { itemId, type ItemId } from '../../shared/domain-values';
import { itemName } from '../catalog/game-catalog';
import {
  DEFAULT_RECOVERY_ITEMS,
  DEFAULT_SP_ITEMS,
  RECOVERY_ITEM_IDS,
  type RecoveryItemSettings,
  type RecoveryResource,
} from './recovery-items';

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
function inputNumber(input: HTMLInputElement): number {
  return input.value.trim() === '' ? NaN : Number(input.value);
}

/** Edits one policy; inventory updates only refresh labels, never send actions. */
export class RecoveryItemUi {
  readonly root = document.createElement('section');
  private readonly mode = document.createElement('select');
  private readonly belowPercent: HTMLInputElement;
  private readonly minStock: HTMLInputElement;
  private readonly cooldownSeconds: HTMLInputElement;
  private readonly list = document.createElement('div');
  private readonly guide = document.createElement('p');
  private readonly stopWarning = document.createElement('p');
  private readonly inventoryMessage = document.createElement('p');
  private readonly rows = new Map<ItemId, PotionRow>();
  private readonly ids: readonly ItemId[];
  private stock: RecoveryInventory | null = null;
  private itemIds: ItemId[] = [];
  private locked = false;

  constructor(
    private readonly changed: () => void,
    private readonly stopLimit: () => number,
    private readonly resource: RecoveryResource = 'hp',
  ) {
    const name = resource.toUpperCase();
    this.ids = map(RECOVERY_ITEM_IDS[resource], (id) => itemId(id));
    this.belowPercent = this.numberInput('belowPercent', `Use below ${name} %`, 1, 100);
    this.minStock = this.numberInput('minStock', 'Keep quantity of each item', 0, 9999);
    this.cooldownSeconds = this.numberInput(
      'cooldownSeconds',
      resource === 'hp' ? 'Shared cooldown, seconds (0 = no cooldown)' : 'Shared cooldown, seconds',
      resource === 'hp' ? 0 : 1,
      3600,
    );
    this.root.className = 'hp-potion-panel manual-group';
    this.root.id = `${resource}-potions`;
    const title = document.createElement('h2');
    title.textContent = `${name} recovery items`;
    const scope = document.createElement('p');
    scope.className = 'hint';
    scope.textContent = `Shows carried potions, food and herbs that restore ${name}. Advanced recovery item rules keep priority for their configured items.`;
    const grid = document.createElement('div');
    grid.className = 'form-grid';
    this.mode.id = `${resource}-potion-mode`;
    this.mode.dataset.config = 'true';
    for (const [value, text] of [
      ['off', 'Off'],
      ['any', `Any carried ${name} item`],
      ['selected', 'Choose items'],
    ] as const) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      this.mode.append(option);
    }
    grid.append(
      this.label(`${name} item selection`, this.mode),
      ...[this.belowPercent, this.minStock, this.cooldownSeconds].map((input) =>
        this.label(input.ariaLabel ?? '', input),
      ),
    );
    this.guide.className = 'hint';
    this.guide.ariaLive = 'polite';
    this.stopWarning.className = 'notice error';
    this.stopWarning.ariaLive = 'polite';
    this.list.className = 'hp-potion-list';
    this.inventoryMessage.className = 'hint';
    this.inventoryMessage.ariaLive = 'polite';
    this.root.append(
      title,
      scope,
      grid,
      this.guide,
      this.stopWarning,
      this.inventoryMessage,
      this.list,
    );
    for (const itemId of this.ids) this.addPotion(itemId);
    this.mode.addEventListener('change', () => {
      if (this.locked) return;
      if (this.mode.value === 'selected' && this.itemIds.length === 0) {
        const first = this.ids.find(carriedRecoveryItem(this.stock));
        if (first !== undefined) this.itemIds = [first];
      }
      this.syncChoices();
      this.changed();
    });
    for (const input of [this.belowPercent, this.minStock, this.cooldownSeconds])
      input.addEventListener('input', () => {
        if (this.locked) return;
        this.syncGuidance();
        this.changed();
      });
    this.write(resource === 'hp' ? DEFAULT_RECOVERY_ITEMS : DEFAULT_SP_ITEMS);
    this.update(undefined);
  }

  read(): RecoveryItemSettings {
    return {
      mode: this.mode.value as RecoveryItemSettings['mode'],
      itemIds: [...this.itemIds],
      belowPercent: inputNumber(this.belowPercent),
      minStock: inputNumber(this.minStock),
      cooldownSeconds: inputNumber(this.cooldownSeconds),
    };
  }

  write(settings: RecoveryItemSettings): void {
    const itemIds = map(settings.itemIds, (id) => itemId(id));
    this.mode.value = settings.mode;
    this.itemIds = itemIds;
    for (const key of ['belowPercent', 'minStock', 'cooldownSeconds'] as const) {
      const value = String(settings[key]);
      if (this[key].value !== value) this[key].value = value;
    }
    this.syncChoices();
  }

  lock(locked: boolean): void {
    this.locked = locked;
    this.syncChoices();
  }

  update(character: unknown): void {
    const stock = recoveryInventory(character);
    this.stock = stock;
    for (const [itemId, row] of this.rows)
      setText(
        row.stock,
        stock === null ? 'Carried: unknown' : `Carried: ${stock.get(itemId) ?? 0}`,
      );
    this.syncChoices();
  }

  private numberInput(key: string, text: string, min: number, max: number): HTMLInputElement {
    const input = document.createElement('input');
    input.type = 'number';
    input.id = `${this.resource}-potion-${key}`;
    input.ariaLabel = text;
    input.min = String(min);
    input.max = String(max);
    input.step = '1';
    input.dataset.config = 'true';
    return input;
  }

  private label(text: string, input: HTMLInputElement | HTMLSelectElement): HTMLLabelElement {
    const label = document.createElement('label');
    label.className = 'form-field';
    const title = document.createElement('span');
    title.textContent = text;
    label.append(title, input);
    return label;
  }

  private addPotion(itemId: ItemId): void {
    const root = document.createElement('div');
    root.className = 'hp-potion-row';
    root.dataset.itemId = String(itemId);
    const label = document.createElement('label');
    label.className = 'hp-potion-choice';
    const choice = document.createElement('input');
    choice.type = 'checkbox';
    choice.dataset.config = 'true';
    choice.dataset.potion = String(itemId);
    const name = document.createElement('span');
    name.textContent = itemName(itemId);
    const position = document.createElement('span');
    position.className = 'hp-potion-position';
    const stock = document.createElement('span');
    stock.className = 'hp-potion-stock';
    label.append(choice, name);
    root.append(position, label, stock);
    const buttons = document.createElement('div');
    buttons.className = 'button-row';
    const button = (direction: -1 | 1): HTMLButtonElement => {
      const result = document.createElement('button');
      result.type = 'button';
      result.className = 'secondary compact';
      result.dataset.config = 'true';
      result.textContent = direction < 0 ? 'Earlier' : 'Later';
      result.ariaLabel = `Move ${itemName(itemId)} ${direction < 0 ? 'earlier' : 'later'}`;
      result.addEventListener('click', () => {
        if (result.disabled || this.locked || this.mode.value !== 'selected') return;
        const index = this.itemIds.indexOf(itemId),
          other = index + direction;
        if (index < 0 || other < 0 || other >= this.itemIds.length) return;
        [this.itemIds[index], this.itemIds[other]] = [this.itemIds[other]!, this.itemIds[index]!];
        this.syncChoices();
        this.changed();
      });
      return result;
    };
    const earlier = button(-1),
      later = button(1);
    buttons.append(earlier, later);
    root.append(buttons);
    const select = () => {
      if (choice.disabled || this.locked || this.mode.value !== 'selected') return;
      if (choice.checked === this.itemIds.includes(itemId)) return;
      const remaining = filter(this.itemIds, (id) => id !== itemId);
      this.itemIds = choice.checked ? [...remaining, itemId] : remaining;
      this.syncChoices();
      this.changed();
    };
    // Commit before input bubbles to Main, which refreshes and locks the form.
    choice.addEventListener('input', select);
    choice.addEventListener('change', select);
    this.rows.set(itemId, { root, choice, position, stock, earlier, later });
    this.list.append(root);
  }

  private syncChoices(): void {
    const selected = this.mode.value === 'selected',
      any = this.mode.value === 'any';
    const { order, visibleOrder } = recoveryChoices({
      selected,
      itemIds: this.itemIds,
      ids: this.ids,
      stock: this.stock,
    });
    for (let index = 0; index < order.length; index++) {
      const row = this.rows.get(order[index]!)!;
      // Retain row/input identity; move only rows whose preference changed.
      if (this.list.children[index] !== row.root)
        this.list.insertBefore(row.root, this.list.children[index] ?? null);
    }
    this.mode.disabled = this.locked;
    for (const input of [this.belowPercent, this.minStock, this.cooldownSeconds])
      input.disabled = this.locked;
    for (const [itemId, row] of this.rows) {
      const index = this.itemIds.indexOf(itemId);
      row.root.hidden = (this.stock?.get(itemId) ?? 0) === 0;
      row.choice.checked = any || index >= 0;
      row.choice.disabled = this.locked || !selected || row.root.hidden;
      row.earlier.hidden = row.later.hidden = !selected || index < 0;
      row.earlier.disabled = this.locked || !selected || index <= 0;
      row.later.disabled =
        this.locked || !selected || index < 0 || index === this.itemIds.length - 1;
      setText(
        row.position,
        !row.root.hidden && (any || (selected && index >= 0))
          ? `${visibleOrder.indexOf(itemId) + 1}.`
          : '',
      );
    }
    this.syncGuidance();
  }

  private syncGuidance(): void {
    const name = this.resource.toUpperCase();
    setText(
      this.guide,
      this.mode.value === 'off'
        ? `Automatic ${name} items are off. Your choices are retained.`
        : this.mode.value === 'selected' && this.itemIds.length === 0
          ? `Choose at least one carried ${name} recovery item before saving or starting the bot.`
          : 'Earlier available items are used first. Each keeps the configured reserve, and all share one cooldown. Your choices are retained when you switch modes.',
    );
    const { carried, missing } = recoveryStockSummary({
      ids: this.ids,
      itemIds: this.itemIds,
      stock: this.stock,
    });
    setText(
      this.inventoryMessage,
      this.stock === null
        ? 'Waiting for current inventory.'
        : `${carried ? '' : `No carried ${name} recovery items.`}${missing ? ` ${missing} saved selection${missing === 1 ? ' is' : 's are'} out of stock; choices are kept for restocking.` : ''}`.trim(),
    );
    this.inventoryMessage.hidden = this.inventoryMessage.textContent === '';
    if (this.mode.value === 'off' || this.resource !== 'hp') {
      this.stopWarning.hidden = true;
      setText(this.stopWarning, '');
      return;
    }
    const stop = this.stopLimit(),
      threshold = inputNumber(this.belowPercent);
    const warn = Number.isFinite(stop) && Number.isFinite(threshold) && threshold <= stop;
    this.stopWarning.hidden = !warn;
    setText(
      this.stopWarning,
      warn
        ? `The bot stops at ${stop}% HP before using recovery items. Set “Use below HP %” above ${stop}% to heal before that limit. The stop limit remains unchanged.`
        : '',
    );
  }
}
