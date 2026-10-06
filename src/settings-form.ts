import { formDocument, type FormDocument } from './current-form';
import type { FeatureUi } from './feature-ui';
import { settingsWithFieldMap } from './field-controls';
import type { MapInfo } from './map-data';
import { DEFAULT_AUTOMATION, MAX_TARGETS, validateFormSettings, validateSettings, type Settings } from './settings';
import { MapTargets } from './targets';

type AutomationEditor = Pick<FeatureUi, 'read' | 'write' | 'levelDifference' | 'selectedProfileId' | 'restoreProfileSelection'>;
type FormSnapshot = Omit<FormDocument, 'version' | 'revision'>;
export interface SettingsFormProjection {
  runSettings(): Settings;
  snapshot(): FormSnapshot;
}
export interface SettingsFormContext {
  sessionId: string;
  mapInfo: MapInfo;
  level: number | null;
  runActive: boolean;
  controlsLocked: boolean;
  targetsLocked: boolean;
  retainedTargets?: readonly number[];
}
interface Hooks { context(): SettingsFormContext; changed(): void }
interface TargetRow { label: HTMLLabelElement; input: HTMLInputElement; name: HTMLElement; detail: HTMLElement; count: HTMLElement }

/** The DOM owns edits; configured targets survive unavailable field observations.
 * CurrentForm continues to own revisions, delayed restoration and serialized saves.
 */
export class SettingsForm {
  private readonly targets = new MapTargets();
  private readonly rows = new Map<number, TargetRow>();
  private targetOrder = '';
  private readonly catalog: HTMLDataListElement;

  constructor(private readonly host: HTMLElement, private readonly automation: AutomationEditor, private readonly hooks: Hooks) {
    this.catalog = host.ownerDocument.createElement('datalist');
    this.catalog.id = 'classId-catalog';
    host.append(this.catalog);
    this.element('select-targets').addEventListener('click', () => this.editTargets(() => this.targets.selectEligible()));
    this.element('clear-targets').addEventListener('click', () => this.editTargets(() => this.targets.clear()));
    for (const id of ['radius', 'min-hp']) this.element(id).addEventListener('input', () => this.labels());
  }

  /** Project field settings; command owners still validate before admission. */
  runSettings(): Settings {
    return settingsWithFieldMap(this.read(this.targets.map, this.targets.ids));
  }

  snapshot(): FormSnapshot {
    return this.checkedSnapshot({ settings: this.retainedSettings(this.read(this.targets.map, this.targets.configuredIds)), selectedProfileId: this.automation.selectedProfileId() });
  }

  /** One synchronous display pass shares a current DOM read and observation
   * refresh. Commands and saves use the fresh standalone methods above.
   * Read lazily so FeatureUi has accepted the status before locks are projected.
   */
  project(): SettingsFormProjection {
    let current: { field: Settings; retained: FormSnapshot } | undefined;
    let read = false, error: unknown;
    const value = () => {
      if (!read) {
        read = true;
        try {
          this.refresh();
          const field = this.read(this.targets.map, this.targets.ids);
          current = { field: settingsWithFieldMap(field), retained: { settings: this.retainedSettings(field), selectedProfileId: this.automation.selectedProfileId() } };
        } catch (failure) { error = failure; }
      }
      if (!current) throw error;
      return current;
    };
    return { runSettings: () => value().field, snapshot: () => this.checkedSnapshot(value().retained) };
  }

  private retainedSettings(value: Settings): Settings {
    return { ...value, targets: this.targets.configuredIds, map: value.automation?.mapPolicy?.lockArea?.map ?? (this.targets.configuredMap || value.map) };
  }

  private checkedSnapshot(value: FormSnapshot): FormSnapshot {
    const document = formDocument({ version: 1, revision: 0, ...value });
    return { settings: document.settings, selectedProfileId: document.selectedProfileId };
  }

  restore(document: FormDocument): void {
    const checked = formDocument(document);
    this.write(checked.settings);
    this.automation.restoreProfileSelection(checked.selectedProfileId);
    this.targets.setLevelDifference(this.automation.levelDifference());
    this.targets.restore(checked.settings.map, checked.settings.targets);
    this.renderTargets();
  }

