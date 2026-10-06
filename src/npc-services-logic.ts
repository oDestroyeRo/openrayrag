import { allPass, filter } from 'remeda';
import { DEFAULT_MAP_POLICY, validateMapPolicy, type MapPolicyInput as MapPolicy } from './map-policy-logic';
import { type ActionIdentity } from './actor-identity';
import catalog from './data/npc-services.json';
import { distance, publishedGrid } from './navigation-logic';
import type { Entity, Position } from './protocol';
import { validateWorkflowSpec, type WorkflowContext, type WorkflowReceipt, type WorkflowStep } from './workflows-logic';
export type ServiceOutcome =
  | { type: 'storageOpened'; timeoutMs: number }
  | { type: 'arrival'; map: string; position: Position; timeoutMs: number }
  | { type: 'shopOpened'; mode: 'buy' | 'sell'; timeoutMs: number };

export interface NpcServiceDefinition {
  version: 1;
  id: string;
  name: string;
  contractId: string;
  sourcePin: string;
  sourcePath: string;
  map: string;
  identity: { kind: 2; name: string; anchor: Position; maxDisplacement: number };
  approach: Position & { halfWidth: number; halfHeight: number; interactionRange: number };
  basicSkillLevel: number;
  workflow: {
    maxSpend: number;
    minStock: { itemId: number; count: number }[];
    timeoutMs: number;
    steps: WorkflowStep[];
  };
  outcome: ServiceOutcome;
}

const object = (v: unknown, keys: string[]): Record<string, unknown> => {
  if (
    !v ||
    typeof v !== 'object' ||
    Array.isArray(v) ||
    Object.keys(v).length !== keys.length ||
    Object.keys(v).some((k) => !keys.includes(k))
  )
    throw new Error('Invalid service fields.');
  return v as Record<string, unknown>;
};

const integer = (v: unknown, min: number, max: number): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new Error('Invalid service number.');
  return v;
};

const text = (v: unknown, max: number): string => {
  if (typeof v !== 'string' || !v.trim() || v.length > max || /[\u0000-\u001f\u007f]/.test(v))
    throw new Error('Invalid service text.');
  return v;
};

const point = (v: unknown): Position => {
  const p = object(v, ['x', 'y']);
  return { x: integer(p.x, 0, 511), y: integer(p.y, 0, 511) };
};

const code = (v: unknown): string => {
  const s = text(v, 64);
  if (!/^[a-zA-Z0-9_-]+$/.test(s)) throw new Error('Invalid service identifier.');
  return s;
};

export const inside = (p: Position, a: NpcServiceDefinition['approach']): boolean =>
  Math.abs(p.x - a.x) <= a.halfWidth && Math.abs(p.y - a.y) <= a.halfHeight;

/** Portable configuration only. Conversation state, entity IDs and bag IDs are deliberately absent. */
export function validateServiceDefinition(input: unknown): NpcServiceDefinition {
  if (new TextEncoder().encode(JSON.stringify(input)).length > 65_536)
    throw new Error('Service definition is too large.');
  const s = object(input, [
    'version',
    'id',
    'name',
    'contractId',
    'sourcePin',
    'sourcePath',
    'map',
    'identity',
    'approach',
    'basicSkillLevel',
    'workflow',
    'outcome',
  ]);
  if (s.version !== 1) throw new Error('Unsupported service version.');
  const map = code(s.map),
    grid = publishedGrid(map);
  if (!grid) throw new Error('Unsupported service map.');
  const identity = object(s.identity, ['kind', 'name', 'anchor', 'maxDisplacement']);
  if (identity.kind !== 2) throw new Error('Services require an NPC actor.');
  const anchor = point(identity.anchor),
    maxDisplacement = integer(identity.maxDisplacement, 0, 2);
  const a = object(s.approach, ['x', 'y', 'halfWidth', 'halfHeight', 'interactionRange']);
  const approach = {
    x: integer(a.x, 0, 511),
    y: integer(a.y, 0, 511),
    halfWidth: integer(a.halfWidth, 0, 4),
    halfHeight: integer(a.halfHeight, 0, 4),
    interactionRange: integer(a.interactionRange, 1, 5),
  };
  for (let y = approach.y - approach.halfHeight; y <= approach.y + approach.halfHeight; y++)
    for (let x = approach.x - approach.halfWidth; x <= approach.x + approach.halfWidth; x++) {
      if (
        !grid.walkable({ x, y }) ||
        distance({ x, y }, anchor) + maxDisplacement > approach.interactionRange ||
        grid.portals?.some((p) => Math.abs(x - p.x) <= p.halfWidth && Math.abs(y - p.y) <= p.halfHeight)
      )
        throw new Error('Service approach must be walkable, outside portals and in interaction range.');
    }
  const w = object(s.workflow, ['maxSpend', 'minStock', 'timeoutMs', 'steps']);
  const workflow = validateWorkflowSpec({ name: text(s.name, 64), map, npcId: 1, ...w });
  if (workflow.steps.some((step) => !['talk', 'advance', 'option'].includes(step.type)))
    throw new Error('Reusable service steps cannot persist item or bag selections.');
  const outcomeType = (s.outcome as { type?: unknown })?.type;
  const o = object(
    s.outcome,
    outcomeType === 'arrival'
      ? ['type', 'map', 'position', 'timeoutMs']
      : outcomeType === 'shopOpened'
        ? ['type', 'mode', 'timeoutMs']
        : ['type', 'timeoutMs'],
  );
  let outcome: ServiceOutcome;
  const timeoutMs = integer(o.timeoutMs, 1000, 60_000);
  if (o.type === 'storageOpened') outcome = { type: o.type, timeoutMs };
  else if (o.type === 'arrival') {
    const destination = code(o.map),
      position = point(o.position);
    if (!publishedGrid(destination)?.walkable(position))
      throw new Error('Service arrival needs a supported walkable cell.');
    outcome = { type: o.type, map: destination, position, timeoutMs };
  } else if (o.type === 'shopOpened' && (o.mode === 'buy' || o.mode === 'sell'))
    outcome = { type: o.type, mode: o.mode, timeoutMs };
  else throw new Error('Unsupported service outcome.');
  const sourcePin = text(s.sourcePin, 40);
  if (!/^[a-f0-9]{40}$/.test(sourcePin)) throw new Error('Invalid service source pin.');
  return {
    version: 1,
    id: code(s.id),
    name: workflow.name,
    contractId: text(s.contractId, 128),
    sourcePin,
    sourcePath: text(s.sourcePath, 256),
    map,
    identity: { kind: 2, name: text(identity.name, 128), anchor, maxDisplacement },
    approach,
    basicSkillLevel: integer(s.basicSkillLevel, 0, 10),
    workflow: {
      maxSpend: workflow.maxSpend,
      minStock: workflow.minStock,
      steps: workflow.steps,
      timeoutMs: workflow.timeoutMs!,
    },
    outcome,
  };
}

