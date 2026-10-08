import { map } from 'effect/Array';
import { identity } from 'effect/Function';
import {
  flatMap,
  gen,
  getOrThrowWith,
  map as mapResult,
  mapError,
  try as tryResult,
  type Result,
} from 'effect/Result';
import {
  DEFAULT_AUTOMATION,
  DEFAULT_ESCAPE,
  DEFAULT_LOADOUT,
  DEFAULT_PARTY_HEAL,
  DEFAULT_RETREAT,
  DEFAULT_SETTINGS,
  validateFormSettings,
  settingsDraft,
  type Settings,
  type SettingsInput,
} from './settings';
import {
  MACRO_LIMITS,
  validateMacroScript,
  validMacroStep,
  type MacroRule,
  type MacroScript,
  type MacroStep,
} from '../automation/macros-logic';
import { validRoutineCondition, type RoutineCondition } from '../automation/routines-logic';
import type { ActorSelector } from '../world/actor-observations-logic';
import { DEFAULT_MAP_POLICY } from '../navigation/map-policy-logic';
import {
  DEFAULT_RECOVERY_ITEMS,
  DEFAULT_SP_ITEMS,
  RECOVERY_ITEM_IDS,
} from '../recovery/recovery-items';
import { DEFAULT_DISPOSITION } from '../services/disposition';
import { DEFAULT_SUPPLY } from '../services/supply-trip-logic';

export interface BotScriptDocument {
  settings: Settings;
  script: MacroScript | null;
}
export interface BotScriptDocumentInput {
  settings: SettingsInput;
  script: MacroScript | null;
}
export class BotScriptError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(`Line ${line}: ${message}`);
    this.name = 'BotScriptError';
  }
}
export const BOT_SCRIPT_LIMITS = {
  authoringBytes: 262_144,
  lines: 8_192,
  settingsBytes: 65_536,
  requestBytes: 131_072,
} as const;
const utf8 = new TextEncoder();
type Unit = 'number' | 'percent' | 'seconds' | 'minutes';
type Schema = (
  | {
      kind: 'number';
      min: number;
      max: number;
      integer: boolean;
      unit: Unit;
      unlimited?: boolean;
      choices?: readonly number[];
    }
  | { kind: 'string'; choices?: readonly string[] }
  | { kind: 'boolean' }
  | {
      kind: 'object';
      fields: Record<string, Schema>;
      defaults?: Record<string, unknown>;
      nullable?: boolean;
    }
  | { kind: 'array'; item: Schema; max: number }
) & { optional?: boolean };
const number = (
  min: number,
  max: number,
  unit: Unit = 'number',
  integer = true,
  unlimited = false,
): Extract<Schema, { kind: 'number' }> => ({ kind: 'number', min, max, unit, integer, unlimited });
const string = (...choices: string[]): Schema => ({
  kind: 'string',
  ...(choices.length ? { choices } : {}),
});
const boolean: Schema = { kind: 'boolean' };
const object = (fields: Record<string, Schema>, defaults?: object, nullable = false): Schema => ({
  kind: 'object',
  fields,
  defaults: defaults as Record<string, unknown> | undefined,
  nullable,
});
const array = (item: Schema, max: number): Schema => ({ kind: 'array', item, max });
const optional = (schema: Schema): Schema => ({ ...schema, optional: true });
const id = number(1, MACRO_LIMITS.maxId);
const percent = (min = 0, max = 100): Schema => number(min, max, 'percent');
const seconds = (min: number, max: number): Schema => number(min, max, 'seconds');
const actor = object({
  scope: string('self', 'target', 'candidate', 'actor'),
  id: optional(number(0, MACRO_LIMITS.maxId)),
  world: optional(string()),
  incarnation: optional(id),
});
const conditions = array(
  object({
    field: string('actorStatus', 'actorCasting', 'actorHpPercent', 'actorSpPercent'),
    actor,
    operator: string('lt', 'lte', 'eq', 'gte', 'gt', 'ne'),
    value: { kind: 'number', min: 0, max: 100, integer: false, unit: 'percent' },
    statusId: optional(number(1, 255)),
    skillId: optional(number(1, 255)),
  }),
  16,
);
// Predicate value is boolean for status/casting and numeric for resources. Its
// dependent shape is checked by the existing settings validator after assembly.
const potion = (resource: 'hp' | 'sp'): Schema =>
  object(
    {
      mode: string('off', 'any', 'selected'),
      itemIds: array(id, RECOVERY_ITEM_IDS[resource].length),
      belowPercent: percent(1),
      minStock: number(0, 9999),
      cooldownSeconds: seconds(resource === 'hp' ? 0 : 1, 3600),
    },
    resource === 'hp' ? DEFAULT_RECOVERY_ITEMS : DEFAULT_SP_ITEMS,
  );
