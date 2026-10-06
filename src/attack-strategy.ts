import { map } from 'remeda';
import { foldConditions, unavailableFirstConditions } from './condition-logic';
import type { AttackStrategyRule, ReadonlyData } from './settings';
import type { ActorObservationSnapshot } from './actor-observations-logic';
import { actorPredicateEvaluator } from './actor-observations-logic';
import { castReadiness } from './cast-policy';
import type { CharacterState } from './character-state';

import { type EngagementIdentity, type Engagement, type StrategyChoice, type AttackStrategySnapshot, key } from './attack-strategy-logic';

export { type EngagementIdentity, type StrategyChoice, type AttackStrategySnapshot, engagementIdentity } from './attack-strategy-logic';

/** Per-incarnation allowances live independently of selected target and run
 * intent. Only actor/world invalidation releases them; Stop/Start never does.
 * This ledger sends no packets and never owns a second cast receipt. */
export class AttackStrategyPolicy {
  private readonly engagements=new Map<string,Engagement>();
  private pending:{identity:EngagementIdentity;ruleId:string;sequence:number}|null=null;
  private get(identity:EngagementIdentity):Engagement|null {
    const existing=this.engagements.get(key(identity));if(existing)return existing;
    if(this.engagements.size>=300)return null; // Never evict a live spent allowance.
    const value:Engagement={identity:{...identity},normalStarted:false,rules:new Map()};this.engagements.set(key(identity),value);return value;
  }
  reset():void {this.engagements.clear();this.pending=null;}
  remove(id:number):void {for(const [idKey,value] of this.engagements)if(value.identity.id===id)this.engagements.delete(idKey);if(this.pending?.identity.id===id)this.pending=null;}
  normalDispatched(identity:EngagementIdentity|null):void {if(identity){const value=this.get(identity);if(value)value.normalStarted=true;}}
  choose(rules:readonly ReadonlyData<AttackStrategyRule>[],identity:EngagementIdentity|null,speciesId:number,state:CharacterState,observations:ActorObservationSnapshot|undefined,now:number):StrategyChoice {
    if(!rules.some(rule=>rule.speciesIds.includes(speciesId)))return {state:'normal'};
    if(!identity)return {state:'wait',reason:'Attack strategy target identity is unavailable.'};
    const engagement=this.get(identity);
    if(!engagement)return {state:'wait',reason:'Attack strategy lifetime ledger is full; wait for actors to leave.'};
    const evaluate = actorPredicateEvaluator(observations);
    for(const rule of rules) {
      if(!rule.speciesIds.includes(speciesId)||rule.behavior==='opener'&&engagement.normalStarted)continue;
      const ledger=engagement.rules.get(rule.id);
      if(ledger?.uncertain)return {state:'wait',reason:`Strategy ${rule.id} has an unresolved cast; this target lifetime cannot be retried.`};
      if(ledger?.rejected || (ledger?.attempts??0)>=rule.maxAttempts || (ledger?.uses??0)>=rule.maxUses)continue;
      if(ledger?.lastDispatch!==null && ledger?.lastDispatch!==undefined && now-ledger.lastDispatch<rule.cooldownSeconds*1000) {
        if(rule.behavior==='opener')return {state:'wait',reason:`Waiting for opener ${rule.id} cooldown.`};
        continue;
      }
      const traces=map(rule.conditions??[], evaluate);
      const conditionState=foldConditions(traces,unavailableFirstConditions);
      if(conditionState==='unavailable')return {state:'wait',reason:`Strategy ${rule.id} actor conditions are unavailable.`};
      if(conditionState==='unmatched')continue;
      const ready=castReadiness(rule.skillId,rule.level,state,observations);
      if(ready.state!=='ready')return {state:'wait',reason:`Strategy ${rule.id}: ${ready.reason}`};
      if(!ledger&&engagement.rules.size>=32)return {state:'wait',reason:'Attack strategy rule ledger is full for this actor; use a fresh actor lifetime.'};
      return {state:'cast',rule,profile:ready.profile,identity:{...identity}};
    }
    return {state:'normal'};
  }
  dispatched(choice:Extract<StrategyChoice,{state:'cast'}>,sequence:number,now:number):void {
    if(this.pending)throw new Error('Attack strategy receipt is already owned.');
    const engagement=this.get(choice.identity);if(!engagement)throw new Error('Attack strategy lifetime is unavailable.');
    const ledger=engagement.rules.get(choice.rule.id)??{attempts:0,uses:0,lastDispatch:null,uncertain:false,rejected:false};
    ledger.attempts++;ledger.lastDispatch=now;ledger.uncertain=true;engagement.rules.set(choice.rule.id,ledger);
    this.pending={identity:choice.identity,ruleId:choice.rule.id,sequence};
  }
  settled(sequence:number,outcome:'confirmed'|'rejected'|'uncertain',identity:EngagementIdentity|null):void {
    const pending=this.pending;if(!pending||sequence!==pending.sequence)return;
    const ledger=this.engagements.get(key(pending.identity))?.rules.get(pending.ruleId);
    if(ledger) {
      if(outcome==='confirmed'&&identity&&key(identity)===key(pending.identity)){ledger.uses++;ledger.uncertain=false;}
      else if(outcome==='rejected'){ledger.rejected=true;ledger.uncertain=false;}
      // A cancel, expired deadline or changed lifetime never becomes success.
    }
    this.pending=null;
  }
  get pendingTarget():number|null {return this.pending?.identity.id??null;}
  cancel():void {this.pending=null;} // dispatch already wrote the uncertainty tombstone
  snapshot():AttackStrategySnapshot {
    const entries=[...this.engagements.values()];
    return {pending:!!this.pending,truncated:entries.length>8,entries:entries.slice(-8).map(value=>({...value.identity,normalStarted:value.normalStarted,rules:[...value.rules].slice(0,32).map(([id,rule])=>({id,attempts:rule.attempts,uses:rule.uses,uncertain:rule.uncertain,rejected:rule.rejected}))}))};
  }
}
