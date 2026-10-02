import type { Entity, GameEvent } from './protocol';
import { SUPPORTED_STATUS_IDS } from './actor-status-catalog';

export const ACTOR_OBSERVATION_LIMITS = { actors: 300, publishedActors: 64, publishedStatuses: 128, evaluatedStatuses:512, conditionReports:8, conditionsPerReport:4, conditions: 16, staleMs: 15_000 } as const;
export const PERMANENT_STATUS_SECONDS = Math.fround(3.4028234663852886e38);
export type ActorSelector = { scope: 'self' } | { scope: 'target' } | { scope: 'candidate' } | { scope: 'actor'; id: number; world: string; incarnation: number };
export type ActorPredicate =
  | { field: 'actorStatus'; actor: ActorSelector; statusId: number; operator: 'eq' | 'ne'; value: boolean }
  | { field: 'actorCasting'; actor: ActorSelector; skillId?: number; operator: 'eq' | 'ne'; value: boolean };
export interface PredicateTrace { condition: ActorPredicate; state: 'matched' | 'unmatched' | 'unavailable'; reason: string }
interface StatusObservation { id: number; known: boolean; present: boolean; observedAt: number; expiresAt: number | null }
interface CastObservation { state: 'unknown' | 'casting' | 'idle'; observedAt: number | null; deadline: number | null; skillId: number | null }
export interface ActorObservation {
  id: number; incarnation: number; kind: number; name: string; observedAt: number;
  statusesKnown: boolean; statuses: StatusObservation[]; cast: CastObservation;
}
export interface ActorObservationSnapshot {
  world: string; at: number; lastFrameAt: number | null; connected: boolean;
  selfId: number | null; targetId: number | null; candidateId?:number|null; truncated?:boolean; actors: ActorObservation[];
}
export interface ObservationContext { world: string; at: number; incarnation?: number }
interface RecordState extends Omit<ActorObservation, 'statuses'> { statuses: Map<number, StatusObservation> }
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/.test(v);
const integer = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, required: string[], optional: string[] = []) => required.every(key => Object.hasOwn(v,key)) && Object.keys(v).every(key => required.includes(key) || optional.includes(key));
export function validActorSelector(value: unknown): value is ActorSelector {
  if (!record(value)) return false;
  if (value.scope === 'self' || value.scope === 'target' || value.scope==='candidate') return keys(value,['scope']);
  return value.scope === 'actor' && keys(value,['scope','id','world','incarnation']) && uuid(value.world)
    && integer(value.id,0,0x7fffffff) && integer(value.incarnation,1,0x7fffffff);
}
export function validActorPredicate(value: unknown, allowCandidate=false): value is ActorPredicate {
  if (!record(value) || !validActorSelector(value.actor) || value.actor.scope==='candidate'&&!allowCandidate || (value.operator!=='eq'&&value.operator!=='ne') || typeof value.value !== 'boolean') return false;
  if (value.field === 'actorStatus') return keys(value,['field','actor','statusId','operator','value']) && integer(value.statusId,1,255);
  return value.field === 'actorCasting' && keys(value,['field','actor','operator','value'],['skillId'])
    && (!Object.hasOwn(value,'skillId') || integer(value.skillId,1,255));
}
export function validActorConditions(value: unknown, allowCandidate=false): value is ActorPredicate[] {
  return Array.isArray(value) && value.length <= ACTOR_OBSERVATION_LIMITS.conditions && value.every(condition=>validActorPredicate(condition,allowCandidate));
}
const clock = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
export function validActorSnapshot(value: unknown): value is ActorObservationSnapshot {
  if (!record(value) || !keys(value,['world','at','lastFrameAt','connected','selfId','targetId','actors'],['candidateId','truncated']) || !uuid(value.world) || !clock(value.at) || !(value.lastFrameAt === null || clock(value.lastFrameAt))
    || typeof value.connected !== 'boolean' || !(value.selfId === null || integer(value.selfId,0,0x7fffffff))
    || !(value.truncated===undefined||typeof value.truncated==='boolean')
    || !(value.candidateId===undefined||value.candidateId===null||integer(value.candidateId,0,0x7fffffff))
    || !(value.targetId === null || integer(value.targetId,0,0x7fffffff)) || !Array.isArray(value.actors) || value.actors.length > 64) return false;
  let statuses = 0;const actorIds=new Set<number>();
  return value.actors.every(actor => {
    if (!record(actor) || !keys(actor,['id','incarnation','kind','name','observedAt','statusesKnown','statuses','cast']) || !integer(actor.id,0,0x7fffffff) || !integer(actor.incarnation,1,0x7fffffff)
      || !integer(actor.kind,0,4) || typeof actor.name !== 'string' || actor.name.length > 64 || !clock(actor.observedAt)
      || typeof actor.statusesKnown !== 'boolean' || !Array.isArray(actor.statuses) || actor.statuses.length > 128
      || (statuses += actor.statuses.length) > 512 || !record(actor.cast)) return false;
    if(actorIds.has(actor.id))return false;actorIds.add(actor.id);
    const statusIds=new Set<number>();
    if(!actor.statuses.every(status=>{if(!record(status)||typeof status.id!=='number'||statusIds.has(status.id))return false;statusIds.add(status.id);return true;}))return false;
    const cast = actor.cast;
    if(!keys(cast,['state','observedAt','deadline','skillId']))return false;
    return (cast.state==='unknown'||cast.state==='casting'||cast.state==='idle') && (cast.observedAt === null || clock(cast.observedAt))
      && (cast.deadline === null || clock(cast.deadline)) && (cast.skillId === null || integer(cast.skillId,0,255))
      && actor.statuses.every(status => record(status) && keys(status,['id','known','present','observedAt','expiresAt']) && integer(status.id,1,255) && typeof status.known === 'boolean'
        && typeof status.present==='boolean' && clock(status.observedAt) && (status.expiresAt === null || clock(status.expiresAt)));
  });
}

