import { mcpObservation, type McpQuery, type McpReadContext } from './mcp-logic';
import {
  featureObservation,
  featureWorkflowPreviewText,
  isAction,
} from '../client/feature-ui-logic';
import { validateWorkflowSpec } from '../services/workflows-logic';
import { dryRunRoutine, validateRoutineSpec } from '../automation/routines-logic';
import { dryRunMacro } from '../automation/macros-logic';
import { parseBotScript } from '../settings/bot-script';
import { DEFAULT_AUTOMATION, validateAutomation } from '../settings/settings';
import { mapPolicy } from '../navigation/map-policy-logic';
import { routeBetweenMapsAsync } from '../navigation/travel';
import { previewServiceAsync } from '../services/npc-services';
import { planDisposition, DEFAULT_DISPOSITION } from '../services/disposition';
import {
  dispositionContextFromStatus,
  dispositionStockFloors,
} from '../services/disposition-ui-logic';
import { previewSupplyTrip } from '../services/supply-plan';
import { isTalkNpc } from '../world/actor-interaction-logic';

/** Existing preview owners, with explicit stale evidence and a bounded planning lifetime. */
export async function mcpPreview(
  query: McpQuery,
  context: McpReadContext,
): Promise<Record<string, unknown>> {
  const request = query.arguments.request;
  if (!request || typeof request !== 'object' || Array.isArray(request))
    throw new Error('Invalid preview request.');
  const input = request as Record<string, unknown>,
    kind = query.arguments.kind;
  const current = mcpObservation(context).state === 'current' ? context.status : null;
  const status = current ? (current as unknown as Record<string, unknown>) : {};
  const observation = featureObservation(status, context.now);
  if (kind === 'workflow')
    return {
      valid: true,
      summary: featureWorkflowPreviewText(validateWorkflowSpec(input.spec)),
      sendsCommands: false,
    };
  if (kind === 'routine')
    return {
      valid: true,
      trace: dryRunRoutine(validateRoutineSpec(input.spec, isAction), observation, isAction),
      sendsCommands: false,
    };
  if (kind === 'macro') {
    if (typeof input.script !== 'string') throw new Error('Missing Bot script.');
    const document = parseBotScript(input.script, context.form?.settings);
    return {
      valid: true,
      trace: document.script ? dryRunMacro(document.script, observation) : null,
      sendsCommands: false,
    };
  }
  const settings = context.form?.settings;
  if (!settings) throw new Error('The retained settings Form is unavailable.');
  const automation = validateAutomation(settings.automation ?? DEFAULT_AUTOMATION);
  const disposition = {
    ...dispositionContextFromStatus(status),
    minimumStock: dispositionStockFloors(automation),
  };
  if (kind === 'disposition')
    return {
      plan: planDisposition(
        input.policy ?? automation.disposition ?? DEFAULT_DISPOSITION,
        disposition,
      ),
      sendsCommands: false,
    };
  if (kind === 'supply')
    return {
      summary: previewSupplyTrip(settings, {
        character: current?.player?.name ?? '',
        epoch: current?.sessionId ?? '',
        map: current?.map ?? '',
        position: current?.player
          ? { x: Math.floor(current.player.x), y: Math.floor(current.player.y) }
          : null,
        connected: current?.connected === true,
        alive: current?.player?.dead === false,
        fresh: !!current,
        settled: disposition.workflow.idle,
        canPrepare: false,
        fieldRequested: false,
        inventoryRevision: 0,
        currencyRevision: 0,
        economicUncertain: false,
        disposition,
      }),
      sendsCommands: false,
    };
  if (!current?.player || !current.connected || !current.compatible)
    throw new Error('A fresh verified character observation is required for planning.');
  const abort = new AbortController(),
    timer = setTimeout(() => abort.abort(), 4000);
  try {
    if (kind === 'route') {
      const policy = mapPolicy({ automation });
      const destination =
        input.destinationMap ?? policy.lockArea?.map ?? automation.travel.destinationMap;
      if (typeof destination !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(destination))
        throw new Error('Choose a valid destination map.');
      const route = await routeBetweenMapsAsync(
        current.map,
        { x: Math.floor(current.player.x), y: Math.floor(current.player.y) },
        destination,
        settings.route_avoidWalls,
        policy,
        { signal: abort.signal },
      );
      return { route, sendsCommands: false };
    }
    if (kind === 'service') {
      const character = current.character,
        stock: Record<string, number> = {};
      for (const item of character.inventory)
        stock[item.itemId] = (stock[item.itemId] ?? 0) + item.count;
      const preview = await previewServiceAsync(
        input.definition,
        {
          map: current.map,
          player: { x: current.player.x, y: current.player.y },
          actors: current.actors.filter(isTalkNpc),
          inventoryKnown: character.inventoryKnown,
          zeny: character.stats?.zeny ?? null,
          basicSkillLevel: character.skillsKnown
            ? (character.learned.find((skill) => skill.skillId === 1)?.level ?? 0)
            : null,
          stock,
        },
        mapPolicy({ automation }),
        { signal: abort.signal },
      );
      return { ...preview, sendsCommands: false };
    }
    throw new Error('Unknown preview kind.');
  } finally {
    clearTimeout(timer);
  }
}