  applyProfile(settings: Settings): void {
    const checked = validateSettings(settings);
    const context = this.hooks.context();
    if (context.runActive || checked.map !== this.targets.map) throw new Error('Stop automation and enter the profile map before applying it.');
    this.write(checked);
    this.targets.setLevelDifference(this.automation.levelDifference());
    this.targets.clear();
    for (const id of checked.targets) this.targets.select(id, true);
    this.renderTargets();
    this.hooks.changed();
  }

  /** Apply the complete retained configuration, including choices made offline.
   * Validate before touching DOM controls or the selected profile.
   */
  applySettings(settings: Settings): void {
    const checked = validateFormSettings(settings);
    const context = this.hooks.context();
    if (context.runActive || context.controlsLocked) throw new Error('Stop automation and wait for the current request before applying Setup.');
    this.write(checked);
    this.automation.restoreProfileSelection(null);
    this.targets.setLevelDifference(this.automation.levelDifference());
    this.targets.restore(checked.map, checked.targets);
    this.renderTargets();
    this.hooks.changed();
  }

  /** Observation/locking refreshes do not notify a user edit or start a run. */
  refresh(): void {
    const context = this.hooks.context();
    this.targets.setLevelDifference(this.automation.levelDifference());
    this.targets.update(context.sessionId, context.mapInfo, context.level);
    for (const id of context.retainedTargets ?? []) this.targets.select(id, true);
    this.labels();
    this.renderTargets();
    for (const id of ['radius', 'min-hp', 'loot', 'random-walk', 'route-step', 'route-time', 'attack-distance', 'attack-time', 'avoid-walls']) {
      this.element<HTMLInputElement>(id).disabled = context.controlsLocked;
    }
  }

  private element<T extends HTMLElement = HTMLElement>(id: string): T {
    const element = this.host.querySelector<T>(`#${id}`);
    if (!element) throw new Error(`Missing settings form control: ${id}.`);
    return element;
  }

  private read(map: string, targets: number[]): Settings {
    return {
      map, targets,
      radius: Number(this.element<HTMLInputElement>('radius').value),
      minHpPercent: Number(this.element<HTMLInputElement>('min-hp').value),
      loot: this.element<HTMLInputElement>('loot').checked,
      route_randomWalk: Number(this.element<HTMLSelectElement>('random-walk').value) as 0 | 2,
      route_step: Number(this.element<HTMLInputElement>('route-step').value),
      route_avoidWalls: this.element<HTMLInputElement>('avoid-walls').checked,
      route_randomWalk_maxRouteTime: Number(this.element<HTMLInputElement>('route-time').value),
      attackRouteMaxPathDistance: Number(this.element<HTMLInputElement>('attack-distance').value),
      attackMaxRouteTime: Number(this.element<HTMLInputElement>('attack-time').value),
      automation: this.automation.read(),
    };
  }

  private write(value: Settings): void {
    this.automation.write(value.automation ?? structuredClone(DEFAULT_AUTOMATION));
    const inputs: Record<string, number> = {
      radius: value.radius, 'min-hp': value.minHpPercent, 'route-step': value.route_step,
      'route-time': value.route_randomWalk_maxRouteTime, 'attack-distance': value.attackRouteMaxPathDistance, 'attack-time': value.attackMaxRouteTime,
    };
    for (const [id, value] of Object.entries(inputs)) this.element<HTMLInputElement>(id).value = String(value);
    this.element<HTMLSelectElement>('random-walk').value = String(value.route_randomWalk);
    this.element<HTMLInputElement>('avoid-walls').checked = value.route_avoidWalls;
    this.element<HTMLInputElement>('loot').checked = value.loot;
    this.labels();
  }

  private labels(): void {
    this.element('radius-value').textContent = `${this.element<HTMLInputElement>('radius').value} cells`;
    this.element('hp-value').textContent = `${this.element<HTMLInputElement>('min-hp').value}%`;
  }

  private editTargets(edit: () => void): void {
    if (this.hooks.context().targetsLocked) return;
    edit();
    this.renderTargets();
    this.hooks.changed();
  }