export function evaluateActorPredicate(condition: ActorPredicate, snapshot: ActorObservationSnapshot | undefined): PredicateTrace {
  const trace = (state: PredicateTrace['state'], reason: string): PredicateTrace => ({ condition: structuredClone(condition), state, reason });
  if (!snapshot || !snapshot.connected || snapshot.lastFrameAt === null || snapshot.at < snapshot.lastFrameAt
    || snapshot.at - snapshot.lastFrameAt > ACTOR_OBSERVATION_LIMITS.staleMs) return trace('unavailable','Actor observations need a fresh connected world.');
  const selector = condition.actor;
  if (selector.scope === 'actor' && selector.world !== snapshot.world) return trace('unavailable','Observed actor belongs to an earlier world. Rebind this condition.');
  const id = selector.scope === 'self' ? snapshot.selfId : selector.scope === 'target' ? snapshot.targetId : selector.scope==='candidate'?snapshot.candidateId:selector.id;
  const actor = snapshot.actors.find(actor => actor.id === id);
  if(!actor&&snapshot.truncated)return trace('unavailable','Actor observations were truncated; inspect fewer actors.');
  if (!actor || (selector.scope === 'actor' && actor.incarnation !== selector.incarnation)) return trace('unavailable','Actor is absent or its lifetime changed. Rebind an observed actor.');
  if (actor.kind !== 0 && actor.kind !== 1) return trace('unavailable','Status and casting evidence is supported for players and monsters only.');
  if (actor.observedAt > snapshot.at) return trace('unavailable','Actor observation clock is unavailable.');
  let actual: boolean;
  if (condition.field === 'actorStatus') {
    if (!SUPPORTED_STATUS_IDS.has(condition.statusId)) return trace('unavailable','This status has no reliable visible add/remove contract.');
    const status = actor.statuses.find(status => status.id === condition.statusId);
    if (status && (!status.known || status.observedAt > snapshot.at || status.present && status.expiresAt!==null && snapshot.at>=status.expiresAt)) return trace('unavailable','Status refresh or predicted expiry is unresolved; wait for removal or a new snapshot.');
    if (!status && !actor.statusesKnown) return trace('unavailable','A complete supported status snapshot is unavailable.');
    actual = !!status?.present;
  } else {
    const cast = actor.cast;
    if (cast.state === 'unknown' || cast.observedAt === null || cast.observedAt > snapshot.at
      || cast.state === 'casting' && (cast.deadline === null || snapshot.at >= cast.deadline)) return trace('unavailable','Casting is unknown or its deadline ended without a completion observation.');
    actual = cast.state === 'casting' && (condition.skillId === undefined || condition.skillId === cast.skillId);
  }
  const matched = condition.operator === 'eq' ? actual === condition.value : actual !== condition.value;
  return trace(matched?'matched':'unmatched',matched?'Actor condition matched.':'Actor condition did not match.');
}
export function actorConditionsMatch(conditions: ActorPredicate[] | undefined, snapshot: ActorObservationSnapshot | undefined): boolean {
  return !conditions?.length || conditions.every(condition => evaluateActorPredicate(condition,snapshot).state === 'matched');
}
const unknownCast = (): CastObservation => ({state:'unknown',observedAt:null,deadline:null,skillId:null});