const automation = object(
  {
    loadout: optional(
      object(
        {
          enabled: boolean,
          autoAmmo: boolean,
          minAmmoStock: number(0, 9999),
          ammoPreferences: array(object({ itemId: id }), 40),
          restore: string('conditionEnd', 'never'),
          cooldownSeconds: seconds(1, 3600),
        },
        DEFAULT_LOADOUT,
      ),
    ),
    combat: object(
      {
        mode: string('off', 'selected', 'retaliate', 'both'),
        levelDifference: number(-100, 100),
        partyEngagement: optional(boolean),
        rules: array(
          object({
            classId: id,
            action: string('attack', 'ignore'),
            priority: number(-100, 100),
            conditions: optional(conditions),
          }),
          64,
        ),
      },
      DEFAULT_AUTOMATION.combat,
    ),
    loot: object(
      {
        ownership: string('own', 'all'),
        defaultAction: string('pickup', 'ignore'),
        rules: array(
          object({ itemId: id, action: string('pickup', 'ignore'), priority: number(-100, 100) }),
          128,
        ),
      },
      DEFAULT_AUTOMATION.loot,
    ),
    recovery: object(
      {
        enabled: boolean,
        hpStart: percent(1, 95),
        hpEnd: percent(2),
        spStart: percent(0, 95),
        spEnd: percent(1),
        timeoutSeconds: seconds(1, 3600),
      },
      DEFAULT_AUTOMATION.recovery,
    ),
    escape: optional(
      object(
        {
          enabled: boolean,
          hpBelowPercent: percent(1, 95),
          mode: string('random', 'save'),
          method: string('item', 'skill'),
          minStock: number(0, 9999),
          cooldownSeconds: seconds(1, 3600),
          hpEnabled: optional(boolean),
          threatEnabled: optional(boolean),
          threatCount: optional(number(1, 64)),
          threatWindowSeconds: optional(seconds(1, 60)),
        },
        DEFAULT_ESCAPE,
      ),
    ),
    items: array(
      object({
        itemId: id,
        resource: string('hp', 'sp'),
        belowPercent: percent(1),
        minStock: number(0, 9999),
        cooldownSeconds: seconds(1, 3600),
        conditions: optional(conditions),
      }),
      32,
    ),
    hpPotions: optional(potion('hp')),
    spPotions: optional(potion('sp')),
    skills: array(
      object({
        skillId: number(1, 255),
        level: number(1, 10),
        target: string('self', 'enemy'),
        hpBelowPercent: percent(1),
        spAbovePercent: percent(),
        cooldownSeconds: seconds(1, 3600),
        conditions: optional(conditions),
      }),
      32,
    ),
    equipment: array(
      object({
        itemId: id,
        hpBelowPercent: percent(1),
        monsterClassId: number(0, MACRO_LIMITS.maxId),
        conditions: optional(conditions),
      }),
      32,
    ),
    attackStrategies: optional(
      array(
        object({
          id: string(),
          speciesIds: array(id, 64),
          skillId: number(11, 16),
          level: number(1, 10),
          behavior: string('opener', 'repeat'),
          maxAttempts: number(1, 100),
          maxUses: number(1, 100),
          cooldownSeconds: seconds(1, 3600),
          conditions: optional(conditions),
        }),
        32,
      ),
    ),
    retreat: optional(
      object(
        {
          enabled: boolean,
          triggerDistance: number(1, 13),
          desiredDistance: number(2, 14),
          maxPathSteps: number(1, 20),
          maxAttempts: number(1, 10),
        },
        DEFAULT_RETREAT,
      ),
    ),
    partyHeal: optional(
      object(
        {
          enabled: boolean,
          level: number(1, 10),
          hpBelowPercent: percent(1),
          spReserve: number(0, MACRO_LIMITS.maxId),
          cooldownSeconds: seconds(1, 3600),
          maxAttempts: number(1, 100),
        },
        DEFAULT_PARTY_HEAL,
      ),
    ),
    allocation: object(
      {
        stats: array(object({ stat: number(0, 5), target: number(1, 99) }), 6),
        skills: array(object({ skillId: number(1, 255), target: number(1, 10) }), 64),
      },
      DEFAULT_AUTOMATION.allocation,
    ),
    follow: object(
      {
        mode: optional(string('name', 'partyLeader')),
        rendezvous: optional(boolean),
        name: string(),
        distance: number(1, 20),
        lostSeconds: seconds(1, 120),
      },
      DEFAULT_AUTOMATION.follow,
    ),
    travel: object(
      {
        destinationMap: string(),
        returnToLockMap: boolean,
        waypoints: array(object({ map: string(), x: number(0, 511), y: number(0, 511) }), 64),
        loop: boolean,
      },
      DEFAULT_AUTOMATION.travel,
    ),
    limits: object(
      {
        minutes: number(0, 1440, 'minutes', true, true),
        kills: number(0, 1_000_000, 'number', true, true),
        pickups: number(0, 1_000_000, 'number', true, true),
        weightPercent: percent(),
      },
      DEFAULT_AUTOMATION.limits,
    ),
    respawn: object({ enabled: boolean, maxDeaths: number(0, 100) }, DEFAULT_AUTOMATION.respawn),
    schedule: object(
      { enabled: boolean, startHour: number(0, 23), endHour: number(0, 23) },
      DEFAULT_AUTOMATION.schedule,
    ),
    disposition: optional(
      object(
        {
          maxSpend: number(0, MACRO_LIMITS.maxSpend),
          rules: array(
            object({
              itemId: id,
              keep: number(0, 32767),
              minimum: number(0, 32767),
              desired: number(0, 32767),
              maximum: number(0, 32767),
              store: boolean,
              sell: boolean,
              cart: boolean,
              restock: string('off', 'storage', 'cart', 'buy'),
              allowUnique: boolean,
            }),
            128,
          ),
        },
        DEFAULT_DISPOSITION,
      ),
    ),
    supply: optional(
      object(
        {
          enabled: boolean,
          stockEnabled: boolean,
          weightEnabled: boolean,
          weightStartPercent: percent(1),
          weightEndPercent: percent(1, 99),
          minimumIntervalSeconds: seconds(1, 86400),
          maxTrips: number(1, 100),
          maxActions: number(1, 100),
          maxDurationSeconds: seconds(30, 3600),
          maxSpend: number(0, MACRO_LIMITS.maxSpend),
          storageService: string(),
          buyService: string(),
          sellService: string(),
          merchantMode: optional(string('manual', 'automatic')),
          transport: optional(string('travel', 'butterfly', 'returnSkill')),
          saveMap: optional(string()),
          returnMinStock: optional(number(0, 9999)),
        },
        DEFAULT_SUPPLY,
      ),
    ),
    mapPolicy: optional(
      object(
        {
          mode: string('legacy', 'weighted'),
          allow: array(string(), 256),
          deny: array(string(), 256),
          penalties: array(
            object({ map: string(), cost: number(0, 1_000_000, 'number', false) }),
            256,
          ),
          lockArea: object(
            {
              map: string(),
              minX: number(0, 511),
              minY: number(0, 511),
              maxX: number(0, 511),
              maxY: number(0, 511),
            },
            undefined,
            true,
          ),
        },
        DEFAULT_MAP_POLICY,
      ),
    ),
  },
  DEFAULT_AUTOMATION,
);
const settingsSchema = object(
  {
    map: string(),
    targets: array(id, 64),
    radius: number(1, 20),
    minHpPercent: percent(20, 95),
    loot: boolean,
    route_randomWalk: { ...number(0, 2), choices: [0, 2] },
    route_step: number(1, 20),
    route_avoidWalls: boolean,
    route_randomWalk_maxRouteTime: seconds(1, 600),
    attackRouteMaxPathDistance: number(1, 200),
    attackMaxRouteTime: seconds(1, 60),
    automation: optional(automation),
  },
  DEFAULT_SETTINGS,
);
const aliases: Record<string, string> = {
  'emergency-hp': 'minHpPercent',
  'random-walk': 'route_randomWalk',
  'route-step': 'route_step',
  'avoid-walls': 'route_avoidWalls',
  'route-time': 'route_randomWalk_maxRouteTime',
  'attack-distance': 'attackRouteMaxPathDistance',
  'attack-time': 'attackMaxRouteTime',
};
type Segment = string | number;
interface Token {
  value: string;
  quoted: boolean;
}
function fail(message: string, line: number): never {
  throw new BotScriptError(message, line);
}

