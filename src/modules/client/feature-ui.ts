import { map } from 'effect/Array';
import { isTalkNpc } from '../world/actor-interaction-logic';
import { signedExperience } from '../session/run-experience-logic';
import { browserTextStorage } from '../../shared/storage-effects';
import {
  actorInput,
  chooseFollowMode,
  checkedAction,
  isAction,
  featureServiceBlocked,
  featureActive,
  featureObservation,
  featureServiceChoices,
  featureServiceEvidence,
  featureWorkflowPreviewText,
  featureRoutinePreviewText,
  featureAttackStrategiesText,
  featureRuleConditionsText,
  featureNpcChoices,
  featureVendorChoices,
  featureVendingText,
  featureInventoryText,
  featureSkillsText,
} from './feature-ui-logic';
import { validWarpSnapshot } from '../warp/warp-ui-logic';
import { macroActive } from '../automation/macro-ui-logic';
export { actorInput, chooseFollowMode, validFeatureStatus } from './feature-ui-logic';
import { dashboardTaskLabel } from './client-dashboard';
import type { ClientShell } from './client-shell';
import { RefineUi } from '../refine/refine-ui';
import {
  DEFAULT_MAP_POLICY,
  insideLockArea,
  mapPolicy,
  policySummary,
  validateMapPolicy,
} from '../navigation/map-policy';
import { ManualTargetUi } from '../combat/manual-target-ui';
import { routeBetweenMapsAsync } from '../navigation/travel';
import { SocketUi } from '../socket/socket-ui';
import { ActorPredicateEditor, actorSnapshotAt } from '../world/actor-predicate-ui';
import { SocialUi } from '../social/social-ui';
import { MemoUi } from '../memo/memo-ui';
import { WarpUi } from '../warp/warp-ui';
import { type ActorObservationSnapshot } from '../world/actor-observations';
import {
  DEFAULT_AUTOMATION,
  DEFAULT_RETREAT,
  DEFAULT_PARTY_HEAL,
  validateAutomation,
  automationDraft,
  type AutomationSettings,
  type AutomationSettingsInput,
  type ValidatedAutomationSettings,
  type SettingsInput,
} from '../settings/settings';
import { MAX_PROFILES, ProfileStore } from '../settings/profiles';
import { ITEM_CATALOG, SKILL_CATALOG, itemName } from '../catalog/game-catalog';
import { validateWorkflowSpec } from '../services/workflows';
import { NpcServiceStore } from '../services/npc-service-store';
import {
  BUILTIN_SERVICES,
  previewServiceAsync,
  validateServiceRequest,
} from '../services/npc-services';
import type { Entity } from '../protocol/protocol';
import {
  dryRunRoutine,
  validateRoutineSpec,
  type RoutineObservation,
} from '../automation/routines';
import { MacroUi } from '../automation/macro-ui';
import type { BotScriptDocument } from '../settings/bot-script';
import { DEFAULT_SUPPLY } from '../services/supply-trip';
import { previewSupplyTrip } from '../services/supply-plan';
import {
  DEFAULT_DISPOSITION,
  dispositionPreviewIsCurrent,
  planDisposition,
  type DispositionPlan,
} from '../services/disposition';
import {
  dispositionContextFromStatus,
  dispositionPreviewText,
  dispositionStockFloors,
} from '../services/disposition-ui';
import { RecoveryItemUi } from '../recovery/recovery-item-ui';
import { DEFAULT_HP_POTIONS } from '../recovery/hp-potions';
import { DEFAULT_SP_ITEMS } from '../recovery/recovery-items';

type FeatureUiMounts = Pick<ClientShell, 'sections' | 'manualTools' | 'sessionDetails'>;
type Section = 'combat' | 'recovery' | 'travel' | 'inventory' | 'workflows' | 'profiles';
interface Hooks {
  settings(): SettingsInput;
  apply(settings: SettingsInput): void;
  map(): string;
  character(): string;
  macroSettings?(): SettingsInput;
  applySetup?(settings: SettingsInput): void;
  setupChanged?(): void;
  definitionsChanged?(): void;
  command(action: Record<string, unknown>): Promise<unknown>;
  workflow(spec: unknown): Promise<unknown>;
  routine(spec: unknown): Promise<unknown>;
  macro?(spec: unknown): Promise<unknown>;
  service(spec: unknown): Promise<unknown>;
  social(spec: unknown): Promise<unknown>;
  memo(spec: unknown): Promise<unknown>;
  socketPreview?(spec: unknown): Promise<unknown>;
  socket?(spec: unknown): Promise<unknown>;
  warp?(spec: unknown): Promise<unknown>;
  warpPreview?(spec: unknown): Promise<unknown>;
  warpCancel?(): Promise<unknown>;
  refinePreview?(spec: unknown): Promise<unknown>;
  refine?(spec: unknown): Promise<unknown>;
  refineAdvance?(promptToken: string): Promise<unknown>;
  notify(text: string, error?: boolean): void;
  changed(): void;
  stop?(): void;
}
type Field = {
  path: string;
  label: string;
  kind?: 'text' | 'checkbox';
  min?: number;
  max?: number;
  options?: Array<[string, string]>;
};
type Column = {
  key: string;
  label: string;
  kind?: 'text' | 'ids';
  min?: number;
  max?: number;
  options?: Array<[string, string]>;
};
type Row = Record<string, unknown>;
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const number = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
const serviceChoices = featureServiceChoices(BUILTIN_SERVICES);
const fields: Record<Section, Field[]> = {
  combat: [
    {
      path: 'combat.mode',
      label: 'Attack monsters',
      options: [
        ['selected', 'Only selected monsters'],
        ['retaliate', 'Only monsters attacking me'],
        ['both', 'Selected monsters + monsters attacking me'],
        ['off', 'Combat off'],
      ],
    },
    {
      path: 'combat.partyEngagement',
      label: 'Join monsters engaged by verified visible party members',
      kind: 'checkbox',
    },
    { path: 'combat.levelDifference', label: 'Maximum levels above you', min: -100, max: 100 },
    {
      path: 'retreat.enabled',
      label: 'Retreat during verified ranged normal attacks',
      kind: 'checkbox',
    },
    { path: 'retreat.triggerDistance', label: 'Retreat at or below distance', min: 1, max: 13 },
    { path: 'retreat.desiredDistance', label: 'Desired firing distance', min: 2, max: 14 },
    { path: 'retreat.maxPathSteps', label: 'Maximum steps per retreat', min: 1, max: 20 },
    {
      path: 'retreat.maxAttempts',
      label: 'Retreat attempts per monster lifetime',
      min: 1,
      max: 10,
    },
    {
      path: 'loot.ownership',
      label: 'Pickup scope',
      options: [
        ['own', 'Only drops from your kills'],
        ['all', 'Loot all nearby drops'],
      ],
    },
  ],
  recovery: [
    {
      path: 'partyHeal.enabled',
      label: 'Stationary party Heal (off by default)',
      kind: 'checkbox',
    },
    { path: 'partyHeal.level', label: 'Heal level · learned or granted', min: 1, max: 10 },
    { path: 'partyHeal.hpBelowPercent', label: 'Party HP at or below %', min: 1, max: 100 },
    { path: 'partyHeal.spReserve', label: 'Own SP to keep after Heal', min: 0, max: 2147483647 },
    { path: 'partyHeal.cooldownSeconds', label: 'Party Heal cooldown seconds', min: 1, max: 3600 },
    {
      path: 'partyHeal.maxAttempts',
      label: 'Maximum party Heal attempts per run',
      min: 1,
      max: 100,
    },
    { path: 'recovery.enabled', label: 'Sit to recover HP and SP', kind: 'checkbox' },
    { path: 'recovery.hpStart', label: 'Rest below HP %', min: 1, max: 95 },
    { path: 'recovery.hpEnd', label: 'Resume above HP %', min: 2, max: 100 },
    { path: 'recovery.spStart', label: 'Rest below SP %', min: 0, max: 95 },
    { path: 'recovery.spEnd', label: 'Resume above SP %', min: 1, max: 100 },
    { path: 'recovery.timeoutSeconds', label: 'Maximum rest seconds', min: 1, max: 3600 },
    { path: 'escape.enabled', label: 'Enable emergency escape', kind: 'checkbox' },
    { path: 'escape.hpEnabled', label: 'Escape on low HP', kind: 'checkbox' },
    {
      path: 'escape.threatEnabled',
      label: 'Escape on recently observed monster attackers',
      kind: 'checkbox',
    },
    { path: 'escape.threatCount', label: 'Distinct observed attackers', min: 1, max: 64 },
    { path: 'escape.threatWindowSeconds', label: 'Recent attack window, seconds', min: 1, max: 60 },
    { path: 'escape.hpBelowPercent', label: 'Escape at or below HP %', min: 1, max: 95 },
    {
      path: 'escape.mode',
      label: 'Escape destination',
      options: [
        ['random', 'Random location on current map'],
        ['save', 'Return to save point'],
      ],
    },
    {
      path: 'escape.method',
      label: 'Escape action',
      options: [
        ['item', 'Fly Wing / Butterfly Wing'],
        ['skill', 'Teleport / Return skill'],
      ],
    },
    { path: 'escape.minStock', label: 'Wings to keep in reserve', min: 0, max: 9999 },
    {
      path: 'escape.cooldownSeconds',
      label: 'Minimum escape interval, seconds',
      min: 1,
      max: 3600,
    },
    { path: 'respawn.enabled', label: 'Auto respawn at the save point', kind: 'checkbox' },
    { path: 'respawn.maxDeaths', label: 'Maximum deaths before waiting', min: 1, max: 100 },
    {
      path: 'travel.returnToLockMap',
      label: 'Return to the captured farming map after revival or escape',
      kind: 'checkbox',
    },
  ],
  travel: [
    {
      path: 'mapPolicy.mode',
      label: 'Portal routing',
      options: [
        ['legacy', 'Fewest crossings (legacy)'],
        ['weighted', 'Weighted walking + map penalties'],
      ],
    },
    { path: 'supply.enabled', label: 'Enable bounded supply trips', kind: 'checkbox' },
    {
      path: 'supply.stockEnabled',
      label: 'Trigger below protected stock minimum',
      kind: 'checkbox',
    },
    { path: 'supply.weightEnabled', label: 'Trigger at carried weight', kind: 'checkbox' },
    { path: 'supply.weightStartPercent', label: 'Supply above weight %', min: 1, max: 100 },
    { path: 'supply.weightEndPercent', label: 'Return below weight %', min: 1, max: 99 },
    {
      path: 'supply.minimumIntervalSeconds',
      label: 'Minimum seconds between trips',
      min: 1,
      max: 86400,
    },
    { path: 'supply.maxTrips', label: 'Maximum supply trips', min: 1, max: 100 },
    { path: 'supply.maxActions', label: 'Commands per trip', min: 1, max: 100 },
    { path: 'supply.maxDurationSeconds', label: 'Trip deadline, seconds', min: 30, max: 3600 },
    {
      path: 'supply.maxSpend',
      label: 'Whole-trip reserved spending, zeny',
      min: 0,
      max: 2000000000,
    },
    ...map(['storage', 'buy', 'sell'] as const, (kind) => ({
      path: `supply.${kind}Service`,
      label: `Supply ${kind} service`,
      options: [['', 'Select a verified service'], ...serviceChoices(kind)] as Array<
        [string, string]
      >,
    })),
    { path: 'travel.destinationMap', label: 'Destination map code', kind: 'text' },
    { path: 'travel.loop', label: 'Repeat waypoint route', kind: 'checkbox' },
    {
      path: 'follow.mode',
      label: 'Follow selection',
      options: [
        ['name', 'Player name'],
        ['partyLeader', 'Current party leader'],
      ],
    },
    {
      path: 'follow.rendezvous',
      label: 'Allow one bounded trip to the leader map per Start',
      kind: 'checkbox',
    },
    { path: 'follow.name', label: 'Follow player name', kind: 'text' },
    { path: 'follow.distance', label: 'Follow distance, cells', min: 1, max: 20 },
    { path: 'follow.lostSeconds', label: 'Wait when player lost, seconds', min: 1, max: 120 },
  ],
  inventory: [
    {
      path: 'loadout.enabled',
      label: 'Own conditional loadouts and restore them',
      kind: 'checkbox',
    },
    {
      path: 'loadout.autoAmmo',
      label: 'Select compatible arrows for bow combat',
      kind: 'checkbox',
    },
    { path: 'loadout.minAmmoStock', label: 'Minimum observed ammo reserve', min: 0, max: 9999 },
    {
      path: 'loadout.restore',
      label: 'Restore prior equipment',
      options: [
        ['conditionEnd', 'When the condition ends'],
        ['never', 'Keep the new loadout'],
      ],
    },
    { path: 'loadout.cooldownSeconds', label: 'Equipment cooldown, seconds', min: 1, max: 3600 },
    {
      path: 'loot.defaultAction',
      label: 'Unlisted item rule',
      options: [
        ['pickup', 'Pick up'],
        ['ignore', 'Ignore'],
      ],
    },
  ],
  workflows: [
    { path: 'limits.minutes', label: 'Session minutes · 0 unlimited', min: 0, max: 1440 },
    { path: 'limits.kills', label: 'Kills · 0 unlimited', min: 0, max: 1000000 },
    { path: 'limits.pickups', label: 'Pickups · 0 unlimited', min: 0, max: 1000000 },
    { path: 'limits.weightPercent', label: 'Wait at weight % · 0 off', min: 0, max: 100 },
    { path: 'schedule.enabled', label: 'Restrict running hours', kind: 'checkbox' },
    { path: 'schedule.startHour', label: 'Start hour · local time', min: 0, max: 23 },
    { path: 'schedule.endHour', label: 'End hour · local time', min: 0, max: 23 },
  ],
  profiles: [],
};
const basicFields = new Set([
  'combat.mode',
  'combat.levelDifference',
  'loot.ownership',
  'recovery.enabled',
  'recovery.hpStart',
  'recovery.hpEnd',
  'recovery.spStart',
  'recovery.spEnd',
  'recovery.timeoutSeconds',
  'travel.destinationMap',
  'loot.defaultAction',
  'limits.minutes',
  'limits.kills',
  'limits.pickups',
  'limits.weightPercent',
]);
function fieldElement(field: Field): HTMLLabelElement {
  const label = document.createElement('label');
  label.className = field.kind === 'checkbox' ? 'toggle-row' : 'form-field';
  const title = document.createElement('span');
  title.textContent = field.label;
  label.append(title);
  let input: HTMLInputElement | HTMLSelectElement;
  if (field.options) {
    input = document.createElement('select');
    for (const [value, title] of field.options) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = title;
      input.append(option);
    }
  } else {
    input = document.createElement('input');
    input.type = field.kind ?? 'number';
    if (field.min !== undefined) input.min = String(field.min);
    if (field.max !== undefined) input.max = String(field.max);
    if (field.kind === 'text') input.maxLength = field.path === 'follow.name' ? 48 : 64;
  }
  input.dataset.setting = field.path;
  label.append(input);
  return label;
}
function getPath(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((v, key) => object(v)[key], value);
}
function setPath(value: Record<string, unknown>, path: string, input: unknown): void {
  const keys = path.split('.');
  const key = keys.pop()!;
  const owner = keys.reduce((v, name) => object(v[name]), value);
  owner[key] = input;
}
class RuleEditor {
  readonly root = document.createElement('details');
  private readonly rows = document.createElement('div');
  private readonly add = document.createElement('button');
  private locked = false;
  private readonly conditions = new Map<Element, ActorPredicateEditor>();
  constructor(
    title: string,
    private readonly columns: Column[],
    private readonly initial: Row,
    private readonly maximum: number,
    private readonly changed: () => void,
    private readonly observations?: () => ActorObservationSnapshot | undefined,
    private readonly allowCandidate = false,
  ) {
    this.root.className = 'rule-editor';
    const summary = document.createElement('summary');
    summary.textContent = title;
    this.root.append(summary, this.rows);
    this.add.type = 'button';
    this.add.className = 'secondary compact';
    this.add.textContent = '＋ Add rule';
    this.add.addEventListener('click', () => {
      const rows = this.read();
      if (rows.length < maximum)
        this.write([
          ...rows,
          { ...initial, ...(typeof initial.id === 'string' ? { id: crypto.randomUUID() } : {}) },
        ]);
      changed();
    });
    this.root.addEventListener('input', changed);
    this.root.append(this.add);
    this.write([]);
  }
  read(): Row[] {
    return [...this.rows.children].map((row) => {
      const result: Row = Object.fromEntries(
        this.columns.map((column) => {
          const input = row.querySelector<HTMLInputElement | HTMLSelectElement>(
            `[data-column="${column.key}"]`,
          )!;
          return [
            column.key,
            column.kind === 'ids'
              ? input.value.split(',').map((id) => Number(id.trim()))
              : column.kind === 'text' || column.options
                ? input.value
                : Number(input.value),
          ];
        }),
      );
      const conditions = this.conditions.get(row)?.read();
      if (conditions !== undefined) result.conditions = conditions;
      return result;
    });
  }
  write(values: Row[]): void {
    this.rows.replaceChildren();
    this.conditions.clear();
    for (const value of values) {
      const row = document.createElement('div');
      row.className = 'rule-row';
      for (const column of this.columns) {
        const label = fieldElement({
          path: column.key,
          label: column.label,
          kind: column.kind === 'ids' ? 'text' : column.kind,
          min: column.min,
          max: column.max,
          options: column.options,
        });
        const input = label.querySelector<HTMLInputElement | HTMLSelectElement>('input,select')!;
        delete input.dataset.setting;
        input.dataset.column = column.key;
        input.value = String(value[column.key] ?? this.initial[column.key] ?? '');
        if (column.key === 'id' && input instanceof HTMLInputElement) input.maxLength = 48;
        if (column.kind === 'ids' && input instanceof HTMLInputElement) {
          input.maxLength = 704;
          input.value = Array.isArray(value[column.key])
            ? (value[column.key] as number[]).join(', ')
            : input.value;
        }
        if (
          input instanceof HTMLInputElement &&
          ['itemId', 'skillId', 'classId'].includes(column.key)
        )
          input.setAttribute('list', `${column.key}-catalog`);
        row.append(label);
      }
      if (this.observations) {
        const editor = new ActorPredicateEditor(
          this.observations,
          this.changed,
          this.allowCandidate,
        );
        editor.write(
          value.conditions as import('../world/actor-observations').ActorPredicate[] | undefined,
        );
        this.conditions.set(row, editor);
        row.append(editor.root);
      }
      if (typeof this.initial.id === 'string')
        for (const direction of [-1, 1]) {
          const move = document.createElement('button');
          move.type = 'button';
          move.className = 'secondary compact';
          move.textContent = direction < 0 ? 'Move earlier' : 'Move later';
          move.addEventListener('click', () => {
            const sibling = direction < 0 ? row.previousElementSibling : row.nextElementSibling;
            if (sibling) {
              if (direction < 0) this.rows.insertBefore(row, sibling);
              else this.rows.insertBefore(sibling, row);
              this.root.dispatchEvent(new Event('input', { bubbles: true }));
            }
          });
          row.append(move);
        }
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'text-button rule-remove';
      remove.textContent = 'Remove';
      remove.addEventListener('click', () => {
        this.conditions.delete(row);
        row.remove();
        this.add.disabled = this.locked || this.rows.childElementCount >= this.maximum;
        this.root.dispatchEvent(new Event('input', { bubbles: true }));
      });
      row.append(remove);
      this.rows.append(row);
    }
    this.lock(this.locked);
  }
  lock(locked: boolean): void {
    this.locked = locked;
    for (const input of this.root.querySelectorAll<
      HTMLInputElement | HTMLSelectElement | HTMLButtonElement
    >('input,select,button'))
      input.disabled = locked;
    this.add.disabled = locked || this.rows.childElementCount >= this.maximum;
  }
}
const idColumn = (key: string, label: string, max = 2147483647): Column => ({
  key,
  label,
  min: 1,
  max,
});
const priority: Column = { key: 'priority', label: 'Priority', min: -100, max: 100 };
const countColumn: Column = { key: 'count', label: 'Quantity', min: 1, max: 9999 };