export class ActorObservations {
  private world: string;
  private nextIncarnation = 0;
  private lastFrameAt: number | null = null;
  private readonly actors = new Map<number,RecordState>();
  constructor(private readonly now = Date.now, private readonly newWorld = () => crypto.randomUUID()) { this.world = newWorld(); }
  context(id?: number): ObservationContext { return {world:this.world,at:this.now(),...(id!==undefined?{incarnation:this.actors.get(id)?.incarnation??0}:{})}; }
  frame(): void { const at=this.now(); if (this.lastFrameAt !== null && at < this.lastFrameAt) this.reset(); if (clock(at)) this.lastFrameAt=at; }
  reset(): void { this.world=this.newWorld();this.nextIncarnation=0;this.lastFrameAt=null;this.actors.clear(); }
  remove(id: number): void { this.actors.delete(id); }
  spawn(entity: Entity, selfId:number|null=null): void {
    if (entity.dead || (entity.kind===0||entity.kind===1)&&entity.hp <= 0) {this.remove(entity.id);return;}
    // Keep room for an announced own actor during loading/death. Filling that
    // slot with another actor must not prevent authoritative self revival.
    const limit=ACTOR_OBSERVATION_LIMITS.actors-(selfId!==null&&entity.id!==selfId&&!this.actors.has(selfId)?1:0);
    if (!this.actors.has(entity.id) && this.actors.size >= limit) return;
    const at=this.now();if(!clock(at)||this.nextIncarnation>=0x7fffffff){this.reset();return;} const statuses=new Map<number,StatusObservation>();
    for (const status of entity.statuses ?? []) if(SUPPORTED_STATUS_IDS.has(status.id)) statuses.set(status.id,this.status(status.id,status.seconds,at));
    this.actors.set(entity.id,{id:entity.id,incarnation:++this.nextIncarnation,kind:entity.kind,name:entity.name.slice(0,64),observedAt:at,
      statusesKnown:entity.statuses!==undefined,statuses,cast:unknownCast()});
  }
  private status(id: number, seconds: number, at: number): StatusObservation {
    const permanent=seconds===PERMANENT_STATUS_SECONDS;
    const deadline=at+Math.max(0,seconds)*1000;
    return {id,present:true,known:Number.isFinite(seconds)&&(permanent||clock(deadline)),observedAt:at,expiresAt:permanent?null:clock(deadline)?deadline:at};
  }
  apply(event: GameEvent, context=this.context()): void {
    if (context.world!==this.world || !clock(context.at) || context.at > this.now()) return;
    const id=event.type==='skillResult'?event.source:'id' in event?event.id:null;
    const actor=id===null?undefined:this.actors.get(id);
    if (!actor || context.at < actor.observedAt || context.incarnation!==undefined && context.incarnation!==actor.incarnation || (actor.kind!==0&&actor.kind!==1)) return;
    const at=context.at;
    if(event.type==='status' && SUPPORTED_STATUS_IDS.has(event.statusId)) {
      if(event.seconds===null) actor.statuses.set(event.statusId,{id:event.statusId,present:false,known:!event.refresh,observedAt:at,expiresAt:at});
      else actor.statuses.set(event.statusId,this.status(event.statusId,event.seconds,at));
      actor.observedAt=at;
    } else if(event.type==='castStart') {
      const deadline=at+event.remainingSeconds*1000;
      actor.cast=event.remainingSeconds>0&&clock(deadline)?{state:'casting',observedAt:at,deadline,skillId:event.skillId}:unknownCast();actor.observedAt=at;
    } else if(event.type==='castExtend') {
      actor.observedAt=at;
      if(actor.cast.state!=='casting'||actor.cast.deadline===null||at>=actor.cast.deadline) {actor.cast=unknownCast();return;}
      const deadline=actor.cast.deadline+event.deltaSeconds*1000;
      actor.cast=clock(deadline)&&deadline>at?{...actor.cast,observedAt:at,deadline}:unknownCast();actor.observedAt=at;
    } else if(event.type==='castStop' || event.type==='skillResult' && !event.indirect && actor.cast.state==='casting' && actor.cast.skillId===event.skillId) {
      actor.cast={state:'idle',observedAt:at,deadline:null,skillId:null};actor.observedAt=at;
    }
  }
  snapshot(selfId: number | null, targetId: number | null, connected: boolean, requested: ActorPredicate[]=[], includeRest=true,candidateId:number|null=null): ActorObservationSnapshot {
    const ids=new Set<number>([...(selfId!==null?[selfId]:[]),...(targetId!==null?[targetId]:[]),...(candidateId!==null?[candidateId]:[]),...requested.flatMap(p=>p.actor.scope==='actor'?[p.actor.id]:[]),...(includeRest?this.actors.keys():[])]);
    let remaining:number=includeRest?ACTOR_OBSERVATION_LIMITS.publishedStatuses:ACTOR_OBSERVATION_LIMITS.evaluatedStatuses;let truncated=false;
    const actors:ActorObservation[]=[];
    for(const id of ids) {
      const actor=this.actors.get(id);if(!actor)continue;
      const allStatuses=[...actor.statuses.values()];const complete=allStatuses.length<=remaining;const statuses=complete?allStatuses.map(s=>({...s})):[];
      truncated||=!complete;remaining-=statuses.length;actors.push({...actor,statusesKnown:complete&&actor.statusesKnown,statuses,cast:{...actor.cast}});
      if(actors.length>=ACTOR_OBSERVATION_LIMITS.publishedActors){truncated||=ids.size>actors.length;break;}
    }
    return {world:this.world,at:this.now(),lastFrameAt:this.lastFrameAt,connected,selfId,targetId,...(candidateId!==null?{candidateId}:{}),...(truncated?{truncated:true}:{}),actors};
  }
}

export interface PublishedConditionReport {rule:string;conditions:PredicateTrace[];truncated?:boolean}
export function publishConditionReports(reports:Array<{rule:string;conditions:PredicateTrace[]}>):PublishedConditionReport[] {
  const published:PublishedConditionReport[]=reports.slice(0,ACTOR_OBSERVATION_LIMITS.conditionReports).map(report=>({rule:report.rule,
    conditions:structuredClone(report.conditions.slice(0,ACTOR_OBSERVATION_LIMITS.conditionsPerReport)),
    ...(report.conditions.length>ACTOR_OBSERVATION_LIMITS.conditionsPerReport?{truncated:true}:{})}));
  if(reports.length>published.length)published.push({rule:`${reports.length-published.length} additional condition reports omitted.`,conditions:[],truncated:true});
  return published;
}