/** Only # outside a quoted string starts a comment. Escapes use ordinary JSON string spelling. */
function sourceLine(source: string, line: number): { code: string; comment: string } {
  let quoted = false,
    escaped = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === '#') return { code: source.slice(0, i).trim(), comment: source.slice(i) };
  }
  if (quoted) fail('Close the quoted string.', line);
  return { code: source.trim(), comment: '' };
}
function tokens(source: string, line: number): Token[] {
  const result: Token[] = [];
  for (let i = 0; i < source.length;) {
    if (/\s/.test(source[i]!)) {
      i++;
      continue;
    }
    const start = i;
    if (source[i] === '"') {
      let escaped = false;
      i++;
      for (; i < source.length; i++) {
        const c = source[i];
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') {
          i++;
          break;
        }
      }
      try {
        result.push({ value: JSON.parse(source.slice(start, i)) as string, quoted: true });
      } catch {
        fail('Use a valid quoted string; escape quotes with \\".', line);
      }
    } else if ('[],=<>!'.includes(source[i]!)) {
      i++;
      if ('=<>!'.includes(source[start]!) && source[i] === '=') i++;
      result.push({ value: source.slice(start, i), quoted: false });
    } else {
      while (i < source.length && !/[\s\[\],=<>!"]/.test(source[i]!)) i++;
      result.push({ value: source.slice(start, i), quoted: false });
    }
  }
  return result;
}
class LineReader {
  private index = 0;
  constructor(
    private readonly values: Token[],
    readonly line: number,
  ) {}
  get remaining(): number {
    return this.values.length - this.index;
  }
  peek(): string | undefined {
    return this.values[this.index]?.value;
  }
  next(): Token {
    return this.values[this.index++] ?? fail('The command is incomplete.', this.line);
  }
  expect(word: string): void {
    const token = this.next();
    if (token.quoted || token.value !== word) fail(`Expected ${word}.`, this.line);
  }
  done(): void {
    if (this.remaining) fail('Unexpected text at the end of the command.', this.line);
  }
  text(quoted = false): string {
    const token = this.next();
    if (quoted && !token.quoted) fail('Put the name in double quotes.', this.line);
    if (!token.quoted && (!token.value.length || /^[\[\],=<>!]+$/.test(token.value)))
      fail('Expected a name or identifier.', this.line);
    return token.value;
  }
  numeric(schema: Extract<Schema, { kind: 'number' }>): number {
    const token = this.next();
    if (token.quoted) fail('Expected a number.', this.line);
    if (token.value === 'unlimited' && schema.unlimited) return 0;
    const match = /^(-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?)([%a-z]*)$/.exec(token.value);
    if (!match) fail('Expected a number with a supported unit.', this.line);
    let value = Number(match[1]);
    const unit = match[2]!;
    if (unit === '%' && schema.unit === 'percent') {
      /* percentages keep their native scale */
    } else if (
      ['s', 'm', 'h'].includes(unit) &&
      (schema.unit === 'seconds' || schema.unit === 'minutes')
    ) {
      value *= unit === 'h' ? 3600 : unit === 'm' ? 60 : 1;
      if (schema.unit === 'minutes') value /= 60;
    } else if (unit) fail(`Unit ${unit} is not valid for this value.`, this.line);
    if (
      !Number.isFinite(value) ||
      (schema.integer && !Number.isInteger(value)) ||
      value < schema.min ||
      value > schema.max
    ) {
      fail(
        `Use ${schema.integer ? 'a whole number' : 'a number'} from ${schema.min} to ${schema.max}.`,
        this.line,
      );
    }
    if (schema.choices && !schema.choices.includes(value))
      fail(`Choose ${schema.choices.join(' or ')}.`, this.line);
    return value;
  }
  scalar(schema: Schema, predicateValue = false): unknown {
    if (predicateValue && ['true', 'false'].includes(this.peek() ?? '')) return this.boolean();
    if (schema.kind === 'number') return this.numeric(schema);
    if (schema.kind === 'boolean') return this.boolean();
    if (schema.kind === 'string') {
      const value = this.text();
      if (schema.choices && !schema.choices.includes(value))
        fail(`Choose ${schema.choices.join(', ')}.`, this.line);
      return value;
    }
    if (schema.kind === 'object' && schema.nullable && this.peek() === 'null') {
      this.expect('null');
      return null;
    }
    if (schema.kind === 'array') {
      this.expect('[');
      const values: unknown[] = [];
      while (this.peek() !== ']') {
        if (values.length >= schema.max)
          fail(`Keep at most ${schema.max} entries in this list.`, this.line);
        values.push(this.scalar(schema.item));
        if (this.peek() !== ']') this.expect(',');
        if (this.peek() === ']') break;
      }
      this.expect(']');
      return values;
    }
    return fail('Set object fields individually, using paths such as rules[0].itemId.', this.line);
  }
  boolean(): boolean {
    const token = this.next();
    if (token.quoted || !['true', 'false'].includes(token.value))
      fail('Use true or false.', this.line);
    return token.value === 'true';
  }
}
const numericSchema = (schema: Schema): Extract<Schema, { kind: 'number' }> =>
  schema as Extract<Schema, { kind: 'number' }>;
function pathParts(source: string, line: number): Segment[] {
  const path = aliases[source] ?? source;
  if (
    !/^[a-zA-Z][a-zA-Z0-9_]*(?:\[(?:0|[1-9]\d*)\])?(?:\.[a-zA-Z][a-zA-Z0-9_]*(?:\[(?:0|[1-9]\d*)\])?)*$/.test(
      path,
    )
  ) {
    fail('Use a setting path with whole array indexes, such as automation.items[0].itemId.', line);
  }
  const segments = path
    .match(/[a-zA-Z][a-zA-Z0-9_]*|\d+/g)!
    .map((part) => (/^\d+$/.test(part) ? Number(part) : part));
  if (
    segments.some(
      (part) =>
        typeof part === 'string' && ['__proto__', 'prototype', 'constructor'].includes(part),
    )
  ) {
    fail('That setting path is not allowed.', line);
  }
  return segments;
}
function schemaAt(parts: Segment[], line: number): Schema {
  let schema = settingsSchema;
  for (const part of parts) {
    if (typeof part === 'number') {
      if (schema.kind !== 'array' || !Number.isSafeInteger(part) || part >= schema.max)
        fail('This setting array index is out of range.', line);
      schema = schema.item;
    } else {
      if (schema.kind !== 'object' || !Object.hasOwn(schema.fields, part))
        fail(`Unknown setting path: ${part}.`, line);
      schema = schema.fields[part]!;
    }
  }
  return schema;
}
interface SettingAssignment {
  parts: Segment[];
  line: number;
}
function assignSetting(target: Record<string, unknown>, parts: Segment[], value: unknown): void {
  let owner: Record<string | number, unknown> = target;
  for (const [index, part] of parts.entries()) {
    if (index === parts.length - 1) {
      owner[part] = value;
      return;
    }
    if (!Object.hasOwn(owner, part)) owner[part] = typeof parts[index + 1] === 'number' ? [] : {};
    owner = owner[part] as Record<string | number, unknown>;
  }
}
function hydrate(value: unknown, schema: Schema, line: number): unknown {
  if (schema.kind === 'array' && Array.isArray(value)) {
    for (let i = 0; i < value.length; i++)
      if (!Object.hasOwn(value, i)) fail('Array indexes must be consecutive, starting at 0.', line);
    return value.map((entry) => hydrate(entry, schema.item, line));
  }
  if (schema.kind !== 'object' || value === null) return value;
  const result = { ...(value as Record<string, unknown>) };
  for (const [key, field] of Object.entries(schema.fields)) {
    if (Object.hasOwn(result, key)) result[key] = hydrate(result[key], field, line);
    else if (!field.optional && schema.defaults && Object.hasOwn(schema.defaults, key)) {
      result[key] = hydrate(structuredClone(schema.defaults[key]), field, line);
    }
  }
  return result;
}
function checkedSettings(input: SettingsInput, line: number): Settings {
  try {
    validateFormSettings(input);
  } catch (error) {
    fail(error instanceof Error ? error.message : 'Invalid settings.', line);
  }
  if (utf8.encode(JSON.stringify(input)).length > BOT_SCRIPT_LIMITS.settingsBytes)
    fail('Compiled settings are too large.', line);
  // Validation supplies runtime defaults, but authoring retains optional absence.
  return settingsDraft(input);
}
const operatorNames: Record<string, 'lt' | 'lte' | 'eq' | 'gte' | 'gt' | 'ne'> = {
  '<': 'lt',
  '<=': 'lte',
  '==': 'eq',
  '>=': 'gte',
  '>': 'gt',
  '!=': 'ne',
};
const fieldNames: Record<string, string> = {
  hp: 'hpPercent',
  sp: 'spPercent',
  weight: 'weightPercent',
  'job-level': 'jobLevel',
  elapsed: 'elapsedSeconds',
};
function readOperator(reader: LineReader): string {
  const token = reader.next();
  const operator = token.quoted ? undefined : operatorNames[token.value];
  return operator ?? fail('Use <, <=, ==, >=, > or != for a comparison.', reader.line);
}
function readActor(reader: LineReader): ActorSelector {
  const scope = reader.peek();
  if (scope === 'self' || scope === 'target') {
    reader.expect(scope);
    return { scope };
  }
  const id = reader.numeric(numericSchema(number(0, MACRO_LIMITS.maxId)));
  reader.expect('world');
  const world = reader.text(true);
  reader.expect('incarnation');
  const incarnation = reader.numeric(numericSchema(number(1, MACRO_LIMITS.maxId)));
  return { scope: 'actor', id, world, incarnation };
}
function readCondition(reader: LineReader): RoutineCondition {
  const sourceField = reader.text();
  let condition: unknown;
  if (sourceField === 'actor') {
    const actor = readActor(reader),
      property = reader.text();
    if (property === 'status') {
      const statusId = reader.numeric(numericSchema(number(1, 255))),
        operator = readOperator(reader);
      condition = { field: 'actorStatus', actor, statusId, operator, value: reader.boolean() };
    } else if (property === 'casting') {
      let skillId: number | undefined;
      if (reader.peek() === 'skill') {
        reader.expect('skill');
        skillId = reader.numeric(numericSchema(number(1, 255)));
      }
      const operator = readOperator(reader);
      condition = {
        field: 'actorCasting',
        actor,
        ...(skillId === undefined ? {} : { skillId }),
        operator,
        value: reader.boolean(),
      };
    } else if (property === 'hp' || property === 'sp') {
      const operator = readOperator(reader),
        value = reader.numeric(numericSchema(number(0, 100, 'percent', false)));
      condition = {
        field: property === 'hp' ? 'actorHpPercent' : 'actorSpPercent',
        actor,
        operator,
        value,
      };
    } else fail('Actor conditions use hp, sp, status or casting.', reader.line);
  } else {
    const field = fieldNames[sourceField] ?? sourceField;
    if (field === 'map')
      condition = { field, operator: readOperator(reader), value: reader.text() };
    else if (field === 'inventory') {
      const itemId = reader.numeric(numericSchema(id)),
        operator = readOperator(reader);
      condition = {
        field,
        itemId,
        operator,
        value: reader.numeric(numericSchema(number(0, MACRO_LIMITS.maxId))),
      };
    } else {
      const schemas: Record<string, Schema> = {
        hpPercent: number(0, 100, 'percent', false),
        spPercent: number(0, 100, 'percent', false),
        weightPercent: number(0, 100, 'percent', false),
        level: number(1, 1000),
        jobLevel: number(1, 1000),
        zeny: number(0, MACRO_LIMITS.maxId),
        elapsedSeconds: number(0, 86400, 'seconds', false),
      };
      const schema =
        schemas[field] ??
        fail(
          'Unknown observation. Use hp, sp, weight, level, job-level, zeny, elapsed, map, inventory or actor.',
          reader.line,
        );
      condition = {
        field,
        operator: readOperator(reader),
        value: reader.numeric(numericSchema(schema)),
      };
    }
  }
  reader.done();
  if (!validRoutineCondition(condition))
    fail('This observation does not support that comparison or value.', reader.line);
  return condition;
}
function readStep(command: string, reader: LineReader): MacroStep {
  let step: MacroStep;
  if (command === 'farm' || command === 'travel') {
    const map = reader.text();
    if (command === 'farm') {
      reader.expect('targets');
      const targets = reader.scalar(array(id, 64)) as number[];
      step = { type: 'farm', map, targets, timeoutSeconds: 300 };
    } else step = { type: 'travel', map, timeoutSeconds: 300 };
  } else if (command === 'use') {
    reader.expect('item');
    step = { type: 'useItem', itemId: reader.numeric(numericSchema(id)), timeoutSeconds: 30 };
  } else if (command === 'skill') {
    const skillId = reader.numeric(numericSchema(number(1, 32767)));
    reader.expect('level');
    const level = reader.numeric(numericSchema(number(1, 10)));
    const mode = reader.text();
    if (mode !== 'self' && mode !== 'target')
      fail('Skill mode must be self or target.', reader.line);
    step = { type: 'skill', skillId, level, mode, timeoutSeconds: 30 };
  } else if (command === 'buy' || command === 'store') {
    const itemId = reader.numeric(numericSchema(id));
    reader.expect('quantity');
    const quantity = reader.numeric(numericSchema(number(1, 100_000)));
    let keep = 0;
    if (command === 'store') {
      reader.expect('keep');
      keep = reader.numeric(numericSchema(number(0, 100_000)));
      reader.expect('at');
    } else reader.expect('from');
    const serviceId = reader.text();
    reader.expect('spend');
    const maxSpend = reader.numeric(numericSchema(number(0, MACRO_LIMITS.maxSpend)));
    step =
      command === 'buy'
        ? { type: 'buy', itemId, quantity, serviceId, maxSpend, timeoutSeconds: 600 }
        : { type: 'store', itemId, quantity, keep, serviceId, maxSpend, timeoutSeconds: 600 };
  } else
    return fail('Unknown action. Use farm, travel, use item, skill, buy or store.', reader.line);
  if (reader.remaining) {
    reader.expect('timeout');
    step.timeoutSeconds = reader.numeric(
      numericSchema(seconds(1, step.type === 'useItem' || step.type === 'skill' ? 120 : 86400)),
    );
  }
  reader.done();
  if (!validMacroStep(step))
    fail(
      'Invalid action. Check map/target IDs, supported skill mode and NPC service type.',
      reader.line,
    );
  return step;
}
function validateDocumentResult(
  document: BotScriptDocumentInput,
  line: number,
): Result<BotScriptDocument, unknown> {
  return gen(function* () {
    const settings = yield* tryResult(() => checkedSettings(document.settings, line));
    const script = yield* tryResult({
      try: () => (document.script === null ? null : validateMacroScript(document.script)),
      catch: (error) =>
        new BotScriptError(error instanceof Error ? error.message : 'Invalid rules.', line),
    });
    yield* tryResult(() => {
      if (
        script &&
        utf8.encode(JSON.stringify({ script, settings })).length > BOT_SCRIPT_LIMITS.requestBytes
      ) {
        fail('Compiled configuration is too large.', line);
      }
    });
    return { settings, script };
  });
}
function validateDocument(document: BotScriptDocumentInput, line: number): BotScriptDocument {
  return getOrThrowWith(validateDocumentResult(document, line), identity);
}

/** Compile data into existing settings/actions. Admission never executes a command. */
export function parseBotScriptResult(
  text: string,
  legacySettings: SettingsInput = DEFAULT_SETTINGS,
): Result<BotScriptDocument, unknown> {
  return flatMap(
    tryResult(() => {
      if (typeof text !== 'string' || utf8.encode(text).length > BOT_SCRIPT_LIMITS.authoringBytes)
        fail('Script source is too large.', 1);
      return text;
    }),
    (source) => {
      if (source.trimStart().startsWith('{')) {
        return mapError(
          flatMap(
            tryResult(() => validateMacroScript(JSON.parse(source))),
            (script) => validateDocumentResult({ settings: legacySettings, script }, 1),
          ),
          (error) =>
            error instanceof BotScriptError
              ? error
              : new BotScriptError(
                  error instanceof SyntaxError
                    ? 'Invalid legacy JSON. Correct it before converting.'
                    : error instanceof Error
                      ? error.message
                      : 'Invalid legacy macro.',
                  1,
                ),
        );
      }
      return flatMap(
        tryResult(() => readBotScript(source)),
        (parsed) => validateDocumentResult(parsed.document, parsed.line),
      );
    },
  );
}
export function parseBotScript(
  text: string,
  legacySettings: SettingsInput = DEFAULT_SETTINGS,
): BotScriptDocument {
  return getOrThrowWith(parseBotScriptResult(text, legacySettings), identity);
}
function readBotScript(text: string): { document: BotScriptDocumentInput; line: number } {
  const lines = text.split(/\r?\n/);
  if (lines.length > BOT_SCRIPT_LIMITS.lines) fail('Script has too many lines.', 1);
  const settings: Record<string, unknown> = {},
    assignments: SettingAssignment[] = [];
  const script: MacroScript = {
    version: 1,
    name: '',
    durationSeconds: 3600,
    maxActions: 20,
    maxSpend: 0,
    rules: [],
  };
  const globals = new Map<string, number>();
  const stepLines = new Map<MacroStep, number>();
  let rule: MacroRule | null = null,
    ruleLine = 1,
    lastSettingLine = 1;
  let attributes = new Set<string>();
  for (const [index, source] of lines.entries()) {
    const line = index + 1,
      { code } = sourceLine(source, line);
    if (!code) continue;
    if (!script.name && !code.startsWith('script ')) fail('Begin with script "Name".', line);
    const assignment = /^set\s+(\S+)\s*=\s*(.*)$/.exec(code);
    if (assignment) {
      if (rule) fail('Put settings outside rule blocks.', line);
      const parts = pathParts(assignment[1]!, line),
        schema = schemaAt(parts, line);
      if (
        assignments.some((previous) => {
          const shorter = Math.min(parts.length, previous.parts.length);
          return parts.slice(0, shorter).every((part, i) => part === previous.parts[i]);
        })
      )
        fail('A setting path may be assigned only once, without overlapping parent paths.', line);
      const reader = new LineReader(tokens(assignment[2]!, line), line);
      const predicateValue = parts.at(-1) === 'value' && parts.includes('conditions');
      assignSetting(settings, parts, reader.scalar(schema, predicateValue));
      reader.done();
      assignments.push({ parts, line });
      lastSettingLine = line;
      continue;
    }
    const reader = new LineReader(tokens(code, line), line),
      command = reader.text();
    if (command === 'script') {
      if (script.name || rule) fail('Use only one script header.', line);
      script.name = reader.text(true);
      reader.done();
      if (
        !script.name.trim() ||
        script.name.length > 64 ||
        /[\u0000-\u001f\u007f]/.test(script.name)
      )
        fail('Use a script name of 1 to 64 printable characters.', line);
    } else if (command === 'rule') {
      if (rule) fail('Close the previous rule with end.', line);
      if (script.rules.length >= MACRO_LIMITS.rules) fail('Keep at most 32 rules.', line);
      const name = reader.text(true);
      reader.done();
      if (!name.trim() || name.length > 64 || /[\u0000-\u001f\u007f]/.test(name))
        fail('Use a rule name of 1 to 64 printable characters.', line);
      if (script.rules.some((previous) => previous.name === name))
        fail('Rule names must be unique.', line);
      rule = { name, priority: 0, cooldownSeconds: 0, maxRuns: 1, conditions: [], steps: [] };
      ruleLine = line;
      attributes = new Set();
      script.rules.push(rule);
    } else if (command === 'end') {
      reader.done();
      if (!rule) fail('end needs an open rule.', line);
      if (!rule.conditions.length) fail('Add at least one when condition to this rule.', ruleLine);
      if (!rule.steps.length) fail('Add at least one action to this rule.', ruleLine);
      rule = null;
    } else if (['duration', 'actions', 'spend'].includes(command)) {
      if (rule) fail('Put script limits outside rule blocks.', line);
      if (globals.has(command)) fail(`Set ${command} only once.`, line);
      globals.set(command, line);
      if (command === 'duration')
        script.durationSeconds = reader.numeric(
          numericSchema(number(0, 86400, 'seconds', true, true)),
        );
      else if (command === 'actions')
        script.maxActions = reader.numeric(numericSchema(number(0, 1000, 'number', true, true)));
      else script.maxSpend = reader.numeric(numericSchema(number(0, MACRO_LIMITS.maxSpend)));
      reader.done();
    } else if (!rule) fail('Unknown command. Use set, duration, actions, spend or rule.', line);
    else if (['priority', 'cooldown', 'runs'].includes(command)) {
      if (attributes.has(command)) fail(`Set rule ${command} only once.`, line);
      attributes.add(command);
      if (command === 'priority')
        rule.priority = reader.numeric(numericSchema(number(-1000, 1000)));
      else if (command === 'cooldown')
        rule.cooldownSeconds = reader.numeric(numericSchema(seconds(0, 86400)));
      else rule.maxRuns = reader.numeric(numericSchema(number(0, 1000, 'number', true, true)));
      reader.done();
    } else if (command === 'when') {
      if (rule.conditions.length >= MACRO_LIMITS.conditions)
        fail('Keep at most 16 conditions per rule.', line);
      rule.conditions.push(readCondition(reader));
    } else {
      if (rule.steps.length >= MACRO_LIMITS.stepsPerRule)
        fail('Keep at most 16 actions per rule.', line);
      const step = readStep(command, reader);
      rule.steps.push(step);
      stepLines.set(step, line);
    }
  }
  if (!script.name) fail('Begin with script "Name".', 1);
  if (rule) fail('Close this rule with end.', ruleLine);
  if (!script.rules.length && globals.size) {
    fail(
      'Macro limits require a rule. For an ordinary field time limit, use set automation.limits.minutes = 1m.',
      globals.values().next().value!,
    );
  }
  for (const step of stepLines.keys()) {
    if ('maxSpend' in step && step.maxSpend > script.maxSpend)
      fail('Action spend exceeds the script spend limit.', stepLines.get(step)!);
  }
  return {
    document: {
      settings: hydrate(settings, settingsSchema, lastSettingLine) as Settings,
      script: script.rules.length ? script : null,
    },
    line: lastSettingLine,
  };
}

function settingLines(settings: SettingsInput): string[] {
  const result: string[] = [];
  function visit(value: unknown, path: string, schema: Schema): void {
    if (value === undefined) return;
    if (
      Array.isArray(value) &&
      value.length &&
      schema.kind === 'array' &&
      schema.item.kind === 'object'
    ) {
      value.forEach((entry, index) => visit(entry, `${path}[${index}]`, schema.item));
    } else if (
      value !== null &&
      !Array.isArray(value) &&
      typeof value === 'object' &&
      schema.kind === 'object'
    ) {
      for (const [key, entry] of Object.entries(value))
        visit(entry, path ? `${path}.${key}` : key, schema.fields[key]!);
    } else {
      const suffix =
        typeof value === 'number' && schema.kind === 'number'
          ? schema.unit === 'percent'
            ? '%'
            : schema.unit === 'seconds'
              ? 's'
              : schema.unit === 'minutes'
                ? 'm'
                : ''
          : '';
      result.push(`set ${path} = ${JSON.stringify(value)}${suffix}`);
    }
  }
  visit(settings, '', settingsSchema);
  return result;
}
const operatorSymbols: Record<string, string> = {
  lt: '<',
  lte: '<=',
  eq: '==',
  gte: '>=',
  gt: '>',
  ne: '!=',
};
function formatCondition(condition: RoutineCondition): string {
  const operator = operatorSymbols[condition.operator];
  if ('actor' in condition) {
    const actor =
      condition.actor.scope === 'actor'
        ? `${condition.actor.id} world ${JSON.stringify(condition.actor.world)} incarnation ${condition.actor.incarnation}`
        : condition.actor.scope;
    const property =
      condition.field === 'actorStatus'
        ? `status ${condition.statusId}`
        : condition.field === 'actorCasting'
          ? `casting${condition.skillId === undefined ? '' : ` skill ${condition.skillId}`}`
          : condition.field === 'actorHpPercent'
            ? 'hp'
            : 'sp';
    return `when actor ${actor} ${property} ${operator} ${condition.value}${typeof condition.value === 'number' ? '%' : ''}`;
  }
  const field =
    condition.field === 'inventory'
      ? `inventory ${condition.itemId}`
      : (Object.entries(fieldNames).find(([, value]) => value === condition.field)?.[0] ??
        condition.field);
  return `when ${field} ${operator} ${condition.field === 'map' ? JSON.stringify(condition.value) : condition.value}${condition.field.endsWith('Percent') ? '%' : condition.field === 'elapsedSeconds' ? 's' : ''}`;
}
function formatStep(step: MacroStep): string {
  const timeout = ` timeout ${step.timeoutSeconds}s`;
  switch (step.type) {
    case 'farm':
      return `farm ${step.map} targets ${JSON.stringify(step.targets)}${timeout}`;
    case 'travel':
      return `travel ${step.map}${timeout}`;
    case 'useItem':
      return `use item ${step.itemId}${timeout}`;
    case 'skill':
      return `skill ${step.skillId} level ${step.level} ${step.mode}${timeout}`;
    case 'buy':
      return `buy ${step.itemId} quantity ${step.quantity} from ${step.serviceId} spend ${step.maxSpend}${timeout}`;
    case 'store':
      return `store ${step.itemId} quantity ${step.quantity} keep ${step.keep} at ${step.serviceId} spend ${step.maxSpend}${timeout}`;
  }
}
/** Explicit canonical conversion; use replaceBotScriptSettings for ordinary form synchronization. */
export function formatBotScript(input: BotScriptDocumentInput): string {
  const document = validateDocument(input, 1),
    script = document.script;
  const lines = [
    `script ${JSON.stringify(script?.name ?? 'My bot')}`,
    ...settingLines(document.settings),
  ];
  if (script) {
    lines.push(
      '',
      `duration ${script.durationSeconds}s`,
      `actions ${script.maxActions}`,
      `spend ${script.maxSpend}`,
    );
    for (const rule of script.rules) {
      lines.push(
        '',
        `rule ${JSON.stringify(rule.name)}`,
        `  priority ${rule.priority}`,
        `  cooldown ${rule.cooldownSeconds}s`,
        `  runs ${rule.maxRuns}`,
        ...map(rule.conditions, (condition) => `  ${formatCondition(condition)}`),
        ...map(rule.steps, (step) => `  ${formatStep(step)}`),
        'end',
      );
    }
  }
  const text = `${lines.join('\n')}\n`;
  if (
    utf8.encode(text).length > BOT_SCRIPT_LIMITS.authoringBytes ||
    lines.length > BOT_SCRIPT_LIMITS.lines
  )
    fail('Converted script source is too large.', 1);
  return text;
}

/** Preserve rule/limit spelling and comments while replacing the settings view. Invalid drafts never change. */
export function updateBotScriptSettings(
  text: string,
  settings: SettingsInput,
): { text: string; document: BotScriptDocument } {
  const { original, checked } = getOrThrowWith(
    flatMap(parseBotScriptResult(text, settings), (original) =>
      mapResult(
        tryResult(() => checkedSettings(settings, 1)),
        (checked) => ({ original, checked }),
      ),
    ),
    identity,
  );
  if (text.trimStart().startsWith('{')) {
    const document = { ...original, settings: checked };
    return { text: formatBotScript(document), document };
  }
  const replacements = settingLines(checked),
    newline = text.includes('\r\n') ? '\r\n' : '\n';
  const result: string[] = [];
  let inserted = false;
  for (const [index, source] of text.split(/\r?\n/).entries()) {
    const { code, comment } = sourceLine(source, index + 1);
    if (/^set\s/.test(code)) {
      if (!inserted) {
        result.push(...replacements);
        inserted = true;
      }
      if (comment) result.push(`${source.match(/^\s*/)?.[0] ?? ''}${comment}`);
    } else {
      result.push(source);
      if (!inserted && /^script\s/.test(code)) {
        result.push(...replacements);
        inserted = true;
      }
    }
  }
  const updated = result.join(newline);
  return { text: updated, document: parseBotScript(updated) };
}

/** String-only adapter for callers that do not retain a compiled document. */
export function replaceBotScriptSettings(text: string, settings: SettingsInput): string {
  return updateBotScriptSettings(text, settings).text;
}
