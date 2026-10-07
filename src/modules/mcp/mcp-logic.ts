import { macroBaseSettings } from '../automation/macro-ui-logic';
import { match } from 'effect/Result';
import { BotScriptError, BOT_SCRIPT_LIMITS, parseBotScriptResult } from '../settings/bot-script';
import { validateFormSettings, validateSettings, type SettingsInput } from '../settings/settings';
import type { FormSnapshot } from '../settings/settings-form-logic';
import type { BotProfile } from '../settings/profiles-logic';
import type { GameStatus } from '../client/game-status';

export type McpTool = 'get_status' | 'get_settings' | 'list_profiles' | 'validate_script';
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
      settingsForm: context.form
        ? {
            settings: settings(context.form.settings),
            selectedProfileId: context.form.selectedProfileId,
            revision: null,
            initialized: context.formInitialized,
            revisionMeaning: 'DOM draft; persisted revision unavailable',
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
