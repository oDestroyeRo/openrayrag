import { macroBaseSettings } from '../automation/macro-ui-logic';
import { match } from 'effect/Result';
import { BotScriptError, BOT_SCRIPT_LIMITS, parseBotScriptResult } from '../settings/bot-script';
import { validateFormSettings, validateSettings, type SettingsInput } from '../settings/settings';
import type { FormSnapshot } from '../settings/settings-form-logic';
import type { BotProfile } from '../settings/profiles-logic';
import type { GameStatus } from '../client/game-status';
import { itemName, skillName } from '../catalog/game-catalog';

export const MCP_WRITE_TOOLS = [
  'set_settings',
  'set_script',
  'profile',
  'service_definition',
  'connect',
  'disconnect',
  'start_bot',
  'stop_bot',
  'apply_settings',
  'set_reconnect',
  'forget_login',
  'client_action',
] as const;
export type McpWriteTool = (typeof MCP_WRITE_TOOLS)[number];
export type McpTool =
  | 'get_status'
  | 'get_settings'
  | 'list_profiles'
  | 'validate_script'
  | 'get_client_state'
  | 'get_script'
  | 'list_services'
  | 'export_profile'
  | 'export_service'
  | 'get_operation'
  | 'preview_bot'
  | McpWriteTool;
export function mcpWriteTool(tool: McpTool): tool is McpWriteTool {
  return MCP_WRITE_TOOLS.some((candidate) => candidate === tool);
}
export interface McpQuery {
  id: string;
  tool: McpTool;
  arguments: Record<string, unknown>;
  runtimeGeneration: number;
}
export interface McpObservation {
  generation: number;
  sequence: number;
  observedAt: number;
}
export interface McpReadContext {
  now: number;
  runtimeGeneration: number;
  status: GameStatus | null;
  observation: McpObservation | null;
  gameOpen: boolean;
  runRequested: boolean;
  limitReason: string;
  updateBusy: boolean;
  updateContinuationPending: boolean;
  form: FormSnapshot | null;
  formInitialized: boolean;
  profiles: readonly BotProfile[];
  draftRevision?: number;
  script?: { script: string; dirty: boolean; unsaved: boolean } | null;
  services?: unknown;
  account?: {
    username: string;
    characterSlot: number;
    mode: string;
    remember: boolean;
    autoLogin: boolean;
    reconnect: boolean;
    savedPasswordAvailable: boolean;
  };
  controls?: {
    busy: boolean;
    ready: boolean;
    startReady: boolean;
    applyReady: boolean;
    disconnectReady: boolean;
  };
}

/** A tool query is fresh work; it does not refresh the underlying game observation. */
export function mcpObservation(context: McpReadContext) {
  const observation = context.observation;
  const matches = observation?.generation === context.runtimeGeneration;
  const ageMs = observation ? context.now - observation.observedAt : null;
  const state = !context.gameOpen
    ? 'disconnected'
    : !context.status || !matches
      ? 'unavailable'
      : !context.status.connected
        ? 'disconnected'
        : ageMs === null || ageMs < 0 || ageMs >= 7000
          ? 'stale'
          : 'current';
  return {
    state,
    runtimeGeneration: context.runtimeGeneration,
    observedAt: matches ? observation!.observedAt : null,
    sequence: matches ? observation!.sequence : null,
    ageMs: matches ? ageMs : null,
    staleAfterMs: 7000,
  };
}