export const BUILTIN_SERVICES: readonly NpcServiceDefinition[] = catalog.contracts.map(validateServiceDefinition);

export const SERVICE_SOURCE = catalog.source;

export function serviceByContractId(contractId: string): NpcServiceDefinition | null {
  const definition = BUILTIN_SERVICES.find((service) => service.contractId === contractId);
  return definition ? validateServiceDefinition(definition) : null;
}

function contractFields(s: NpcServiceDefinition): unknown {
  return {
    version: s.version,
    contractId: s.contractId,
    sourcePin: s.sourcePin,
    sourcePath: s.sourcePath,
    map: s.map,
    identity: s.identity,
    approach: s.approach,
    basicSkillLevel: s.basicSkillLevel,
    steps: s.workflow.steps,
    outcome: s.outcome,
  };
}

export function serviceAvailability(s: NpcServiceDefinition): string | null {
  const known = BUILTIN_SERVICES.find((k) => k.contractId === s.contractId);
  return !known
    ? 'No verified adapter for this service contract.'
    : JSON.stringify(contractFields(s)) !== JSON.stringify(contractFields(known))
      ? 'This edited contract differs from the verified source and is unavailable.'
      : null;
}

export function validateServiceRequest(input: unknown): NpcServiceDefinition {
  const s = validateServiceDefinition(input),
    reason = serviceAvailability(s);
  if (reason) throw new Error(reason);
  return s;
}

export type ServiceResolution =
  | { state: 'missing' | 'ambiguous'; reason: string }
  | { state: 'resolved'; actor: Entity; reason: string };

export function resolveServiceNpc(s: NpcServiceDefinition, map: string, actors: readonly Entity[]): ServiceResolution {
  if (map !== s.map) return { state: 'missing', reason: `Enter ${s.map} before resolving this NPC.` };
  const matches = filter(actors, allPass([
    (actor: Entity) => actor.kind === 2,
    actor => !actor.dead,
    actor => actor.name === s.identity.name,
    actor => distance(actor, s.identity.anchor) <= s.identity.maxDisplacement,
  ]));
  if (matches.length > 1)
    return { state: 'ambiguous', reason: 'More than one visible NPC matches the service identity.' };
  return matches[0]
    ? { state: 'resolved', actor: { ...matches[0] }, reason: 'Fresh NPC identity resolved.' }
    : { state: 'missing', reason: 'Waiting for the exact NPC to become visible at its verified anchor.' };
}

export interface ServiceContext extends WorkflowContext {
  player: Entity | undefined;
  actors: readonly Entity[];
  connection: number;
  inventoryKnown: boolean;
}

export interface ServiceSnapshot {
  state:
    | 'idle'
    | 'preparing'
    | 'travel'
    | 'approach'
    | 'locate'
    | 'conversation'
    | 'outcome'
    | 'complete'
    | 'failed'
    | 'cancelled';
  active: boolean;
  name: string;
  contractId: string;
  reason: string;
  step: number;
  total: number;
  spent: number;
  npcId: number | null;
}

export interface ServiceReceipt {
  actorIdentity?:ActionIdentity;
  economic: WorkflowReceipt;
  map: string;
  generation: number;
  npcId: number;
  playerId: number;
  playerName: string;
  connection: number;
  outcome: ServiceOutcome | null;
  acknowledged: boolean;
  transition: boolean;
  arrived: boolean;
}

/** Execution policy is deliberately outside the source-matched portable definition. */
export function validateServiceExecution(input:unknown):{service:NpcServiceDefinition;executionPolicy:MapPolicy} {
  if(input&&typeof input==='object'&&!Array.isArray(input)&&Object.hasOwn(input,'service')){
    const request=object(input,['service','executionPolicy']);
    return {service:validateServiceRequest(request.service),executionPolicy:validateMapPolicy(request.executionPolicy)};
  }
  return {service:validateServiceRequest(input),executionPolicy:structuredClone(DEFAULT_MAP_POLICY)};
}

export interface ServicePreviewContext {
  map: string;
  player: Position | null;
  actors: readonly Entity[];
  inventoryKnown: boolean;
  zeny: number | null;
  basicSkillLevel: number | null;
  stock: Readonly<Record<string, number>>;
}