export class FeatureUi {
  private readonly settingInputs = new Map<string, HTMLInputElement | HTMLSelectElement>();
  private readonly manualTargets: ManualTargetUi;
  private readonly panels = new Map<Section, HTMLElement>();
  private readonly editors = new Map<string, RuleEditor>();
  private readonly profiles: ProfileStore;
  private readonly services: NpcServiceStore;
  private locked = false;
  private manualLocked = true;
  private serviceLocked = true;
  private status: Record<string, unknown> = {};
  private dispositionEditor!: RuleEditor;
  private dispositionPlan: DispositionPlan | null = null;
  private attackStrategiesPresent = false;
  private partyHealPresent = false;
  private retreatPresent = false;
  private hpPotionsPresent = false;
  private readonly hpPotions: RecoveryItemUi;
  private spPotionsPresent = false;
  private readonly spPotions: RecoveryItemUi;
  private readonly recoveryResource = document.createElement('select');
  private macroUi!: MacroUi;
  private refreshProfiles: (selected?: string) => void = () => {};
  private refreshServices: (selected?: string) => void = () => {};
  private displaySettings: (() => SettingsInput) | undefined;
  /** Display and lock consumers share a synchronous SettingsForm projection.
   * Action callbacks outside this scope always read current DOM settings.
   */
  withSettings<T>(settings: () => SettingsInput, render: () => T): T {
    const previous = this.displaySettings;
    this.displaySettings = settings;
    try {
      return render();
    } finally {
      this.displaySettings = previous;
    }
  }
  private automationSettings(): AutomationSettingsInput {
    return this.displaySettings?.().automation ?? this.read();
  }
  private routePreview: {
    abort: AbortController;
    identity: string;
    settings: string;
    output: HTMLElement;
    current?: () => string;
    evidence?: string;
  } | null = null;
  private previewIdentity(): string {
    const p = object(this.status.player),
      observations = object(this.status.actorObservations);
    const actors = Array.isArray(observations.actors) ? observations.actors.map(object) : [];
    return JSON.stringify([
      this.hooks.map(),
      this.status.sessionId,
      this.status.connectionId,
      object(this.status.world).generation,
      this.status.connected,
      this.status.compatible,
      observations.world,
      actors.find((actor) => actor.id === p.id)?.incarnation,
      p.id,
      p.dead,
      typeof p.x === 'number' ? Math.floor(p.x) : null,
      typeof p.y === 'number' ? Math.floor(p.y) : null,
      this.hooks.settings().route_avoidWalls,
    ]);
  }
  private servicePreviewEvidence(): string {
    return featureServiceEvidence(this.status);
  }
  private cancelRoutePreview(
    reason = 'Preview cancelled. Generate a new preview from current state.',
  ): void {
    const request = this.routePreview;
    if (!request) return;
    this.routePreview = null;
    request.abort.abort();
    request.output.textContent = reason;
  }
  private async previewRoute(
    output: HTMLElement,
    calculate: (signal: AbortSignal) => Promise<string>,
    current?: () => string,
  ): Promise<void> {
    this.cancelRoutePreview();
    const request = {
      abort: new AbortController(),
      identity: this.previewIdentity(),
      settings: JSON.stringify(this.read()),
      output,
      current,
      evidence: current?.(),
    };
    this.routePreview = request;
    output.textContent = 'Planning verified route… Preview sends no commands.';
    try {
      const result = await calculate(request.abort.signal);
      if (this.routePreview !== request) return;
      if (
        request.identity !== this.previewIdentity() ||
        request.settings !== JSON.stringify(this.read()) ||
        request.evidence !== request.current?.()
      ) {
        this.cancelRoutePreview();
        return;
      }
      this.routePreview = null;
      output.textContent = result;
    } catch (error) {
      if (this.routePreview !== request) return;
      this.routePreview = null;
      output.textContent = error instanceof Error ? error.message : 'Route preview failed.';
    }
  }
  private readonly social: SocialUi;
  private readonly memo: MemoUi;
  private readonly socket: SocketUi;
  private readonly refine: RefineUi;
  private readonly warp: WarpUi;
  constructor(
    private readonly host: HTMLElement,
    private readonly hooks: Hooks,
    private readonly mounts: FeatureUiMounts,
  ) {
    let storage: Pick<Storage, 'getItem' | 'setItem'>;
    try {
      storage = browserTextStorage();
    } catch {
      storage = {
        getItem: () => null,
        setItem: () => {
          throw new Error('Profile storage is unavailable.');
        },
      };
    }
    this.profiles = new ProfileStore(storage);
    this.services = new NpcServiceStore(storage);
    for (const [section, panel] of Object.entries(mounts.sections) as Array<[Section, HTMLElement]>)
      this.panels.set(section, panel);
    this.hpPotions = new RecoveryItemUi(
      () => this.hooks.changed(),
      () => {
        // FeatureUi mounts before SettingsForm exists. Read this independent
        // control so an invalid draft elsewhere cannot interrupt status rendering.
        const input = this.host.querySelector<HTMLInputElement>('#min-hp');
        return input ? Number(input.value) : this.hooks.settings().minHpPercent;
      },
    );
    this.spPotions = new RecoveryItemUi(
      () => this.hooks.changed(),
      () => 0,
      'sp',
    );
    const resourceLabel = document.createElement('label');
    resourceLabel.className = 'form-field';
    const resourceTitle = document.createElement('span');
    resourceTitle.textContent = 'Recovery item resource';
    this.recoveryResource.id = 'recovery-item-resource';
    for (const [value, name] of [
      ['hp', 'HP'],
      ['sp', 'SP'],
    ] as const) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = name;
      this.recoveryResource.append(option);
    }
    this.recoveryResource.value = 'hp';
    this.spPotions.root.hidden = true;
    this.recoveryResource.addEventListener('change', () => {
      this.hpPotions.root.hidden = this.recoveryResource.value !== 'hp';
      this.spPotions.root.hidden = this.recoveryResource.value !== 'sp';
    });
    resourceLabel.append(resourceTitle, this.recoveryResource);
    const recovery = this.panels.get('recovery')!;
    (recovery.querySelector<HTMLElement>('.setup-potions') ?? recovery).append(
      resourceLabel,
      this.hpPotions.root,
      this.spPotions.root,
    );
    const combat = this.panel('combat');
    for (const [section, definitions] of Object.entries(fields) as Array<[Section, Field[]]>) {
      const grid = document.createElement('div');
      grid.className = 'form-grid';
      const basics = this.panels.get(section)!.querySelector<HTMLElement>('.setup-basic-fields');
      for (const field of definitions)
        (basicFields.has(field.path) && basics ? basics : grid).append(fieldElement(field));
      if (grid.children.length) this.panel(section).append(grid);
    }
    const travel = this.panel('travel');
    const followProgress = document.createElement('p');
    followProgress.id = 'party-follow-state';
    followProgress.className = 'hint';
    travel.append(followProgress);
    this.host
      .querySelector<HTMLSelectElement>('[data-setting="follow.mode"]')!
      .addEventListener('change', () => {
        const mode = this.host.querySelector<HTMLSelectElement>('[data-setting="follow.mode"]')!
          .value as 'name' | 'partyLeader';
        const follow = chooseFollowMode(
          {
            name: this.host.querySelector<HTMLInputElement>('[data-setting="follow.name"]')!.value,
            distance: 4,
            lostSeconds: 10,
          },
          mode,
        );
        if (mode === 'partyLeader')
          this.host.querySelector<HTMLInputElement>('[data-setting="follow.name"]')!.value =
            follow.name;
        else
          this.host.querySelector<HTMLInputElement>('[data-setting="follow.rendezvous"]')!.checked =
            false;
        this.syncFollowMode();
        this.hooks.changed();
      });
    this.note(
      'combat',
      'Loot all considers observed drops inside your pickup radius and allowed field area. Item ignore rules still apply. The server decides pickup rights and inventory capacity; sending Pickup is not success.',
    );
    this.rules();
    const retreatState = document.createElement('p');
    retreatState.id = 'retreat-state';
    retreatState.className = 'telemetry-summary';
    retreatState.hidden = true;
    combat.append(retreatState);
    const conditionState = document.createElement('p');
    conditionState.id = 'actor-condition-state';
    conditionState.className = 'telemetry-summary';
    conditionState.hidden = true;
    combat.append(conditionState);
    this.workflows();
    this.setup();
    this.servicePanel();
    this.profilePanel();
    this.manualTargets = new ManualTargetUi(this.hooks);
    this.mounts.manualTools.prepend(this.manualTargets.root);
    this.dispositionPanel();
    this.supplyPanel();
    this.mapPolicyPanel();
    this.social = new SocialUi(
      (action) => this.hooks.social(action),
      (message, error) => this.hooks.notify(message, error),
    );
    this.mounts.manualTools.append(this.social.root);
    this.memo = new MemoUi(
      (request) => this.hooks.memo(request),
      (message, error) => this.hooks.notify(message, error),
    );
    this.mounts.manualTools.append(this.memo.root);
    this.socket = new SocketUi(
      (request) =>
        this.hooks.socketPreview?.(request) ??
        Promise.reject(new Error('Socket preview unavailable.')),
      (request) =>
        this.hooks.socket?.(request) ?? Promise.reject(new Error('Socket action unavailable.')),
      (message, error) => this.hooks.notify(message, error),
      () => this.automationSettings(),
    );
    this.socket.root.classList.add('manual-group');
    this.mounts.manualTools.append(this.socket.root);
    this.host.addEventListener('input', () => {
      this.socket.policyChanged();
      this.refine.policyChanged();
    });
    this.host.addEventListener('change', () => {
      this.socket.policyChanged();
      this.refine.policyChanged();
    });
    this.refine = new RefineUi(
      () => this.automationSettings(),
      (request) =>
        this.hooks.refinePreview?.(request) ??
        Promise.reject(new Error('Refining transport unavailable.')),
      (request) =>
        this.hooks.refine?.(request) ??
        Promise.reject(new Error('Refining transport unavailable.')),
      (promptToken) =>
        this.hooks.refineAdvance?.(promptToken) ??
        Promise.reject(new Error('Refining transport unavailable.')),
      (message, error) => this.hooks.notify(message, error),
    );
    this.mounts.manualTools.append(this.refine.root);
    this.warp = new WarpUi(
      (request) =>
        this.hooks.warp
          ? this.hooks.warp(request)
          : Promise.reject(new Error('Warp request transport unavailable.')),
      (message, error) => this.hooks.notify(message, error),
      (request) =>
        this.hooks.warpPreview?.(request) ?? Promise.reject(new Error('Warp preview unavailable.')),
      () => this.automationSettings(),
      () => this.hooks.warpCancel?.() ?? Promise.reject(new Error('Warp cancel unavailable.')),
    );
    this.mounts.manualTools.append(this.warp.root);
    this.host.addEventListener('input', () => this.warp.policyChanged());
    this.host.addEventListener('change', () => this.warp.policyChanged());
    for (const [id, catalog] of [
      ['itemId', ITEM_CATALOG],
      ['skillId', SKILL_CATALOG],
    ] as const) {
      const list = document.createElement('datalist');
      list.id = `${id}-catalog`;
      for (const [value, entry] of Object.entries(catalog)) {
        const option = document.createElement('option');
        option.value = value;
        option.label = entry.name;
        list.append(option);
      }
      this.host.append(list);
    }
    this.host.addEventListener('change', () => this.cancelRoutePreview());
    this.host.addEventListener('click', (event) => {
      if ((event.target as HTMLElement).closest('#stop, #start')) this.cancelRoutePreview();
    });
    this.host.addEventListener('input', (event) => {
      this.cancelRoutePreview();
      if (
        (event.target as HTMLElement).dataset.setting ||
        (event.target as HTMLElement).id.startsWith('map-policy-')
      )
        this.hooks.changed();
    });
    for (const definitions of Object.values(fields))
      for (const field of definitions) {
        this.settingInputs.set(
          field.path,
          this.host.querySelector<HTMLInputElement | HTMLSelectElement>(
            `[data-setting="${field.path}"]`,
          )!,
        );
      }
    this.settingInputs.set(
      'disposition.maxSpend',
      this.host.querySelector<HTMLInputElement>('[data-setting="disposition.maxSpend"]')!,
    );
    this.write(DEFAULT_AUTOMATION);
  }
  private panel(section: Section): HTMLElement {
    const panel = this.panels.get(section)!;
    return panel.querySelector<HTMLElement>('.setup-advanced') ?? panel;
  }
  private dispositionPanel(): void {
    const panel = this.panel('inventory');
    const binary: Array<[string, string]> = [
      ['0', 'Preserve'],
      ['1', 'Allow'],
    ];
    this.dispositionEditor = new RuleEditor(
      'Protected stock & disposition preview',
      [
        idColumn('itemId', 'Item ID'),
        ...['keep', 'minimum', 'desired', 'maximum'].map((key) => ({
          key,
          label: key[0]!.toUpperCase() + key.slice(1),
          min: 0,
          max: 32767,
        })),
        { key: 'store', label: 'Store excess', options: binary },
        { key: 'cart', label: 'Cart excess', options: binary },
        { key: 'sell', label: 'Sell excess', options: binary },
        {
          key: 'restock',
          label: 'Restock source',
          options: [
            ['off', 'Off'],
            ['storage', 'Storage'],
            ['cart', 'Cart'],
            ['buy', 'Open shop'],
          ],
        },
        {
          key: 'allowUnique',
          label: 'Unique items',
          options: [
            ['0', 'Protect'],
            ['1', 'Allow if fully observed'],
          ],
        },
      ],
      {
        itemId: 501,
        keep: 1,
        minimum: 1,
        desired: 1,
        maximum: 1,
        store: '0',
        cart: '0',
        sell: '0',
        restock: 'off',
        allowUnique: '0',
      },
      128,
      () => {
        this.dispositionPlan = null;
        this.hooks.changed();
        this.dispositionOutput().textContent = 'Rules changed. Generate a new preview.';
      },
    );
    panel.append(this.dispositionEditor.root);
    const grid = document.createElement('div');
    grid.className = 'form-grid';
    const label = fieldElement({
      path: 'disposition.maxSpend',
      label: 'Preview maximum spending · zeny',
      min: 0,
      max: 2000000000,
    });
    label.addEventListener('input', () => {
      this.dispositionPlan = null;
      this.dispositionOutput().textContent = 'Spending changed. Generate a new preview.';
    });
    grid.append(label);
    panel.append(grid);
    this.note(
      'inventory',
      'Keep ≤ minimum ≤ desired ≤ maximum. Below minimum, restock toward desired from the selected source. Above maximum, permitted excess goes to storage, then cart, then sale. Unlisted, equipped, selected ammo, refined and carded items stay protected. Preview sends no commands; rules are saved with profiles.',
    );
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'secondary compact';
    button.textContent = 'Preview item disposition';
    button.addEventListener('click', () => {
      try {
        const settings = this.read();
        const policy = settings.disposition ?? DEFAULT_DISPOSITION;
        this.dispositionPlan = planDisposition(policy, {
          ...dispositionContextFromStatus(this.status),
          minimumStock: dispositionStockFloors(settings),
        });
        this.dispositionOutput().textContent = dispositionPreviewText(this.dispositionPlan);
      } catch (error) {
        this.dispositionPlan = null;
        this.dispositionOutput().textContent =
          error instanceof Error ? error.message : 'Invalid disposition rules.';
      }
    });
    panel.append(button);
    const output = document.createElement('div');
    output.id = 'disposition-preview';
    output.className = 'telemetry-summary';
    output.setAttribute('role', 'status');
    output.textContent = 'No preview generated. No items will be moved or sold.';
    panel.append(output);
  }
  private supplyPanel(): void {
    const panel = this.panel('travel'),
      button = document.createElement('button');
    button.type = 'button';
    button.className = 'secondary compact';
    button.textContent = 'Preview supply trip';
    const output = document.createElement('div');
    output.id = 'supply-preview';
    output.className = 'telemetry-summary';
    output.setAttribute('role', 'status');
    output.textContent =
      'Supply trips are off by default. Choose protected stock rules and verified services.';
    button.addEventListener('click', () => {
      try {
        const a = this.read(),
          disposition = {
            ...dispositionContextFromStatus(this.status),
            minimumStock: dispositionStockFloors(a),
          },
          p = object(this.status.player);
        output.textContent = previewSupplyTrip(
          { ...this.hooks.settings(), automation: a },
          {
            character: text(p.name),
            epoch: text(this.status.sessionId),
            map: text(this.status.map),
            position:
              typeof p.x === 'number' && typeof p.y === 'number'
                ? { x: Math.floor(p.x), y: Math.floor(p.y) }
                : null,
            connected: this.status.connected === true,
            alive: p.dead === false,
            fresh: true,
            settled: disposition.workflow.idle,
            canPrepare: false,
            fieldRequested: false,
            inventoryRevision: 0,
            currencyRevision: 0,
            economicUncertain: false,
            disposition,
          },
        );
      } catch (error) {
        output.textContent = error instanceof Error ? error.message : 'Invalid supply settings.';
      }
    });
    panel.append(button, output);
    this.note(
      'travel',
      'Supply trips use your protected stock rules. Each shop batch opens a fresh verified service. Stop, manual input, death or an uncertain transaction pauses the trip and prevents automatic field resume. The captured return map and cell appear in status.',
    );
  }
  private mapPolicyPanel(): void {
    const panel = this.panel('travel'),
      grid = document.createElement('div');
    grid.className = 'form-grid';
    panel.append(grid);
    for (const [id, label] of [
      ['allow', 'Allowed maps · blank permits all'],
      ['deny', 'Denied maps · takes precedence'],
    ]) {
      const input = this.input(grid, `map-policy-${id}`, label!, 'text', '');
      input.maxLength = 16400;
      input.dataset.config = 'true';
    }
    const toggle = document.createElement('label');
    toggle.className = 'toggle-row';
    toggle.textContent = 'Restrict field movement to an inclusive rectangle';
    const enabled = document.createElement('input');
    enabled.type = 'checkbox';
    enabled.id = 'map-policy-area';
    enabled.dataset.config = 'true';
    toggle.append(enabled);
    panel.append(toggle);
    for (const [key, label] of [
      ['map', 'Rectangle map code'],
      ['minX', 'Minimum X'],
      ['minY', 'Minimum Y'],
      ['maxX', 'Maximum X'],
      ['maxY', 'Maximum Y'],
    ]) {
      const input = this.input(
        grid,
        `map-policy-${key}`,
        label!,
        key === 'map' ? 'text' : 'number',
        key === 'map' ? '' : '0',
        0,
        511,
      );
      input.dataset.config = 'true';
    }
    this.editor(
      'travel',
      'mapPolicy.penalties',
      'Departing-map penalties',
      [
        { key: 'map', label: 'Known map code', kind: 'text' },
        { key: 'cost', label: 'Routing units', min: 0, max: 1000000 },
      ],
      { map: 'prt_fild08', cost: 0 },
      256,
    );
    this.note(
      'travel',
      'Separate map codes with commas or spaces. Deny wins. Cardinal steps cost 10, diagonals 14 plus wall avoidance; weighted crossings cost 200 plus the departing-map penalty and include final arrival escape. Legacy ignores penalties. Field targets must stay inside the rectangle. Service travel can leave it; field work waits for a verified return. Server transitions can still place you outside.',
    );
    const output = document.createElement('p');
    output.id = 'map-policy-preview';
    output.className = 'telemetry-summary';
    panel.append(output);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'secondary compact';
    button.dataset.config = 'true';
    button.textContent = 'Preview map policy and route';
    button.addEventListener('click', () => {
      void this.previewRoute(output, async (signal) => {
        const a = this.read(),
          policy = mapPolicy({ automation: a }),
          p = object(this.status.player),
          destination = policy.lockArea?.map || a.travel.destinationMap,
          map = this.hooks.map();
        let route = 'No destination selected.';
        if (destination && typeof p.x === 'number' && typeof p.y === 'number') {
          const steps = await routeBetweenMapsAsync(
            map,
            { x: Math.floor(p.x), y: Math.floor(p.y) },
            destination,
            this.hooks.settings().route_avoidWalls,
            policy,
            { signal },
          );
          route = steps
            ? `Route: ${[map, ...steps.map((s) => s.portal.toMap)].join(' → ')}`
            : 'No allowed verified route. Search is bounded to 64 crossings and 4096 states.';
        }
        return policySummary(policy, map) + '\n' + route;
      }).catch((error) => {
        output.textContent = error instanceof Error ? error.message : 'Invalid map policy.';
      });
    });
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'secondary compact';
    cancel.textContent = 'Cancel route preview';
    cancel.addEventListener('click', () => this.cancelRoutePreview());
    panel.append(button, cancel);
  }
  private dispositionOutput(): HTMLElement {
    return this.host.querySelector<HTMLElement>('#disposition-preview')!;
  }
  private note(section: Section, message: string): void {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = message;
    this.panel(section).append(p);
  }
  private editor(
    section: Section,
    path: string,
    title: string,
    columns: Column[],
    initial: Row,
    max: number,
  ): RuleEditor {
    const editor = new RuleEditor(
      title,
      columns,
      initial,
      max,
      this.hooks.changed,
      ['combat.rules', 'items', 'skills', 'equipment', 'attackStrategies'].includes(path)
        ? () => actorSnapshotAt(this.status.actorObservations)
        : undefined,
      path === 'combat.rules',
    );
    this.editors.set(path, editor);
    this.panel(section).append(editor.root);
    return editor;
  }
  private rules(): void {
    this.note(
      'combat',
      'Choose “Only monsters attacking me” to defend without selecting species, or “Selected monsters + monsters attacking me” to defend while farming. The bot must observe a monster attack your character; nearby monsters and monsters attacking other players do not qualify. Eligible attackers take priority over ordinary targets and new loot. The current attack engagement, retreat, movement and actions awaiting confirmation settle first. Ignore rules, level limits, field boundaries and engagement exclusions still apply.',
    );
    this.editor(
      'combat',
      'combat.rules',
      'Monster policies & priority',
      [
        idColumn('classId', 'Monster class ID'),
        {
          key: 'action',
          label: 'Action',
          options: [
            ['attack', 'Attack'],
            ['ignore', 'Ignore'],
          ],
        },
        priority,
      ],
      { classId: 1002, action: 'attack', priority: 0 },
      64,
    );
    this.note(
      'combat',
      'Ignore rules apply when their conditions match; known-false ignores fall back to selected combat. Unknown conditions block that class. Attack conditions also guard selected species. Higher priority wins among eligible targets.',
    );
    this.note(
      'combat',
      'Party engagement is off by default. It requires a current, living, visible party member with verified affiliation on this map. Offline, duplicate, missing or stale membership, indirect damage, outside attackers and revoked claims remain excluded. Party participation does not grant your kill or drop credit.',
    );
    const partyState = document.createElement('div');
    partyState.id = 'party-engagement-state';
    partyState.className = 'telemetry-summary';
    this.panel('combat').append(partyState);
    this.editor(
      'combat',
      'attackStrategies',
      'Ordered attack skills by species',
      [
        { key: 'id', label: 'Stable rule ID', kind: 'text' },
        { key: 'speciesIds', label: 'Monster species IDs · comma separated', kind: 'ids' },
        {
          key: 'skillId',
          label: 'Verified actor skill',
          options: [
            ['11', 'Fire Bolt'],
            ['12', 'Cold Bolt'],
            ['16', 'Lightning Bolt'],
          ],
        },
        { key: 'level', label: 'Level', min: 1, max: 10 },
        {
          key: 'behavior',
          label: 'Use',
          options: [
            ['opener', 'Before first normal attack'],
            ['repeat', 'Repeat during engagement'],
          ],
        },
        { key: 'maxAttempts', label: 'Maximum dispatch attempts per actor', min: 1, max: 100 },
        { key: 'maxUses', label: 'Maximum confirmed uses per actor', min: 1, max: 100 },
        { key: 'cooldownSeconds', label: 'Cooldown seconds', min: 1, max: 3600 },
      ],
      {
        id: 'opening-bolt',
        speciesIds: [4000],
        skillId: 11,
        level: 1,
        behavior: 'opener',
        maxAttempts: 1,
        maxUses: 1,
        cooldownSeconds: 3,
      },
      32,
    );
    this.note(
      'combat',
      'Retreat is off by default. It needs a verified ranged weapon and current ammo above the reserve. Distances use rounded projectile distance; desired separation must fit current range. Stop and movement must settle before the same monster is attacked again. Paths and attempts are bounded, and movement does not guarantee avoiding damage.',
    );
    this.note(
      'combat',
      'An empty attack strategy list uses ordinary combat. Earlier matching rules win, even when two rules use the same skill. Opener means before this controller first sends a normal attack at that observed actor. Attempts and confirmations survive Stop/Start and target switches. An unresolved cast cannot be retried on that actor lifetime. Unknown prerequisites wait up to 30 seconds, then skip that actor for 30 seconds while retaining run intent. Only the three bolt skills have automatic cast positioning; combos, skill retreat and automatic ground AoE remain unavailable. Stationary party Heal is a separate opt-in recovery policy.',
    );
    const strategyState = document.createElement('div');
    strategyState.id = 'attack-strategy-state';
    strategyState.className = 'telemetry-summary';
    strategyState.hidden = true;
    this.panel('combat').append(strategyState);
    this.note(
      'recovery',
      'Party Heal uses only visible, living same-map party players with fresh HP. It never walks to them. Existing recovery items, skill rules and equipment changes keep priority. Attempts include failed or uncertain sends; Stop does not cancel a server cast. Remote player element is unknown, and the server validates Heal.',
    );
    const healState = document.createElement('div');
    healState.id = 'party-heal-state';
    healState.className = 'telemetry-summary';
    this.panel('recovery').append(healState);
    this.note(
      'recovery',
      'Automatic respawn is off by default. It sends one save-point request per death and waits for your living character. When sitting recovery is enabled, it reaches the configured HP/SP targets and confirms standing before return. Stop cancels continuation; an unanswered request never retries. The farming map is captured at Start: lock map, journey destination, then starting map. Recovery or return failure keeps the run waiting.',
    );
    this.note(
      'recovery',
      'Emergency escape is opt-in: random uses Fly Wing or Teleport; save point uses Butterfly Wing or Return. Enabled HP and observed-attack triggers combine with OR. Recent attackers count only living visible monsters observed attacking you, not nearby monsters or hidden server aggro. After arrival, recovery requires HP plus a full quiet attack window and cooldown; changing settings does not shorten a spent episode. Stock reserve applies to wings. A rejected or uncertain attempt never falls back to another action.',
    );
    this.editor(
      'travel',
      'travel.waypoints',
      'Waypoints',
      [
        { key: 'map', label: 'Map code', kind: 'text' },
        { key: 'x', label: 'X', min: 0, max: 511 },
        { key: 'y', label: 'Y', min: 0, max: 511 },
      ],
      { map: 'prt_fild08', x: 150, y: 150 },
      64,
    );
    this.note(
      'travel',
      'Travel uses verified portal routes. NPC or conditional portals may require a manual action. A blank player name disables name follow. Party mode requires a verified visible leader before one optional fixed-portal trip. The original loss allowance includes travel and arrival visibility; Stop and Start explicitly retries. Reconnect does not arm a trip.',
    );
    this.editor(
      'inventory',
      'loot.rules',
      'Pickup filters & priority',
      [
        idColumn('itemId', 'Item ID'),
        {
          key: 'action',
          label: 'Action',
          options: [
            ['pickup', 'Pick up'],
            ['ignore', 'Ignore'],
          ],
        },
        priority,
      ],
      { itemId: 501, action: 'pickup', priority: 0 },
      128,
    );
    this.editor(
      'inventory',
      'items',
      'Recovery items',
      [
        idColumn('itemId', 'Item ID'),
        {
          key: 'resource',
          label: 'Resource',
          options: [
            ['hp', 'HP'],
            ['sp', 'SP'],
          ],
        },
        { key: 'belowPercent', label: 'Below %', min: 1, max: 100 },
        { key: 'minStock', label: 'Keep quantity', min: 0, max: 9999 },
        { key: 'cooldownSeconds', label: 'Cooldown seconds', min: 1, max: 3600 },
      ],
      { itemId: 501, resource: 'hp', belowPercent: 60, minStock: 0, cooldownSeconds: 5 },
      32,
    );
    this.editor(
      'inventory',
      'skills',
      'Skill rules',
      [
        idColumn('skillId', 'Skill ID', 255),
        { key: 'level', label: 'Level', min: 1, max: 10 },
        {
          key: 'target',
          label: 'Target',
          options: [
            ['self', 'Your character'],
            ['enemy', 'Current enemy'],
          ],
        },
        { key: 'hpBelowPercent', label: 'HP below %', min: 1, max: 100 },
        { key: 'spAbovePercent', label: 'SP above %', min: 0, max: 100 },
        { key: 'cooldownSeconds', label: 'Cooldown seconds', min: 1, max: 3600 },
      ],
      {
        skillId: 1,
        level: 1,
        target: 'self',
        hpBelowPercent: 100,
        spAbovePercent: 0,
        cooldownSeconds: 10,
      },
      32,
    );
    this.editor(
      'inventory',
      'loadout.ammoPreferences',
      'Ordered arrow preferences',
      [idColumn('itemId', 'Arrow item ID')],
      { itemId: 1750 },
      40,
    );
    this.note(
      'inventory',
      'At the ammo reserve we send Stop and block new attacks. Shots already in flight may consume more before Stop arrives. Restoration waits for exact equipment receipts and stops on manual changes.',
    );
    this.editor(
      'inventory',
      'equipment',
      'Equipment conditions',
      [
        idColumn('itemId', 'Item ID'),
        { key: 'hpBelowPercent', label: 'HP below %', min: 1, max: 100 },
        { key: 'monsterClassId', label: 'Monster ID · 0 any', min: 0, max: 2147483647 },
      ],
      { itemId: 1, hpBelowPercent: 100, monsterClassId: 0 },
      32,
    );
    this.editor(
      'inventory',
      'allocation.stats',
      'Stat allocation targets',
      [
        {
          key: 'stat',
          label: 'Stat',
          options: [
            ['0', 'STR'],
            ['1', 'AGI'],
            ['2', 'VIT'],
            ['3', 'INT'],
            ['4', 'DEX'],
            ['5', 'LUK'],
          ],
        },
        { key: 'target', label: 'Target value', min: 1, max: 99 },
      ],
      { stat: 0, target: 10 },
      6,
    );
    this.editor(
      'inventory',
      'allocation.skills',
      'Skill allocation targets',
      [
        idColumn('skillId', 'Skill ID', 255),
        { key: 'target', label: 'Target level', min: 1, max: 10 },
      ],
      { skillId: 1, target: 1 },
      64,
    );
    this.note(
      'inventory',
      'Rules use server item and skill IDs. Spending stat or skill points changes the character; configure only the targets you intend.',
    );
    const manual = document.createElement('details');
    manual.className = 'manual-group';
    const title = document.createElement('summary');
    title.textContent = 'Manual character actions';
    manual.append(title);
    this.mounts.manualTools.append(manual);
    const grid = document.createElement('div');
    grid.className = 'form-grid';
    manual.append(grid);
    const item = this.input(grid, 'manual-item', 'Usable item ID', 'number', '501', 1);
    item.setAttribute('list', 'itemId-catalog');
    const bag = this.input(grid, 'manual-equip', 'Equipment bag ID', 'number', '1', 1);
    const skill = this.input(grid, 'manual-skill', 'Learned skill ID', 'number', '1', 1, 255);
    skill.setAttribute('list', 'skillId-catalog');
    const level = this.input(grid, 'manual-skill-level', 'Skill level', 'number', '1', 1, 10);
    const target = this.input(
      grid,
      'manual-target',
      'Target entity ID · blank for untargeted item',
      'number',
      '',
      0,
    );
    const x = this.input(grid, 'manual-ground-x', 'Ground X', 'number', '0', 0, 511);
    const y = this.input(grid, 'manual-ground-y', 'Ground Y', 'number', '0', 0, 511);
    const buttons = document.createElement('div');
    buttons.className = 'button-row';
    manual.append(buttons);
    this.manualButton('Sit', () => ({ type: 'sit', sitting: true }), buttons);
    this.manualButton('Stand', () => ({ type: 'sit', sitting: false }), buttons);
    this.manualButton('Respawn', () => ({ type: 'respawn' }), buttons);
    this.manualButton(
      'Use item',
      () => ({
        type: 'useItem',
        itemId: Number(item.value),
        ...(actorInput(target.value, true) !== undefined
          ? { target: actorInput(target.value) }
          : {}),
      }),
      buttons,
    );
    this.manualButton(
      'Equip',
      () => ({ type: 'equip', bagId: Number(bag.value), equipped: true }),
      buttons,
    );
    this.manualButton(
      'Unequip',
      () => ({ type: 'equip', bagId: Number(bag.value), equipped: false }),
      buttons,
    );
    this.manualButton(
      'Self skill',
      () => ({
        type: 'skill',
        mode: 'self',
        skillId: Number(skill.value),
        level: Number(level.value),
      }),
      buttons,
    );
    this.manualButton(
      'Target skill',
      () => ({
        type: 'skill',
        mode: 'target',
        skillId: Number(skill.value),
        level: Number(level.value),
        target: actorInput(target.value),
      }),
      buttons,
    );
    const manualHelp = document.createElement('p');
    manualHelp.className = 'hint';
    manualHelp.textContent =
      'Manual Thunderstorm uses verified range 9 (5 while Blind), stationary projectile sight and exact ground confirmation. Its center may be blocked terrain. Other unverified skills retain adjacent manual targeting. Effective SP needs observed equipment/card/refine metadata; server-only cooldown or disabled state can still reject a cast.';
    manual.append(manualHelp);
    this.manualButton(
      'Ground skill',
      () => ({
        type: 'skill',
        mode: 'ground',
        skillId: Number(skill.value),
        level: Number(level.value),
        position: { x: Number(x.value), y: Number(y.value) },
      }),
      buttons,
    );
    this.manualButton(
      'Spend 1 skill point',
      () => ({ type: 'allocateSkill', skillId: Number(skill.value) }),
      buttons,
    );
    const allocation = document.createElement('div');
    allocation.className = 'form-grid';
    manual.append(allocation);
    const attributes = ['STR', 'AGI', 'VIT', 'INT', 'DEX', 'LUK'].map((stat, index) =>
      this.input(allocation, `manual-stat-${index}`, `${stat} increments`, 'number', '0', 0, 99),
    );
    this.manualButton(
      'Spend stat points',
      () => ({ type: 'allocateStats', attributes: attributes.map((input) => Number(input.value)) }),
      manual,
    );
    const summary = document.createElement('div');
    summary.id = 'character-data';
    summary.className = 'telemetry-summary';
    summary.textContent = 'Connect a character to inspect SP, inventory and learned skills.';
    this.mounts.sessionDetails.append(summary);
    this.note(
      'workflows',
      'Limits and hours are checked while automation runs. These controls never launch the app or start a stopped session.',
    );
  }
  read(): ValidatedAutomationSettings {
    const automation = structuredClone(DEFAULT_AUTOMATION) as unknown as Record<string, unknown>;
    automation.partyHeal = { ...DEFAULT_PARTY_HEAL };
    automation.retreat = structuredClone(DEFAULT_RETREAT);
    automation.mapPolicy = structuredClone(DEFAULT_MAP_POLICY);
    automation.disposition = structuredClone(DEFAULT_DISPOSITION);
    automation.supply = structuredClone(DEFAULT_SUPPLY);
    object(automation.disposition).maxSpend = Number(
      this.settingInputs.get('disposition.maxSpend')!.value,
    );
    for (const definitions of Object.values(fields))
      for (const field of definitions) {
        const input = this.settingInputs.get(field.path)!;
        setPath(
          automation,
          field.path,
          field.kind === 'checkbox'
            ? (input as HTMLInputElement).checked
            : field.kind === 'text' || field.options
              ? input.value
              : Number(input.value),
        );
      }
    if (
      !this.partyHealPresent &&
      Object.entries(DEFAULT_PARTY_HEAL).every(
        ([key, value]) => object(automation.partyHeal)[key] === value,
      )
    )
      delete automation.partyHeal;
    for (const [path, editor] of this.editors) {
      const rows = editor.read();
      if (path === 'attackStrategies') {
        for (const row of rows) row.skillId = Number(row.skillId);
        if (!rows.length && !this.attackStrategiesPresent) continue;
      }
      if (path === 'allocation.stats') for (const row of rows) row.stat = Number(row.stat);
      setPath(automation, path, rows);
    }
    object(automation.disposition).rules = this.dispositionEditor.read().map((row) => ({
      ...row,
      store: row.store === '1',
      cart: row.cart === '1',
      sell: row.sell === '1',
      allowUnique: row.allowUnique === '1',
    }));
    const mp = object(automation.mapPolicy);
    for (const key of ['allow', 'deny'])
      mp[key] = this.host
        .querySelector<HTMLInputElement>(`#map-policy-${key}`)!
        .value.split(/[\s,]+/)
        .filter(Boolean);
    mp.lockArea = this.host.querySelector<HTMLInputElement>('#map-policy-area')!.checked
      ? Object.fromEntries(
          ['map', 'minX', 'minY', 'maxX', 'maxY'].map((key) => {
            const value = this.host.querySelector<HTMLInputElement>(`#map-policy-${key}`)!.value;
            return [key, key === 'map' ? value : Number(value)];
          }),
        )
      : null;
    if (
      !this.retreatPresent &&
      JSON.stringify(automation.retreat) === JSON.stringify(DEFAULT_RETREAT)
    )
      delete automation.retreat;
    const hpPotions = this.hpPotions.read();
    if (this.hpPotionsPresent || JSON.stringify(hpPotions) !== JSON.stringify(DEFAULT_HP_POTIONS))
      automation.hpPotions = hpPotions;
    else delete automation.hpPotions;
    const spPotions = this.spPotions.read();
    if (this.spPotionsPresent || JSON.stringify(spPotions) !== JSON.stringify(DEFAULT_SP_ITEMS))
      automation.spPotions = spPotions;
    else delete automation.spPotions;
    return validateAutomation(automation as unknown as AutomationSettings);
  }
  write(input: AutomationSettingsInput): void {
    let automation = automationDraft(input);
    automation = { ...automation, escape: { ...DEFAULT_AUTOMATION.escape!, ...automation.escape } };
    automation = automationDraft(validateAutomation(automation));
    automation = {
      ...automation,
      mapPolicy: automation.mapPolicy ?? structuredClone(DEFAULT_MAP_POLICY),
      supply: automation.supply ?? structuredClone(DEFAULT_SUPPLY),
    };
    this.partyHealPresent = Object.hasOwn(automation, 'partyHeal');
    automation = { ...automation, partyHeal: automation.partyHeal ?? { ...DEFAULT_PARTY_HEAL } };
    this.retreatPresent = Object.hasOwn(automation, 'retreat');
    automation = { ...automation, retreat: automation.retreat ?? { ...DEFAULT_RETREAT } };
    this.attackStrategiesPresent = Object.hasOwn(automation, 'attackStrategies');
    this.hpPotionsPresent = Object.hasOwn(automation, 'hpPotions');
    this.hpPotions.write(automation.hpPotions ?? DEFAULT_HP_POTIONS);
    this.spPotionsPresent = Object.hasOwn(automation, 'spPotions');
    this.spPotions.write(automation.spPotions ?? DEFAULT_SP_ITEMS);
    for (const definitions of Object.values(fields))
      for (const field of definitions) {
        const input = this.settingInputs.get(field.path)!;
        const value = getPath(automation, field.path);
        if (field.kind === 'checkbox') (input as HTMLInputElement).checked = value === true;
        else input.value = String(value ?? (field.path === 'follow.mode' ? 'name' : ''));
      }
    for (const [path, editor] of this.editors)
      editor.write((getPath(automation, path) ?? []) as Row[]);
    const mp = automation.mapPolicy!;
    for (const key of ['allow', 'deny'] as const)
      this.host.querySelector<HTMLInputElement>(`#map-policy-${key}`)!.value = mp[key].join(', ');
    this.host.querySelector<HTMLInputElement>('#map-policy-area')!.checked = mp.lockArea !== null;
    for (const key of ['map', 'minX', 'minY', 'maxX', 'maxY'] as const)
      this.host.querySelector<HTMLInputElement>(`#map-policy-${key}`)!.value = String(
        mp.lockArea?.[key] ?? (key === 'map' ? '' : 0),
      );
    const policy = automation.disposition ?? DEFAULT_DISPOSITION;
    this.settingInputs.get('disposition.maxSpend')!.value = String(policy.maxSpend);
    this.dispositionEditor.write(
      policy.rules.map((row) => ({
        ...row,
        store: row.store ? '1' : '0',
        cart: row.cart ? '1' : '0',
        sell: row.sell ? '1' : '0',
        allowUnique: row.allowUnique ? '1' : '0',
      })),
    );
    this.dispositionPlan = null;
    this.dispositionOutput().textContent = 'No preview generated. No items will be moved or sold.';
    this.syncFollowMode();
  }
  private syncFollowMode(): void {
    const party =
      this.host.querySelector<HTMLSelectElement>('[data-setting="follow.mode"]')!.value ===
      'partyLeader';
    this.host.querySelector<HTMLInputElement>('[data-setting="follow.name"]')!.disabled =
      this.locked || party;
    this.host.querySelector<HTMLInputElement>('[data-setting="follow.rendezvous"]')!.disabled =
      this.locked || !party;
  }
  levelDifference(): number {
    return Number(
      this.host.querySelector<HTMLInputElement>('[data-setting="combat.levelDifference"]')!.value,
    );
  }
  private async operation(
    action: () => Promise<unknown>,
    locked = this.manualLocked,
    request = true,
  ): Promise<void> {
    if (locked) return;
    try {
      const result = await action();
      if (typeof result === 'string') this.hooks.notify(result);
      else if (request) this.hooks.notify('Request sent. Waiting for the game to confirm.');
    } catch (error) {
      this.hooks.notify(
        error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error
            : 'The game could not accept this request.',
        true,
      );
    }
  }
  private manualButton(
    label: string,
    action: () => Record<string, unknown>,
    parent: HTMLElement,
  ): void {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'secondary compact';
    button.dataset.manual = 'true';
    button.textContent = label;
    button.addEventListener(
      'click',
      () => void this.operation(() => this.hooks.command(checkedAction(action()))),
    );
    parent.append(button);
  }
  private input(
    parent: HTMLElement,
    id: string,
    label: string,
    kind: 'text' | 'number',
    value: string,
    min = 0,
    max = 2147483647,
  ): HTMLInputElement {
    const field = fieldElement({
      path: id,
      label,
      kind: kind === 'text' ? 'text' : undefined,
      min,
      max,
    });
    const input = field.querySelector<HTMLInputElement>('input')!;
    delete input.dataset.setting;
    input.id = id;
    input.value = value;
    parent.append(field);
    return input;
  }
  private detail(title: string): HTMLDetailsElement {
    const details = document.createElement('details');
    details.className = 'manual-group';
    const summary = document.createElement('summary');
    summary.textContent = title;
    details.append(summary);
    this.mounts.manualTools.append(details);
    return details;
  }
  private setup(): void {
    this.macroUi = new MacroUi({
      settings: () => this.hooks.macroSettings?.() ?? this.hooks.settings(),
      apply: (settings) => {
        if (!this.hooks.applySetup) throw new Error('Setup apply is unavailable.');
        this.hooks.applySetup(settings);
      },
      changed: () => this.hooks.setupChanged?.(),
      notify: (message, error) => this.hooks.notify(message, error),
    });
    const form = this.host.querySelector<HTMLElement>('#setup-form');
    const script = this.host.querySelector<HTMLElement>('#setup-script');
    if (!form || !script) throw new Error('Setup view mounts are missing.');
    form.prepend(this.macroUi.summary);
    script.append(this.macroUi.root);
    const formTab = this.host.querySelector<HTMLButtonElement>('#setup-tab-form')!;
    const scriptTab = this.host.querySelector<HTMLButtonElement>('#setup-tab-script')!;
    const select = (showScript: boolean): void => {
      if (!showScript && this.macroUi.dirty) {
        this.hooks.notify(
          'Correct the invalid Script or Discard draft before switching to Form.',
          true,
        );
        return;
      }
      if (showScript) {
        try {
          this.macroUi.syncSettings(this.hooks.macroSettings?.() ?? this.hooks.settings());
        } catch (error) {
          this.hooks.notify(
            error instanceof Error
              ? error.message
              : 'Finish the Form settings before opening Script.',
            true,
          );
          return;
        }
      }
      form.hidden = showScript;
      script.hidden = !showScript;
      formTab.setAttribute('aria-selected', String(!showScript));
      scriptTab.setAttribute('aria-selected', String(showScript));
      formTab.tabIndex = showScript ? -1 : 0;
      scriptTab.tabIndex = showScript ? 0 : -1;
    };
    formTab.addEventListener('click', () => select(false));
    scriptTab.addEventListener('click', () => select(true));
    for (const tab of [formTab, scriptTab])
      tab.addEventListener('keydown', (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const showScript = event.key === 'End' || (event.key !== 'Home' && tab === formTab);
        select(showScript);
        (script.hidden ? formTab : scriptTab).focus();
      });
  }
  private workflows(): void {
    const npc = this.detail('NPC dialogue');
    npc.id = 'npc-dialogue-panel';
    const npcGrid = document.createElement('div');
    npcGrid.className = 'form-grid';
    npc.append(npcGrid);
    const npcId = this.input(npcGrid, 'npc-id', 'Visible NPC ID', 'number', '', 0);
    const option = this.input(npcGrid, 'npc-option', 'Option index', 'number', '0', 0, 31);
    const npcChoiceLabel = document.createElement('label');
    npcChoiceLabel.className = 'form-field';
    npcChoiceLabel.textContent = 'NPCs in view';
    const npcChoice = document.createElement('select');
    npcChoice.id = 'visible-npcs';
    const emptyNpc = document.createElement('option');
    emptyNpc.value = '';
    emptyNpc.textContent = 'Choose a visible NPC';
    npcChoice.append(emptyNpc);
    npcChoiceLabel.append(npcChoice);
    npcGrid.append(npcChoiceLabel);
    npcChoice.addEventListener('change', () => {
      if (npcChoice.value) npcId.value = npcChoice.value;
    });
    const npcButtons = document.createElement('div');
    npcButtons.className = 'button-row';
    npc.append(npcButtons);
    this.manualButton('Talk', () => ({ type: 'npcTalk', id: actorInput(npcId.value) }), npcButtons);
    this.manualButton('Continue', () => ({ type: 'npcAdvance' }), npcButtons);
    this.manualButton(
      'Choose option',
      () => ({ type: 'npcOption', index: Number(option.value) }),
      npcButtons,
    );
    const dialogue = document.createElement('p');
    dialogue.id = 'npc-dialogue';
    dialogue.className = 'telemetry-summary';
    dialogue.textContent = 'No NPC dialogue open.';
    npc.append(dialogue);
    const shop = this.detail('NPC shop · buy & sell');
    const shopRows = new RuleEditor(
      'Transaction rows',
      [idColumn('id', 'Shop item / bag ID'), countColumn],
      { id: 1, count: 1 },
      64,
      () => {},
    );
    shop.append(shopRows.root);
    shopRows.root.open = true;
    const shopButtons = document.createElement('div');
    shopButtons.className = 'button-row';
    shop.append(shopButtons);
    this.manualButton(
      'Buy rows',
      () => ({ type: 'shop', mode: 'buy', rows: shopRows.read() }),
      shopButtons,
    );
    this.manualButton(
      'Sell rows',
      () => ({ type: 'shop', mode: 'sell', rows: shopRows.read() }),
      shopButtons,
    );
    this.manualButton(
      'Close shop',
      () => ({
        type: 'shop',
        mode: object(object(this.status.world).shop).mode ?? 'buy',
        rows: [],
      }),
      shopButtons,
    );
    const shopState = document.createElement('p');
    shopState.id = 'shop-state';
    shopState.className = 'telemetry-summary';
    shopState.textContent =
      'Open a shop through an NPC first. Purchase prices and stock are confirmed by the server.';
    shop.append(shopState);
    const storage = this.detail('Storage & cart');
    const storageGrid = document.createElement('div');
    storageGrid.className = 'form-grid';
    storage.append(storageGrid);
    const bag = this.input(storageGrid, 'transfer-bag', 'Bag ID', 'number', '1', 1);
    const quantity = this.input(storageGrid, 'transfer-count', 'Quantity', 'number', '1', 1, 9999);
    const transferButtons = document.createElement('div');
    transferButtons.className = 'button-row';
    storage.append(transferButtons);
    for (const operation of ['deposit', 'withdraw'] as const)
      this.manualButton(
        operation === 'deposit' ? 'Deposit' : 'Withdraw',
        () => ({
          type: 'storage',
          operation,
          bagId: Number(bag.value),
          count: Number(quantity.value),
        }),
        transferButtons,
      );
    this.manualButton(
      'Close storage',
      () => ({ type: 'storage', operation: 'close' }),
      transferButtons,
    );
    this.manualButton(
      'Bag → cart',
      () => ({
        type: 'cart',
        direction: 1,
        bagId: Number(bag.value),
        count: Number(quantity.value),
      }),
      transferButtons,
    );
    this.manualButton(
      'Cart → bag',
      () => ({
        type: 'cart',
        direction: 2,
        bagId: Number(bag.value),
        count: Number(quantity.value),
      }),
      transferButtons,
    );
    const storageState = document.createElement('p');
    storageState.id = 'storage-state';
    storageState.className = 'telemetry-summary';
    storage.append(storageState);
    const barter = this.detail('NPC item exchanges');
    const barterGrid = document.createElement('div');
    barterGrid.className = 'form-grid';
    barter.append(barterGrid);
    const choice = this.input(barterGrid, 'barter-choice', 'Offer index', 'number', '0', 0, 63);
    const barterCount = this.input(barterGrid, 'barter-count', 'Quantity', 'number', '1', 1, 99);
    const barterBags = this.input(
      barterGrid,
      'barter-bags',
      'Equipment bag IDs · comma separated',
      'text',
      '',
    );
    barterBags.maxLength = 256;
    const barterButtons = document.createElement('div');
    barterButtons.className = 'button-row';
    barter.append(barterButtons);
    this.manualButton(
      'Exchange items',
      () => ({
        type: 'npcBarter',
        choice: Number(choice.value),
        count: Number(barterCount.value),
        bagIds: barterBags.value.trim()
          ? barterBags.value.split(',').map((value) => Number(value.trim()))
          : [],
      }),
      barterButtons,
    );
    this.manualButton('Cancel exchange', () => ({ type: 'npcBarterCancel' }), barterButtons);
    const barterState = document.createElement('p');
    barterState.id = 'barter-state';
    barterState.className = 'telemetry-summary';
    barter.append(barterState);
    const party = this.detail('Party controls');
    const partyGrid = document.createElement('div');
    partyGrid.className = 'form-grid';
    party.append(partyGrid);
    const partyName = this.input(partyGrid, 'party-name', 'Party name', 'text', '');
    const playerName = this.input(partyGrid, 'party-player', 'Invite player name', 'text', '');
    const member = this.input(partyGrid, 'party-member', 'Party member ID', 'number', '0', 1);
    const partyId = this.input(partyGrid, 'party-id', 'Incoming party ID', 'number', '0', 1);
    const partyButtons = document.createElement('div');
    partyButtons.className = 'button-row';
    party.append(partyButtons);
    this.manualButton(
      'Create party',
      () => ({ type: 'partyCreate', name: partyName.value }),
      partyButtons,
    );
    this.manualButton(
      'Invite named player',
      () => ({ type: 'partyInviteName', name: playerName.value }),
      partyButtons,
    );
    this.manualButton(
      'Accept invite',
      () => ({ type: 'partyAccept', partyId: Number(partyId.value) }),
      partyButtons,
    );
    this.manualButton(
      'Make leader',
      () => ({ type: 'partyLeader', memberId: Number(member.value) }),
      partyButtons,
    );
    this.manualButton(
      'Remove member',
      () => ({ type: 'partyRemove', memberId: Number(member.value) }),
      partyButtons,
    );
    this.manualButton('Leave party', () => ({ type: 'partyLeave' }), partyButtons);
    this.manualButton('Disband party', () => ({ type: 'partyDisband' }), partyButtons);
    const partyState = document.createElement('p');
    partyState.id = 'party-state';
    partyState.className = 'telemetry-summary';
    party.append(partyState);
    const vending = this.detail('Player vending');
    vending.id = 'player-vending-panel';
    const vendingName = this.input(vending, 'vending-name', 'Shop name', 'text', '');
    const seller = this.input(vending, 'vending-seller', 'Player shop ID', 'number', '', 0);
    const vendorChoice = document.createElement('select');
    vendorChoice.id = 'visible-player-shops';
    vendorChoice.setAttribute('aria-label', 'Visible player shops');
    vendorChoice.addEventListener('change', () => {
      seller.value = vendorChoice.value;
    });
    vending.append(vendorChoice);
    const vendingState = document.createElement('p');
    vendingState.id = 'vending-state';
    vendingState.className = 'telemetry-summary';
    vending.append(vendingState);
    const vendingRows = new RuleEditor(
      'Vending rows',
      [
        idColumn('id', 'Bag / sale ID'),
        countColumn,
        { key: 'price', label: 'Price', min: 0, max: 9999999 },
      ],
      { id: 1, count: 1, price: 1 },
      32,
      () => {},
    );
    vending.append(vendingRows.root);
    const vendingButtons = document.createElement('div');
    vendingButtons.className = 'button-row';
    vending.append(vendingButtons);
    this.manualButton(
      'Open your shop',
      () => ({ type: 'vendingStart', name: vendingName.value, rows: vendingRows.read() }),
      vendingButtons,
    );
    this.manualButton('Close your shop', () => ({ type: 'vendingStop' }), vendingButtons);
    this.manualButton(
      'View seller',
      () => ({ type: 'vendingView', id: actorInput(seller.value) }),
      vendingButtons,
    );
    this.manualButton(
      'Buy sale rows',
      () => ({
        type: 'vendingPurchase',
        rows: vendingRows.read().map(({ id, count }) => ({ id, count })),
      }),
      vendingButtons,
    );
    const workflow = this.detail('NPC workflow builder');
    const workflowGrid = document.createElement('div');
    workflowGrid.className = 'form-grid';
    workflow.append(workflowGrid);
    const workflowName = this.input(
      workflowGrid,
      'workflow-name',
      'Workflow name',
      'text',
      'Town visit',
    );
    const workflowMap = this.input(workflowGrid, 'workflow-map', 'Map code', 'text', '');
    const workflowNpc = this.input(workflowGrid, 'workflow-npc', 'NPC entity ID', 'number', '', 0);
    const budget = this.input(workflowGrid, 'workflow-budget', 'Maximum spend', 'number', '0', 0);
    const workflowStock = new RuleEditor(
      'Minimum stock guards',
      [idColumn('itemId', 'Item ID'), { key: 'count', label: 'Keep quantity', min: 0, max: 9999 }],
      { itemId: 501, count: 1 },
      64,
      () => {},
    );
    workflow.append(workflowStock.root);
    const steps: Array<Record<string, unknown>> = [];
    const stepsList = document.createElement('ol');
    stepsList.className = 'workflow-steps';
    workflow.append(stepsList);
    const builder = document.createElement('div');
    builder.className = 'form-grid';
    workflow.append(builder);
    const kindLabel = fieldElement({
      path: 'workflow-kind',
      label: 'Step',
      options: [
        ['talk', 'Talk'],
        ['advance', 'Continue'],
        ['option', 'Choose option'],
        ['buy', 'Buy'],
        ['sell', 'Sell'],
        ['deposit', 'Deposit'],
        ['withdraw', 'Withdraw'],
        ['closeShop', 'Close shop'],
        ['closeStorage', 'Close storage'],
        ['cancelBarter', 'Cancel exchange'],
      ],
    });
    builder.append(kindLabel);
    const kind = kindLabel.querySelector<HTMLSelectElement>('select')!;
    delete kind.dataset.setting;
    const stepIndex = this.input(
      builder,
      'workflow-step-index',
      'Option index / item / bag ID',
      'number',
      '0',
      0,
    );
    const stepCount = this.input(
      builder,
      'workflow-step-count',
      'Quantity',
      'number',
      '1',
      1,
      9999,
    );
    const expected = this.input(
      builder,
      'workflow-step-label',
      'Expected option / dialogue text',
      'text',
      '',
    );
    expected.maxLength = 1024;
    const expectedCost = this.input(
      builder,
      'workflow-step-fee',
      'Expected NPC fee · zeny',
      'number',
      '0',
      0,
      2_000_000_000,
    );
    const workflowButtons = document.createElement('div');
    workflowButtons.className = 'button-row';
    workflow.append(workflowButtons);
    const addStep = document.createElement('button');
    addStep.type = 'button';
    addStep.className = 'secondary compact';
    addStep.textContent = '＋ Add step';
    addStep.dataset.config = 'true';
    workflowButtons.append(addStep);
    const renderSteps = () => {
      stepsList.replaceChildren();
      steps.forEach((step, index) => {
        const li = document.createElement('li');
        const description = document.createElement('span');
        description.textContent = JSON.stringify(step);
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'text-button';
        remove.textContent = 'Remove';
        remove.dataset.config = 'true';
        remove.addEventListener('click', () => {
          steps.splice(index, 1);
          renderSteps();
        });
        li.append(description, remove);
        stepsList.append(li);
      });
      addStep.disabled = this.locked || steps.length >= 32;
    };
    addStep.addEventListener('click', () => {
      if (steps.length >= 32) return;
      const type = kind.value;
      let step: Record<string, unknown> = { type };
      if (['talk', 'advance', 'option'].includes(type))
        step.expectedCost = Number(expectedCost.value);
      if (type === 'advance' && expected.value) step.expectedText = expected.value;
      if (type === 'option') {
        step.index = Number(stepIndex.value);
        step.expectedLabel = expected.value;
      }
      if (type === 'buy' || type === 'sell')
        step.rows = [{ id: Number(stepIndex.value), count: Number(stepCount.value) }];
      if (type === 'deposit' || type === 'withdraw') {
        step.bagId = Number(stepIndex.value);
        step.count = Number(stepCount.value);
      }
      steps.push(step);
      renderSteps();
    });
    const spec = () => ({
      name: workflowName.value,
      map: workflowMap.value || this.hooks.map(),
      npcId: actorInput(workflowNpc.value),
      maxSpend: Number(budget.value),
      minStock: workflowStock.read(),
      steps,
    });
    const run = document.createElement('button');
    run.type = 'button';
    run.className = 'primary compact';
    run.textContent = 'Start workflow';
    run.dataset.manual = 'true';
    run.addEventListener(
      'click',
      () => void this.operation(() => this.hooks.workflow(validateWorkflowSpec(spec()))),
    );
    workflowButtons.append(run);
    const workflowPreview = document.createElement('p');
    workflowPreview.className = 'telemetry-summary';
    workflowPreview.hidden = true;
    workflow.append(workflowPreview);
    const preview = document.createElement('button');
    preview.type = 'button';
    preview.className = 'secondary compact';
    preview.textContent = 'Validate / preview';
    preview.dataset.config = 'true';
    preview.addEventListener('click', () => {
      try {
        const checked = validateWorkflowSpec(spec());
        workflowPreview.hidden = false;
        workflowPreview.textContent = featureWorkflowPreviewText(checked);
      } catch (error) {
        this.hooks.notify(error instanceof Error ? error.message : 'Invalid workflow.', true);
      }
    });
    workflowButtons.append(preview);
    const workflowDocument = document.createElement('details');
    workflowDocument.className = 'manual-group';
    const workflowDocumentTitle = document.createElement('summary');
    workflowDocumentTitle.textContent = 'Advanced workflow document';
    workflowDocument.append(workflowDocumentTitle);
    workflow.append(workflowDocument);
    const workflowText = document.createElement('textarea');
    workflowText.className = 'document-editor';
    workflowText.rows = 8;
    workflowText.maxLength = 65000;
    workflowText.spellcheck = false;
    workflowText.placeholder =
      'Export the builder, or paste a typed workflow for multi-item transactions and exchanges.';
    workflowDocument.append(workflowText);
    const exportWorkflow = document.createElement('button');
    exportWorkflow.type = 'button';
    exportWorkflow.className = 'secondary compact';
    exportWorkflow.textContent = 'Export builder';
    exportWorkflow.dataset.config = 'true';
    exportWorkflow.addEventListener('click', () => {
      try {
        workflowText.value = JSON.stringify(spec(), null, 2);
      } catch (error) {
        this.hooks.notify(
          error instanceof Error ? error.message : 'Invalid actor selection.',
          true,
        );
      }
    });
    workflowDocument.append(exportWorkflow);
    const startDocument = document.createElement('button');
    startDocument.type = 'button';
    startDocument.className = 'secondary compact';
    startDocument.textContent = 'Start document';
    startDocument.dataset.manual = 'true';
    startDocument.addEventListener(
      'click',
      () =>
        void this.operation(() =>
          this.hooks.workflow(validateWorkflowSpec(JSON.parse(workflowText.value))),
        ),
    );
    workflowDocument.append(startDocument);
    const workflowHelp = document.createElement('p');
    workflowHelp.className = 'hint';
    workflowHelp.textContent =
      'Choose exact option labels, observed NPC fees and a spending cap. Talk, continue and option fees count toward that cap. The workflow checks the map, NPC, stock and server acknowledgements before each step.';
    workflow.append(workflowHelp);
    const workflowState = document.createElement('p');
    workflowState.id = 'workflow-state';
    workflowState.className = 'telemetry-summary';
    workflow.append(workflowState);
    const routine = this.detail('Advanced condition routines');
    const routineHelp = document.createElement('p');
    routineHelp.className = 'hint';
    routineHelp.textContent =
      'Bounded rules use HP %, SP %, zeny, elapsed seconds, map, inventory, actor status or casting evidence. An unknown observation never matches. Actions use typed commands. Use Macro scripts for field progression and supply sequences. Executable code and raw packets are unavailable.';
    routine.append(routineHelp);
    const routineText = document.createElement('textarea');
    routineText.id = 'routine-document';
    routineText.className = 'document-editor';
    routineText.spellcheck = false;
    routineText.maxLength = 65000;
    routineText.rows = 12;
    routineText.value = JSON.stringify(
      {
        name: 'Rest when hurt',
        durationSeconds: 300,
        maxActions: 1,
        rules: [
          {
            name: 'Sit below 60% HP',
            priority: 1,
            cooldownSeconds: 30,
            maxRuns: 1,
            conditions: [{ field: 'hpPercent', operator: 'lt', value: 60 }],
            action: { type: 'sit', sitting: true },
          },
        ],
      },
      null,
      2,
    );
    routine.append(routineText);
    const routineConditions = new ActorPredicateEditor(
      () => actorSnapshotAt(this.status.actorObservations),
      () => undefined,
    );
    routine.append(routineConditions.root);
    const appendCondition = document.createElement('button');
    appendCondition.type = 'button';
    appendCondition.className = 'secondary compact';
    appendCondition.textContent = 'Append actor conditions to first routine rule';
    appendCondition.dataset.config = 'true';
    appendCondition.addEventListener('click', () => {
      try {
        const checked = validateRoutineSpec(JSON.parse(routineText.value), isAction);
        checked.rules[0]!.conditions.push(...(routineConditions.read() ?? []));
        routineText.value = JSON.stringify(validateRoutineSpec(checked, isAction), null, 2);
      } catch (error) {
        this.hooks.notify(error instanceof Error ? error.message : 'Invalid routine.', true);
      }
    });
    routine.append(appendCondition);
    const routineButtons = document.createElement('div');
    routineButtons.className = 'button-row';
    routine.append(routineButtons);
    const routineStart = document.createElement('button');
    routineStart.type = 'button';
    routineStart.className = 'primary compact';
    routineStart.textContent = 'Start routine';
    routineStart.dataset.manual = 'true';
    routineStart.addEventListener(
      'click',
      () =>
        void this.operation(() =>
          this.hooks.routine(validateRoutineSpec(JSON.parse(routineText.value), isAction)),
        ),
    );
    routineButtons.append(routineStart);
    const routinePreview = document.createElement('p');
    routinePreview.className = 'telemetry-summary';
    routinePreview.hidden = true;
    routine.append(routinePreview);
    const dryRun = document.createElement('button');
    dryRun.type = 'button';
    dryRun.className = 'secondary compact';
    dryRun.textContent = 'Validate / dry run';
    dryRun.dataset.config = 'true';
    dryRun.addEventListener('click', () => {
      try {
        const checked = validateRoutineSpec(JSON.parse(routineText.value), isAction);
        const trace = dryRunRoutine(checked, this.observation(), isAction);
        routinePreview.hidden = false;
        routinePreview.textContent = featureRoutinePreviewText(trace);
        this.hooks.notify('Routine validated. Dry run sends no commands.');
      } catch (error) {
        this.hooks.notify(error instanceof Error ? error.message : 'Invalid routine.', true);
      }
    });
    routineButtons.append(dryRun);
    const routineState = document.createElement('p');
    routineState.id = 'routine-state';
    routineState.className = 'telemetry-summary';
    routine.append(routineState);
  }
  private servicePanel(): void {
    const panel = this.detail('Reusable NPC services');
    const help = document.createElement('p');
    help.className = 'hint';
    help.textContent =
      'Save a named visit using a verified contract. Every visit resolves the NPC again, travels and approaches, checks complete dialogues and fees, then waits for the server outcome. Run service stops combat intent. Edited or unknown contracts remain unavailable drafts.';
    panel.append(help);
    const select = document.createElement('select');
    select.setAttribute('aria-label', 'Saved service or verified preset');
    panel.append(select);
    const editor = document.createElement('textarea');
    editor.className = 'routine-document';
    editor.rows = 14;
    editor.maxLength = 65536;
    editor.setAttribute('aria-label', 'Service definition JSON');
    panel.append(editor);
    const preview = document.createElement('p');
    preview.className = 'telemetry-summary';
    panel.append(preview);
    const state = document.createElement('p');
    state.id = 'service-state';
    state.className = 'telemetry-summary';
    state.textContent = 'No service running.';
    panel.append(state);
    const buttons = document.createElement('div');
    buttons.className = 'button-row';
    panel.append(buttons);
    const documents = document.createElement('textarea');
    documents.className = 'routine-document';
    documents.rows = 5;
    documents.maxLength = 256000;
    documents.setAttribute('aria-label', 'Import or export service document');
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'Import & export services';
    details.append(summary, documents);
    panel.append(details);
    const refresh = (selected?: string) => {
      select.replaceChildren();
      for (const service of BUILTIN_SERVICES) {
        const option = document.createElement('option');
        option.value = 'preset:' + service.id;
        option.textContent = 'Preset · ' + service.name;
        select.append(option);
      }
      for (const service of this.services.list()) {
        const option = document.createElement('option');
        option.value = 'saved:' + service.id;
        option.textContent = 'Saved · ' + service.name;
        select.append(option);
      }
      if (selected) select.value = selected;
    };
    const show = () => {
      this.cancelRoutePreview();
      const [kind, id] = select.value.split(':');
      const service = (kind === 'saved' ? this.services.list() : BUILTIN_SERVICES).find(
        (s) => s.id === id,
      );
      if (service) editor.value = JSON.stringify(service, null, 2);
      preview.textContent = 'Choose Preview to inspect this visit.';
    };
    this.refreshServices = (selected) => {
      refresh(selected);
      show();
    };
    const button = (name: string, action: () => unknown, manual = false) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = manual ? 'primary compact' : 'secondary compact';
      b.textContent = name;
      if (manual) b.dataset.service = 'true';
      else b.dataset.config = 'true';
      b.addEventListener(
        'click',
        () =>
          void this.operation(
            async () => action(),
            manual ? this.serviceLocked : this.locked,
            manual,
          ),
      );
      buttons.append(b);
    };
    button('Preview', () =>
      this.previewRoute(
        preview,
        async (signal) => {
          const status = this.status,
            c = object(status.character),
            p = object(status.player),
            stats = object(c.stats);
          const stock: Record<string, number> = {};
          if (Array.isArray(c.inventory))
            for (const raw of c.inventory) {
              const row = object(raw);
              if (typeof row.itemId === 'number' && typeof row.count === 'number')
                stock[row.itemId] = (stock[row.itemId] ?? 0) + row.count;
            }
          const actors: Entity[] = Array.isArray(status.actors)
            ? status.actors
                .map(object)
                .filter(
                  (a) =>
                    isTalkNpc(a) &&
                    typeof a.id === 'number' &&
                    typeof a.x === 'number' &&
                    typeof a.y === 'number' &&
                    typeof a.kind === 'number' &&
                    typeof a.name === 'string',
                )
                .map((a) => ({
                  id: Number(a.id),
                  x: Number(a.x),
                  y: Number(a.y),
                  kind: Number(a.kind),
                  name: text(a.name),
                  classId: Number(a.classId),
                  level: Number(a.level),
                  hp: Number(a.hp),
                  maxHp: Number(a.maxHp),
                  dead: a.dead === true,
                }))
            : [];
          const skill = Array.isArray(c.learned)
            ? c.learned.map(object).find((skill) => skill.skillId === 1)
            : undefined;
          const result = await previewServiceAsync(
            JSON.parse(editor.value),
            {
              map: this.hooks.map(),
              player:
                typeof p.x === 'number' && typeof p.y === 'number' ? { x: p.x, y: p.y } : null,
              actors,
              inventoryKnown: c.inventoryKnown === true,
              zeny: number(stats.zeny),
              basicSkillLevel: c.skillsKnown === true ? (number(skill?.level) ?? 0) : null,
              stock,
            },
            validateMapPolicy(this.read().mapPolicy),
            { signal },
          );
          return [
            result.available ? 'Verified contract' : 'Unavailable draft',
            result.summary,
            ...result.reasons,
          ]
            .filter(Boolean)
            .join('\n');
        },
        () => JSON.stringify([editor.value, this.servicePreviewEvidence()]),
      ),
    );
    button('Save / update', () => {
      const existing = select.value.startsWith('saved:') ? select.value.slice(6) : undefined;
      this.serviceOperation({
        operation: 'save',
        definition: JSON.parse(editor.value),
        id: existing,
      });
      return 'NPC service saved on this computer.';
    });
    button('Delete saved', () => {
      if (!select.value.startsWith('saved:')) throw new Error('Choose a saved service.');
      this.serviceOperation({ operation: 'remove', id: select.value.slice(6) });
      return 'Saved NPC service deleted.';
    });
    button('Export saved', () => {
      if (!select.value.startsWith('saved:')) throw new Error('Choose a saved service.');
      documents.value = this.services.export(select.value.slice(6));
      details.open = true;
    });
    button('Import document', () => {
      this.serviceOperation({ operation: 'import', document: documents.value });
      return 'NPC services imported on this computer.';
    });
    button(
      'Run service',
      () =>
        this.hooks.service({
          service: validateServiceRequest(JSON.parse(editor.value)),
          executionPolicy: validateMapPolicy(this.read().mapPolicy),
        }),
      true,
    );
    const changed = () => this.hooks.definitionsChanged?.();
    select.addEventListener('change', () => {
      show();
      changed();
    });
    editor.addEventListener('input', changed);
    documents.addEventListener('input', changed);
    refresh();
    show();
  }

  /** Detached validated read; MCP never enters profile application or persistence. */
  readProfiles(): ReturnType<ProfileStore['list']> {
    return this.profiles.list();
  }
  exportProfile(id: string): string {
    return this.profiles.export(id);
  }
  profileOperation(input: {
    operation: 'save' | 'remove' | 'import' | 'apply' | 'select';
    id?: string;
    name?: string;
    document?: string;
  }): void {
    if (this.locked) throw new Error('Wait for the current request before editing profiles.');
    if (input.operation === 'save') {
      const saved = this.profiles.save(
        input.name ?? '',
        this.hooks.character(),
        this.hooks.settings(),
        input.id,
      );
      this.refreshProfiles(saved.id);
    } else if (input.operation === 'import') {
      const imported = this.profiles.import(input.document ?? '');
      this.refreshProfiles(imported[0]?.id);
    } else {
      const selected = this.profiles.list().find((profile) => profile.id === input.id);
      if (!selected) throw new Error('Choose an existing profile.');
      if (input.operation === 'remove') {
        this.profiles.remove(selected.id);
        this.refreshProfiles();
      } else if (input.operation === 'apply') {
        const profile = this.profiles.forMap(selected.id, this.hooks.map(), this.hooks.character());
        this.hooks.apply(profile.settings);
        this.restoreProfileSelection(selected.id);
      } else this.restoreProfileSelection(selected.id);
    }
    this.hooks.changed();
  }
  readServices(): {
    saved: ReturnType<NpcServiceStore['list']>;
    builtins: typeof BUILTIN_SERVICES;
  } {
    return { saved: this.services.list(), builtins: structuredClone(BUILTIN_SERVICES) };
  }
  exportService(id: string): string {
    return this.services.export(id);
  }
  serviceOperation(input: {
    operation: 'save' | 'remove' | 'import';
    id?: string;
    definition?: unknown;
    document?: string;
  }): void {
    if (this.locked) throw new Error('Wait for the current request before editing services.');
    if (input.operation === 'save') {
      const saved = this.services.save(input.definition, input.id);
      this.refreshServices('saved:' + saved.id);
    } else if (input.operation === 'import') {
      const imported = this.services.import(input.document ?? '');
      this.refreshServices('saved:' + imported[0]!.id);
    } else {
      if (!this.services.list().some((service) => service.id === input.id))
        throw new Error('Choose an existing saved service.');
      this.services.remove(input.id!);
      this.refreshServices();
    }
    if (this.hooks.definitionsChanged) this.hooks.definitionsChanged();
    else this.hooks.changed();
  }
  selectedProfileId(): string | null {
    return this.host.querySelector<HTMLSelectElement>('#profile-select')?.value || null;
  }
  restoreProfileSelection(id: string | null): void {
    const select = this.host.querySelector<HTMLSelectElement>('#profile-select');
    if (select) {
      select.value = id && this.profiles.list().some((p) => p.id === id) ? id : '';
      this.hydrateProfileSelection();
    }
  }
  private hydrateProfileSelection: () => void = () => {};
  private profilePanel(): void {
    const panel = this.panel('profiles');
    const controls = document.createElement('div');
    controls.className = 'form-grid';
    panel.append(controls);
    const name = this.input(controls, 'profile-name', 'Profile name', 'text', '');
    name.maxLength = 48;
    const selectLabel = document.createElement('label');
    selectLabel.className = 'form-field';
    selectLabel.textContent = 'Saved profiles';
    const select = document.createElement('select');
    select.id = 'profile-select';
    selectLabel.append(select);
    controls.append(selectLabel);
    const summary = document.createElement('p');
    summary.id = 'profile-summary';
    summary.className = 'hint';
    panel.append(summary);
    const buttons = document.createElement('div');
    buttons.className = 'button-row';
    panel.append(buttons);
    const documentEditor = document.createElement('textarea');
    documentEditor.id = 'profile-document';
    documentEditor.className = 'document-editor';
    documentEditor.spellcheck = false;
    documentEditor.maxLength = 256000;
    documentEditor.rows = 8;
    documentEditor.placeholder =
      'Exported profile JSON appears here. Paste a version 1 profile document to import.';
    const documents = document.createElement('details');
    documents.className = 'manual-group';
    const documentsTitle = document.createElement('summary');
    documentsTitle.textContent = 'Import & export settings';
    documents.append(documentsTitle, documentEditor);
    panel.append(documents);
    const refresh = (selected = '') => {
      const values = this.profiles.list();
      select.replaceChildren();
      const empty = document.createElement('option');
      empty.value = '';
      empty.textContent = 'Choose a profile';
      select.append(empty);
      for (const profile of values) {
        const option = document.createElement('option');
        option.value = profile.id;
        option.textContent = `${profile.name} · ${profile.settings.map}`;
        select.append(option);
      }
      select.value = selected;
      summary.textContent = `${values.length} / ${MAX_PROFILES} profiles · Saved on this computer. No passwords, login preferences or running state.`;
    };
    const action = (title: string, fn: () => void, container: HTMLElement = buttons) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'secondary compact';
      button.textContent = title;
      button.dataset.config = 'true';
      button.addEventListener('click', () => {
        if (this.locked) return;
        try {
          fn();
          this.hooks.changed();
        } catch (error) {
          this.hooks.notify(
            error instanceof Error ? error.message : 'Could not update profiles.',
            true,
          );
        }
      });
      container.append(button);
    };
    this.refreshProfiles = refresh;
    action('Save new', () => {
      const profile = this.profiles.save(name.value, this.hooks.character(), this.hooks.settings());
      refresh(profile.id);
      this.hooks.notify('Settings saved. The profile will never start automation automatically.');
    });
    action('Update selected', () => {
      if (!select.value) throw new Error('Choose a profile to update.');
      const profile = this.profiles.save(
        name.value,
        this.hooks.character(),
        this.hooks.settings(),
        select.value,
      );
      refresh(profile.id);
      this.hooks.notify('Profile updated.');
    });
    action('Apply to saved draft · Next run', () => {
      const profile = this.profiles.forMap(select.value, this.hooks.map(), this.hooks.character());
      this.hooks.apply(profile.settings);
      this.hooks.notify(
        `Loaded ${profile.name} into the saved draft. Start and Apply to current run remain explicit.`,
      );
    });
    action('Delete', () => {
      if (!select.value) throw new Error('Choose a profile to delete.');
      this.profiles.remove(select.value);
      refresh();
      this.hooks.notify('Profile deleted.');
    });
    action('Export', () => {
      documentEditor.value = this.profiles.export(select.value);
      documents.open = true;
    });
    action(
      'Import document',
      () => {
        const imported = this.profiles.import(documentEditor.value);
        refresh(imported[0]?.id);
        this.hooks.notify('Profile imported. Apply it on its saved map when ready.');
      },
      documents,
    );
    this.hydrateProfileSelection = () => {
      const selected = this.profiles.list().find((profile) => profile.id === select.value);
      if (selected) {
        name.value = selected.name;
        summary.textContent = `${selected.character || 'Any character'} · ${selected.settings.map} · ${new Date(selected.savedAt).toLocaleString()} · Apply only changes settings.`;
      }
    };
    select.addEventListener('change', this.hydrateProfileSelection);
    refresh();
    const coverage = document.createElement('details');
    coverage.className = 'manual-group feature-coverage';
    const title = document.createElement('summary');
    title.textContent = 'Advanced · implementation coverage';
    coverage.append(title);
    panel.append(coverage);
    const help = document.createElement('p');
    help.className = 'hint';
    help.textContent =
      '36 feature areas: supported subsets, remaining gaps and unavailable systems. Local or partial implementation does not establish complete coverage or live-game proof.';
    coverage.append(help);
    const table = document.createElement('div');
    table.className = 'coverage-list';
    coverage.append(table);
    const ready = new Set([
      'login',
      'profiles',
      'combat',
      'monsterRules',
      'navigation',
      'follow',
      'recovery',
      'death',
      'conditionRules',
      'loot',
      'shops',
      'progression',
      'scheduler',
      'reconnect',
      'commands',
      'macros',
    ]);
    const partial = new Set([
      'antiKs',
      'combatMovement',
      'travel',
      'teleport',
      'skills',
      'equipment',
      'inventory',
      'storage',
      'npc',
      'crafting',
      'party',
      'social',
      'trade',
      'avoidance',
      'observability',
    ]);
    const unverified = new Set(['companions', 'quests', 'mailBank', 'repair']);
    const rows: Array<[string, string]> = [
      ['login', 'Login & character selection'],
      ['profiles', 'Profiles & import/export'],
      ['combat', 'Combat & retaliation'],
      ['monsterRules', 'Monster policies & priority'],
      ['antiKs', 'Engagement ownership'],
      ['combatMovement', 'Ranged combat & retreat'],
      ['navigation', 'Map navigation & unstuck'],
      ['travel', 'Travel & field boundaries'],
      ['teleport', 'Teleport & escape'],
      ['follow', 'Follow player'],
      ['recovery', 'HP/SP & item recovery'],
      ['death', 'Death & respawn'],
      ['skills', 'Skills & support'],
      ['conditionRules', 'Conditional rules'],
      ['equipment', 'Equipment conditions'],
      ['loot', 'Pickup filters & priority'],
      ['inventory', 'Inventory & weight'],
      ['storage', 'Storage & cart'],
      ['shops', 'NPC shops'],
      ['npc', 'NPC workflows'],
      ['repair', 'Equipment repair'],
      ['crafting', 'Crafting & exchanges'],
      ['progression', 'Stat & skill allocation'],
      ['party', 'Party controls'],
      ['social', 'Guild, friends & chat'],
      ['trade', 'Trade & vending'],
      ['quests', 'Quests & achievements'],
      ['mailBank', 'Mail, bank & auction'],
      ['companions', 'Pets & followers'],
      ['scheduler', 'Hours & session limits'],
      ['reconnect', 'Reconnect backoff'],
      ['avoidance', 'Map & actor avoidance'],
      ['observability', 'Logs & session statistics'],
      ['commands', 'Typed manual commands'],
      ['macros', 'Condition routines'],
      ['plugins', 'Feature extensions'],
    ];
    for (const [id, label] of rows) {
      const row = document.createElement('div');
      const name = document.createElement('span');
      name.textContent = label;
      const state = document.createElement('span');
      state.className = 'coverage-state';
      state.textContent = ready.has(id)
        ? 'Local implementation'
        : partial.has(id)
          ? 'Partial implementation'
          : unverified.has(id)
            ? 'No verified game adapter'
            : 'Not implemented';
      row.append(name, state);
      table.append(row);
    }
  }
  lock(config: boolean, manual: boolean, service = manual, warp = manual): void {
    const formLocked = config || this.macroUi.dirty === true;
    this.locked = formLocked;
    this.manualLocked = manual;
    this.serviceLocked = service;
    for (const input of this.host.querySelectorAll<
      HTMLInputElement | HTMLSelectElement | HTMLButtonElement | HTMLTextAreaElement
    >(
      '[data-setting], [data-config], .feature-panel input, .feature-panel select, .feature-panel textarea, .rule-editor button',
    ))
      input.disabled = formLocked;
    this.syncFollowMode();
    for (const editor of this.editors.values()) editor.lock(formLocked);
    this.dispositionEditor.lock(formLocked);
    this.hpPotions.lock(formLocked);
    this.spPotions.lock(formLocked);
    this.macroUi.lock(config);
    this.recoveryResource.disabled = false;
    for (const button of this.host.querySelectorAll<HTMLButtonElement>('[data-manual]'))
      button.disabled = manual;
    for (const button of this.host.querySelectorAll<HTMLButtonElement>('[data-service]'))
      button.disabled = service;
    this.social.lock(manual);
    this.refine.lock(manual);
    this.memo.lock(manual);
    this.warp.lock(warp);
    this.socket.lock(manual);
    this.manualTargets.lock(manual);
  }
  settledForMaintenance(allowMacro = false): boolean {
    return (allowMacro || !macroActive(this.status.macro)) && this.refine.settledForMaintenance();
  }
  serviceBlocked(): boolean {
    return featureServiceBlocked(this.status);
  }
  clearSocial(): void {
    delete this.status.social;
    this.social.clear();
    delete this.status.socket;
    this.socket.clear();
    delete this.status.refine;
    this.refine.clear();
  }
  clearMemo(): void {
    delete this.status.memo;
    this.memo.clear();
    delete this.status.warp;
    this.warp.clear();
  }
  clearMacro(): void {
    delete this.status.macro;
    this.macroUi.render(undefined, {});
  }
  active(): boolean {
    return featureActive(this.status);
  }
  warpActivationReady(): boolean {
    return validWarpSnapshot(this.status.warp) && this.status.warp.activation !== null;
  }
  hasUnsavedMacro(): boolean {
    return this.macroUi.unsaved;
  }
  setupDraftDirty(): boolean {
    return this.macroUi.dirty;
  }
  setupDocument(): BotScriptDocument {
    return this.macroUi.configured();
  }
  readScript(): ReturnType<MacroUi['readScript']> {
    return this.macroUi.readScript();
  }
  setScript(script: string): ReturnType<MacroUi['setScript']> {
    return this.macroUi.setScript(script);
  }
  syncSetup(settings: SettingsInput): void {
    this.macroUi.syncSettings(settings);
  }
  private observation(): RoutineObservation {
    return featureObservation(this.status, Date.now());
  }
  render(value: unknown): void {
    this.status = object(value);
    this.macroUi.render(this.status.macro, this.observation());
    if (
      this.routePreview &&
      (this.routePreview.identity !== this.previewIdentity() ||
        this.routePreview.evidence !== this.routePreview.current?.())
    )
      this.cancelRoutePreview();
    const s = this.status;
    const character = object(s.character);
    const player = object(s.player);
    const stats = object(character.stats);
    this.hpPotions.update(character);
    this.spPotions.update(character);
    const engagement = object(s.partyEngagement);
    const reasons = Array.isArray(engagement.reasons) ? engagement.reasons.map(text) : [];
    this.host.querySelector<HTMLElement>('#party-engagement-state')!.textContent =
      engagement.enabled === true
        ? `Party exception active · ${number(engagement.accepted) ?? 0} verified engagements · ${number(engagement.blocked) ?? 0} excluded${reasons.length ? '\n' + reasons.join('\n') : ''}`
        : 'Party exception is off; outside engagements remain excluded.';
    const heal = object(s.partyHeal);
    this.host.querySelector<HTMLElement>('#party-heal-state')!.textContent =
      `${text(heal.reason) || 'Party Heal is off.'} · ${number(heal.attempts) ?? 0} attempts · ${number(heal.confirmed) ?? 0} executions confirmed${heal.resourceReadback === true ? ' · fresh resource readback' : ''}`;
    const strategyState = this.host.querySelector<HTMLElement>('#attack-strategy-state')!;
    const strategy = object(s.attackStrategies);
    const engagements = Array.isArray(strategy.entries) ? strategy.entries : [];
    strategyState.hidden = engagements.length === 0;
    strategyState.textContent = featureAttackStrategiesText(strategy);
    const retreat = object(s.retreat);
    const retreatState = this.host.querySelector<HTMLElement>('#retreat-state');
    if (retreatState) {
      retreatState.hidden = retreat.state === undefined || retreat.state === 'off';
      retreatState.textContent = `${text(retreat.state)} · ${text(retreat.reason)} · ${number(retreat.attempts) ?? 0} retreat attempts${retreat.settling === true ? ' · waiting for target clear or movement; nothing is retried' : ''}`;
    }
    this.social.render(s);
    this.memo.render(s);
    this.socket.render(s.socket);
    this.manualTargets.render(s);
    this.refine.render(s);
    this.warp.render(s);
    const conditionState = this.host.querySelector<HTMLElement>('#actor-condition-state')!;
    const traces = Array.isArray(s.ruleConditions) ? s.ruleConditions : [];
    conditionState.hidden = traces.length === 0;
    conditionState.textContent = featureRuleConditionsText(traces);
    if (this.dispositionPlan) {
      try {
        const settings = this.automationSettings();
        if (
          !dispositionPreviewIsCurrent(
            this.dispositionPlan,
            settings.disposition ?? DEFAULT_DISPOSITION,
            {
              ...dispositionContextFromStatus(this.status),
              minimumStock: dispositionStockFloors(settings),
            },
          )
        ) {
          this.dispositionOutput().textContent =
            'Preview is stale. Generate it again from current state.';
          this.dispositionPlan = null;
        }
      } catch {
        this.dispositionPlan = null;
        this.dispositionOutput().textContent =
          'Preview is stale. Validate rules and generate it again.';
      }
    }
    const follow = object(s.partyFollow);
    this.host.querySelector<HTMLElement>('#party-follow-state')!.textContent =
      follow.state && follow.state !== 'disabled'
        ? `${text(follow.state)} · ${text(follow.reason)}${follow.destination ? ' · ' + text(follow.destination) : ''} · ${Math.ceil(number(follow.remainingSeconds) ?? 0)}s remaining`
        : '';
    const supply = object(s.supply),
      supplyOutput = this.host.querySelector<HTMLElement>('#supply-preview')!;
    const supplyText = `${text(supply.state)} · ${text(supply.reason)} · ${number(supply.actions) ?? 0} commands · ${number(supply.spent) ?? 0}z spent / ${number(supply.reserved) ?? 0}z reserved · ${number(supply.remainingTrips) ?? 0} trips left`;
    if (
      supply.active === true ||
      supply.uncertain === true ||
      (number(supply.actions) ?? 0) > 0 ||
      supply.returnDestination
    ) {
      // Publish terminal transitions too; an unchanged snapshot must not erase a fresh preview.
      if (supplyOutput.dataset.supply !== supplyText) supplyOutput.textContent = supplyText;
      supplyOutput.dataset.supply = supplyText;
    }
    const policyOutput = this.host.querySelector<HTMLElement>('#map-policy-preview')!;
    const travel = object(s.travel);
    try {
      let telemetry = '';
      if (
        ['planning', 'walking', 'transition', 'complete', 'failed', 'cancelled'].includes(
          text(travel.state),
        )
      )
        telemetry =
          policySummary(validateMapPolicy(travel.policy ?? DEFAULT_MAP_POLICY), this.hooks.map()) +
          '\n' +
          text(travel.state) +
          ' · ' +
          text(travel.purpose) +
          ' · ' +
          text(travel.reason);
      else {
        const policy = mapPolicy(this.displaySettings?.() ?? this.hooks.settings());
        if (policy.lockArea && typeof player.x === 'number' && typeof player.y === 'number')
          telemetry =
            policySummary(policy, this.hooks.map()) +
            '\n' +
            (insideLockArea(policy, this.hooks.map(), { x: player.x, y: player.y })
              ? 'Inside field lock area.'
              : 'Outside field lock area; field actions wait.');
      }
      if (telemetry && policyOutput.dataset.telemetry !== telemetry)
        policyOutput.textContent = telemetry;
      policyOutput.dataset.telemetry = telemetry;
    } catch (error) {
      policyOutput.textContent =
        'Map policy: ' +
        (error instanceof Error ? error.message : 'Validate the current settings.');
      delete policyOutput.dataset.telemetry;
    }
    const experience = object(s.runExperience);
    const taskLabel = dashboardTaskLabel(s);
    const escape = object(s.escape);
    this.host.querySelector<HTMLElement>('#session-details')!.textContent =
      `${Math.floor((number(s.elapsedSeconds) ?? 0) / 60)}m ${(number(s.elapsedSeconds) ?? 0) % 60}s · ${number(s.deaths) ?? 0} deaths in current game run · EXP gained this run: Base EXP ${signedExperience(experience.baseGained)} · Job EXP ${signedExperience(experience.jobGained)}${taskLabel ? ' · ' + taskLabel : ''}${escape.state && escape.state !== 'idle' ? ' · ' + text(escape.reason) : ''}${object(escape.threats).enabled ? ' · Observed monster attackers: ' + (number(object(escape.threats).count) ?? 'unavailable') + ' / ' + number(object(escape.threats).threshold) + ' in ' + number(object(escape.threats).windowSeconds) + 's (recent attacks, not server aggro)' : ''}`;
    const npcChoice = this.host.querySelector<HTMLSelectElement>('#visible-npcs')!;
    const actors = featureNpcChoices(s.actors);
    const actorKey = map(actors, (actor) => actor.key).join('|');
    if (npcChoice.dataset.actors !== actorKey) {
      const selected = npcChoice.value;
      npcChoice.dataset.actors = actorKey;
      npcChoice.replaceChildren();
      const empty = document.createElement('option');
      empty.value = '';
      empty.textContent = 'Choose a visible NPC';
      npcChoice.append(empty);
      for (const actor of actors) {
        const option = document.createElement('option');
        option.value = actor.value;
        option.textContent = actor.label;
        npcChoice.append(option);
      }
      npcChoice.value = actors.some((actor) => actor.value === selected) ? selected : '';
    }
    const vendorChoice = this.host.querySelector<HTMLSelectElement>('#visible-player-shops')!;
    const vendors = featureVendorChoices(s.actors);
    const vendorKey = map(vendors, (actor) => actor.key).join('|');
    if (vendorChoice.dataset.actors !== vendorKey) {
      const selected = vendorChoice.value;
      vendorChoice.dataset.actors = vendorKey;
      vendorChoice.replaceChildren();
      const empty = document.createElement('option');
      empty.value = '';
      empty.textContent = 'Choose a visible player shop';
      vendorChoice.append(empty);
      for (const actor of vendors) {
        const option = document.createElement('option');
        option.value = actor.value;
        option.textContent = actor.label;
        vendorChoice.append(option);
      }
      vendorChoice.value = vendors.some((actor) => actor.value === selected) ? selected : '';
    }
    const inventory = Array.isArray(character.inventory) ? character.inventory : [];
    const skills = Array.isArray(character.learned) ? character.learned : [];
    const inventoryText = featureInventoryText(inventory);
    const skillText = featureSkillsText(skills);
    const summary = this.host.querySelector<HTMLElement>('#character-data')!;
    summary.textContent = `SP ${number(stats.sp) ?? number(player.sp) ?? '—'} / ${number(stats.maxSp) ?? number(player.maxSp) ?? '—'} · Zeny ${number(stats.zeny) ?? '—'} · Weight ${number(stats.weight) ?? '—'} / ${number(stats.maxWeight) ?? '—'}\n${character.inventoryKnown === true ? `${inventory.length} inventory entries` : 'Inventory not observed'}${inventoryText ? '\n' + inventoryText : ''}\n${character.skillsKnown === true ? `${skills.length} learned skills` : 'Skills not observed'}${skillText ? '\n' + skillText : ''}\nLoadout: ${text(object(s.loadout).state) || 'off'}${text(object(s.loadout).reason) ? ' · ' + text(object(s.loadout).reason) : ''}`;
    const world = object(s.world);
    const npc = object(world.npc);
    const dialog = object(npc.dialog);
    this.host.querySelector<HTMLElement>('#npc-dialogue')!.textContent =
      `${text(dialog.name)}${dialog.name ? ' · ' : ''}${text(dialog.text) || 'No NPC dialogue open.'}${Array.isArray(npc.options) && npc.options.length ? '\n' + npc.options.map((label, index) => `${index}: ${text(label)}`).join('\n') : ''}`;
    this.host.querySelector<HTMLElement>('#vending-state')!.textContent = featureVendingText(
      world.viewedVending,
    );
    const shop = object(world.shop);
    this.host.querySelector<HTMLElement>('#shop-state')!.textContent = Array.isArray(shop.entries)
      ? `${text(shop.mode)} shop · ${shop.entries.length} entries\n${shop.entries
          .slice(0, 30)
          .map((entry) => {
            const row = object(entry);
            return `${itemName(number(row.itemId) ?? number(row.id) ?? 0)} · #${number(row.id) ?? number(row.itemId) ?? '?'} · ${number(row.price) ?? '?'} zeny`;
          })
          .join('\n')}`
      : 'Open a shop through an NPC first.';
    this.host.querySelector<HTMLElement>('#storage-state')!.textContent =
      `Storage: ${world.storageReady === true && Array.isArray(world.storage) ? world.storage.length : 'not open'} entries · Cart: ${world.cartReady === true && Array.isArray(world.cart) ? world.cart.length : 'unknown'} entries`;
    const party = object(world.party);
    const invite = object(world.invite);
    this.host.querySelector<HTMLElement>('#party-state')!.textContent =
      `${party.name ? `${text(party.name)} · ${Array.isArray(party.members) ? party.members.map((member) => text(object(member).name)).join(', ') : ''}` : 'No party state observed.'}${invite.partyId ? '\nInvite ' + text(invite.name) + ' · party #' + invite.partyId + ' · from ' + text(invite.sender) : ''}`;
    this.host.querySelector<HTMLElement>('#barter-state')!.textContent =
      Array.isArray(world.barter) && world.barter.length
        ? world.barter
            .slice(0, 30)
            .map((entry, index) => {
              const row = object(entry);
              return `${index}: ${itemName(number(object(row.item).itemId) ?? 0)} · ${JSON.stringify(row.required ?? []).slice(0, 300)}`;
            })
            .join('\n')
        : 'No NPC exchange open.';
    const workflow = object(s.workflow);
    this.host.querySelector<HTMLElement>('#workflow-state')!.textContent =
      workflow.running === true
        ? `${text(workflow.name)} · step ${number(workflow.step) ?? 0} / ${number(workflow.total) ?? 0} · ${text(workflow.reason)}`
        : text(workflow.reason) || 'No workflow running.';
    const service = object(s.service);
    this.host.querySelector<HTMLElement>('#service-state')!.textContent =
      service.active === true
        ? `${text(service.name)} · ${text(service.state)} · ${text(service.reason)}`
        : text(service.reason) || 'No service running.';
    const routine = object(s.routine);
    this.host.querySelector<HTMLElement>('#routine-state')!.textContent =
      text(routine.reason) || 'No routine running.';
  }
}