function settings(value: SettingsInput): SettingsInput {
  return structuredClone(validateFormSettings(value));
}
export function mcpReadResult(query: McpQuery, context: McpReadContext): Record<string, unknown> {
  const observation = mcpObservation(context);
  const current = observation.state === 'current' ? context.status : null;
  if (query.tool === 'get_status')
    return {
      observation,
      connection: {
        mode: current?.connectionMode ?? null,
        connected: current?.connected ?? null,
        ready: current ? current.connected && current.compatible && !!current.player : null,
      },
      character: current?.player
        ? {
            name: current.player.name,
            level: current.player.level,
            hp: current.player.hp,
            maxHp: current.player.maxHp,
            x: current.player.x,
            y: current.player.y,
          }
        : null,
      map: current?.map ?? null,
      run: {
        requested:
          current?.runRequested ??
          (context.runRequested || context.updateContinuationPending ? true : null),
        retainedFieldRequested: context.runRequested,
        updateContinuationPending: context.updateContinuationPending,
        state: current?.state ?? null,
        reason: current?.reason ?? null,
        limitReason: context.limitReason || null,
        elapsedSeconds: current?.elapsedSeconds ?? null,
        kills: current?.kills ?? null,
        pickups: current?.looted ?? null,
        configuredLimits: current?.activeSettings?.automation?.limits
          ? structuredClone(current.activeSettings.automation.limits)
          : null,
      },
      receipts: {
        action: current
          ? {
              pending: current.task.pending,
              kind: current.task.kind,
              sequence: current.actionResult.sequence,
              status: current.actionResult.status,
              reason: current.actionResult.reason,
            }
          : null,
        settingsApply: current?.settingsApply
          ? {
              id: current.settingsApply.id,
              state: current.settingsApply.state,
              reason: current.settingsApply.reason,
              applied: [...current.settingsApply.applied],
              pending: [...current.settingsApply.pending],
              nextRun: [...current.settingsApply.nextRun],
            }
          : null,
      },
      updateMaintenance: context.updateBusy,
      unavailable: [
        'remainingRunBudgets',
        ...(current ? [] : ['gameplay', 'activeRunSettings', 'actionReceipts']),
      ],
    };
  if (query.tool === 'get_settings')
    return {
      observation,
      draftRevision: context.draftRevision ?? null,
      settingsForm: context.form
        ? {
            settings: settings(context.form.settings),
            selectedProfileId: context.form.selectedProfileId,
            revision: context.draftRevision ?? null,
            initialized: context.formInitialized,
            revisionMeaning:
              'Monotonic editable draft token; separate from persisted Form revision',
          }
        : null,
      activeRun: current?.activeSettings
        ? {
            settings: settings(current.activeSettings),
            runtimeGeneration: context.runtimeGeneration,
            settingsApplyId: current.settingsApply?.id ?? null,
            revision: null,
          }
        : null,
      unavailable: [
        ...(context.form ? [] : ['settingsForm']),
        ...(current?.activeSettings ? ['activeRunRevision'] : ['activeRun']),
      ],
    };
  if (query.tool === 'list_profiles')
    return {
      profiles: context.profiles.map((profile) => ({
        id: profile.id,
        name: profile.name,
        savedAt: profile.savedAt,
        settings: settings(profile.settings),
      })),
    };
  if (query.tool === 'get_script')
    return { draftRevision: context.draftRevision ?? null, ...context.script };
  if (query.tool === 'list_services') return { services: context.services ?? null };
  if (query.tool === 'get_client_state')
    return {
      observation,
      draftRevision: context.draftRevision ?? null,
      account: context.account ?? null,
      controls: context.controls ?? null,
      gameplay: current ? mcpGameplay(current) : null,
      unavailable: current
        ? ['characterResourceRevisions']
        : ['gameplay', 'characterResourceRevisions'],
    };
  const text = query.arguments.script;
  if (
    typeof text !== 'string' ||
    new TextEncoder().encode(text).length > BOT_SCRIPT_LIMITS.authoringBytes
  ) {
    return {
      valid: false,
      normalized: null,
      diagnostics: [{ line: 1, message: 'Script source is too large or missing.' }],
    };
  }
  const legacy = text.trimStart().startsWith('{');
  if (legacy && !context.form)
    return {
      valid: false,
      normalized: null,
      diagnostics: [{ line: null, message: 'The retained settings form is unavailable.' }],
    };
  return match(parseBotScriptResult(text, context.form?.settings), {
    onSuccess: (document) => {
      let startReady = true;
      const diagnostics: { line: number | null; message: string }[] = [];
      try {
        if (document.script) macroBaseSettings(document.settings, document.script);
        else validateSettings(document.settings);
      } catch (error) {
        startReady = false;
        diagnostics.push({
          line: null,
          message: error instanceof Error ? error.message : 'Settings are not ready for Start.',
        });
      }
      return {
        valid: true,
        startReady,
        normalized: structuredClone(document),
        diagnostics,
        legacyBaseline: text.trimStart().startsWith('{') ? 'retained settings form' : null,
      };
    },
    onFailure: (error) => ({
      valid: false,
      normalized: null,
      diagnostics: [
        {
          line: error instanceof BotScriptError ? error.line : null,
          message: error instanceof Error ? error.message : 'Invalid Bot script.',
        },
      ],
    }),
  });
}