  private renderTargets(): void {
    const { mapInfo, level, targetsLocked } = this.hooks.context();
    const options = this.targets.options;
    const order = options.map(monster => monster.classId).join(',');
    const ids = new Set(options.map(monster => monster.classId));
    for (const id of this.rows.keys()) if (!ids.has(id)) this.rows.delete(id);
    for (const monster of options) {
      let row = this.rows.get(monster.classId);
      if (!row) {
        const label = this.host.ownerDocument.createElement('label'); label.className = 'target-option';
        const input = this.host.ownerDocument.createElement('input'); input.type = 'checkbox';
        const description = this.host.ownerDocument.createElement('span'); description.className = 'target-description';
        const name = this.host.ownerDocument.createElement('strong'), detail = this.host.ownerDocument.createElement('small');
        const count = this.host.ownerDocument.createElement('span'); count.className = 'target-visible';
        description.append(name, detail); label.append(input, description, count);
        // Commit before input bubbles to Main, whose refresh projects this selection.
        input.addEventListener('input', () => this.editTargets(() => this.targets.select(monster.classId, input.checked)));
        row = { label, input, name, detail, count }; this.rows.set(monster.classId, row);
      }
      row.input.checked = this.targets.checked(monster.classId);
      row.input.disabled = targetsLocked || !this.targets.eligible(monster.classId) || (!row.input.checked && this.targets.ids.length >= MAX_TARGETS);
      row.input.setAttribute('aria-label', `Attack ${monster.name}`);
      row.name.textContent = monster.name; row.name.title = `Monster class ID ${monster.classId}`;
      const population = monster.spawnCount === null ? 'Seen on this map' : `${monster.spawnCount} map spawns`;
      const levelLimit = level !== null && !this.targets.eligible(monster.classId) ? ' · Above level limit' : '';
      row.detail.textContent = `Lv ${monster.level} · #${monster.classId} · HP ${monster.maxHp} · ${population}${levelLimit}`;
      row.count.textContent = `${monster.visibleCount} in view`;
      row.count.classList.toggle('present', monster.visibleCount > 0); row.label.classList.toggle('selected', row.input.checked);
    }
    // Telemetry must not replace a focused checkbox while the roster is unchanged.
    if (order !== this.targetOrder || !options.length) {
      this.targetOrder = order;
      if (options.length) this.element('targets').replaceChildren(...options.map(monster => this.rows.get(monster.classId)!.label));
      else {
        const empty = this.host.ownerDocument.createElement('p'); empty.className = 'target-empty';
        empty.textContent = this.targets.map ? 'No monsters listed yet. Monsters seen in the game will appear here.' : 'Map monsters will appear after you enter the field.';
        this.element('targets').replaceChildren(empty);
      }
    }
    this.element('target-count').textContent = `${this.targets.ids.length} selected`;
    this.element<HTMLButtonElement>('select-targets').disabled = targetsLocked || !options.some(monster => this.targets.eligible(monster.classId));
    this.element<HTMLButtonElement>('clear-targets').disabled = targetsLocked || !options.some(monster => this.targets.checked(monster.classId));
    if (this.catalog.dataset.order !== order) {
      this.catalog.dataset.order = order;
      this.catalog.replaceChildren(...options.map(monster => {
        const option = this.host.ownerDocument.createElement('option'); option.value = String(monster.classId); option.label = monster.name; return option;
      }));
    }
    this.element('target-map').textContent = mapInfo.code ? `${mapInfo.name} · ${mapInfo.code}` : 'Enter a map to choose monsters';
    const difference = this.automation.levelDifference(), limit = `${difference >= 0 ? '+' : ''}${difference}`;
    this.element('target-source').textContent = mapInfo.source === 'database'
      ? `Game map database · Map spawns are configured counts; in view is live. Level limit: yours ${limit}.`
      : mapInfo.source === 'loading' ? 'Loading map database… Monsters already in view can be selected.'
      : `Using monsters seen on this map; the map database is unavailable here. Level limit: yours ${limit}.`;
  }
}