type PublicShape = true | { readonly [key: string]: PublicShape } | readonly [PublicShape];
/** Each nested record is explicitly projected. Unknown extensions never become assistant data. */
function publicValue(value: unknown, shape: PublicShape): unknown {
  if (shape === true)
    return typeof value === 'string' ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
      ? value
      : null;
  if (Array.isArray(shape))
    return Array.isArray(value) ? value.map((item) => publicValue(item, shape[0]!)) : null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return Object.fromEntries(
    Object.entries(shape).map(([key, child]) => [
      key,
      publicValue((value as Record<string, unknown>)[key], child),
    ]),
  );
}
const point = { x: true, y: true } as const;
const actor = {
  ...point,
  id: true,
  name: true,
  kind: true,
  classId: true,
  level: true,
  hp: true,
  maxHp: true,
  dead: true,
} as const;
const item = {
  bagId: true,
  itemId: true,
  count: true,
  flags: true,
  refine: true,
  slots: [true],
  type: true,
} as const;
const phase = { state: true, reason: true, pending: true } as const;
const location = { ...point, map: true } as const;
const memoBinding = {
  ...location,
  world: true,
  actorId: true,
  incarnation: true,
  connectionEpoch: true,
  revision: true,
} as const;
const warpBinding = {
  ...memoBinding,
  generation: true,
  level: true,
  inventoryRevision: true,
  equipmentRevision: true,
  spRevision: true,
  skillsRevision: true,
} as const;
const socketTarget = {
  bagId: true,
  itemId: true,
  name: true,
  refine: true,
  slots: [true],
  capacity: true,
} as const;
const socketCard = { bagId: true, itemId: true, name: true, count: true, reserve: true } as const;
const gameplayShape: PublicShape = {
  sessionId: true,
  connectionId: true,
  connectionMode: true,
  connected: true,
  compatible: true,
  map: true,
  mapInfo: {
    code: true,
    name: true,
    source: true,
    monsters: [
      { classId: true, name: true, level: true, maxHp: true, spawnCount: true, visibleCount: true },
    ],
  },
  player: actor,
  actors: [actor],
  monsters: [actor],
  drops: [{ ...point, id: true, itemId: true, count: true }],
  actorObservations: {
    world: true,
    at: true,
    lastFrameAt: true,
    connected: true,
    selfId: true,
    targetId: true,
    candidateId: true,
    truncated: true,
    actors: [
      {
        id: true,
        incarnation: true,
        name: true,
        kind: true,
        observedAt: true,
        statusesKnown: true,
        statuses: [{ id: true, known: true, present: true, observedAt: true, expiresAt: true }],
        cast: { state: true, observedAt: true, deadline: true, skillId: true },
        hp: { value: true, max: true, at: true, source: true, reason: true },
        sp: { value: true, max: true, at: true, source: true, reason: true },
      },
    ],
  },
  character: {
    inventoryKnown: true,
    skillsKnown: true,
    inventory: [item],
    cart: [item],
    equipment: [true],
    ammoId: true,
    learned: [{ skillId: true, level: true }],
    granted: [{ skillId: true, level: true }],
    sitting: true,
    statuses: [{ id: true, seconds: true }],
    stats: {
      hp: true,
      maxHp: true,
      sp: true,
      maxSp: true,
      zeny: true,
      weight: true,
      maxWeight: true,
      cartWeight: true,
      level: true,
      jobLevel: true,
      statPoints: true,
      skillPoints: true,
      attributes: [true],
      attackDelay: true,
      combatStats: [true],
    },
  },
  world: {
    generation: true,
    revision: true,
    map: true,
    npc: { id: true, mode: true, dialog: { name: true, text: true, big: true }, options: [true] },
    shop: { mode: true, discountLevel: true, entries: [{ itemId: true, price: true }] },
    storage: [item],
    storageReady: true,
    cart: [item],
    hasCart: true,
    cartReady: true,
    barter: [{ item, count: true, zenyCost: true, required: [{ itemId: true, count: true }] }],
    party: {
      id: true,
      name: true,
      members: [
        {
          memberId: true,
          entityId: true,
          name: true,
          map: true,
          level: true,
          leader: true,
          hp: true,
          maxHp: true,
          sp: true,
          maxSp: true,
        },
      ],
    },
    invite: { partyId: true, name: true, sender: true },
    vending: { name: true, rows: [{ id: true, count: true, price: true }] },
    viewedVending: { id: true, name: true, entries: [{ item, price: true }] },
  },
  task: { kind: true, pending: true, reason: true },
  actionResult: { sequence: true, status: true, reason: true },
  navigation: { ready: true, mode: true, goal: point, routeLength: true },
  service: phase,
  workflow: { ...phase, step: true },
  routine: { ...phase, rule: true },
  macro: { ...phase, rule: true, step: true },
  social: {
    ...phase,
    generation: true,
    shoutWaitMs: true,
    emoteWaitMs: true,
    history: [
      {
        sequence: true,
        at: true,
        kind: true,
        direction: true,
        actorId: true,
        name: true,
        text: true,
        channel: true,
        emoteId: true,
        state: true,
      },
    ],
  },
  memo: {
    ...phase,
    blocked: true,
    generation: true,
    slots: [location],
    revision: true,
    ready: memoBinding,
    learnedWarp: true,
    unavailable: true,
  },
  socket: {
    ...phase,
    targets: [socketTarget],
    cards: [socketCard],
    preview: {
      targetBagId: true,
      cardBagId: true,
      previewToken: true,
      target: socketTarget,
      card: socketCard,
      slot: true,
      cost: true,
    },
  },
  warp: {
    ...phase,
    blocked: true,
    generation: true,
    ready: warpBinding,
    activation: { type: true, preview: warpBinding },
    preview: { type: true, slot: true, target: point, preview: warpBinding },
    slots: [location],
    cost: true,
    gems: true,
    reserve: true,
    selection: true,
    resourceEvidence: true,
    captured: { slot: true, ground: point, destination: location },
  },
  refine: {
    state: true,
    reason: true,
    blocked: true,
    dialogueToken: true,
    candidates: [{ bagId: true, itemId: true, name: true, refine: true }],
    preview: {
      token: true,
      targetBagId: true,
      itemId: true,
      name: true,
      startingRefine: true,
      oreItemId: true,
      zenyCost: true,
      failurePossible: true,
      npcId: true,
    },
  },
};
export function mcpGameplay(status: GameStatus): unknown {
  return publicNames(publicValue(status, gameplayShape));
}
function publicNames(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(publicNames);
  if (!value || typeof value !== 'object') return value;
  const fields = value as Record<string, unknown>;
  return Object.fromEntries([
    ...Object.entries(fields).map(([key, child]) => [key, publicNames(child)]),
    ...(typeof fields.itemId === 'number' ? [['name', itemName(fields.itemId)]] : []),
    ...(typeof fields.skillId === 'number' ? [['name', skillName(fields.skillId)]] : []),
  ]);
}

export function mcpObserved(value: unknown): McpObservation | null {
  if (!value || typeof value !== 'object') return null;
  const raw = (value as Record<string, unknown>).mcpObservation;
  if (!raw || typeof raw !== 'object') return null;
  const fields = raw as Record<string, unknown>;
  if (
    !['generation', 'sequence', 'observedAt'].every(
      (key) =>
        typeof fields[key] === 'number' &&
        Number.isSafeInteger(fields[key]) &&
        Number(fields[key]) >= 0,
    )
  )
    return null;
  return {
    generation: Number(fields.generation),
    sequence: Number(fields.sequence),
    observedAt: Number(fields.observedAt),
  };
}

/** Retain observation and gameplay as one accepted session; rejected terminal pages cannot refresh age. */
export function retainedMcpObservation(input: {
  status: unknown;
  previousSession: string | undefined;
  retained: McpObservation | null;
}): McpObservation | null {
  if (
    input.previousSession !== undefined &&
    input.status &&
    typeof input.status === 'object' &&
    (input.status as Record<string, unknown>).sessionId === input.previousSession
  )
    return input.retained;
  return mcpObserved(input.status);
}
