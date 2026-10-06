import {describe,it,expect} from 'vitest';
import {AttackStrategyPolicy,type EngagementIdentity} from './attack-strategy';
import {ActorObservations} from './actor-observations';
import {CharacterState} from './character-state';
import type {AttackStrategyRule} from './settings';
const actor={id:1,kind:0,classId:2,name:'Mage',level:10,hp:100,maxHp:100,x:2,y:2,dead:false,statuses:[]};
const a:EngagementIdentity={world:'11111111-1111-1111-1111-111111111111',id:2,incarnation:1};
const b:EngagementIdentity={...a,id:3,incarnation:2};
export const strategy:AttackStrategyRule={id:'open',speciesIds:[4000],skillId:11,level:1,behavior:'opener',maxAttempts:2,maxUses:1,cooldownSeconds:1};
function setup(){const state=new CharacterState();state.apply({type:'inventory',items:[],equipment:Array(10).fill(0),ammoId:-1},1);state.apply({type:'skills',learned:[{skillId:11,level:10},{skillId:12,level:10}]},1);state.apply({type:'stats',hp:100,maxHp:100,level:10,sp:200,maxSp:200},1);const observations=new ActorObservations(()=>1000);observations.spawn(actor);observations.frame();return {state,snapshot:observations.snapshot(1,null,true),ledger:new AttackStrategyPolicy()};}
describe('per-incarnation attack strategy ledger',()=>{
 it('uses ordered species rules and allows independent same-skill rules',()=>{const {state,snapshot,ledger}=setup();const other={...strategy,id:'other',speciesIds:[4001]};const second={...strategy,id:'second'};let choice=ledger.choose([other,strategy,second],a,4000,state,snapshot,1000);expect(choice.state).toBe('cast');if(choice.state!=='cast')throw Error();expect(choice.rule.id).toBe('open');ledger.dispatched(choice,1,1000);ledger.settled(1,'confirmed',a);choice=ledger.choose([other,strategy,second],a,4000,state,snapshot,2000);expect(choice.state==='cast'&&choice.rule.id).toBe('second');expect(ledger.choose([other],a,4000,state,snapshot,2000).state).toBe('normal');});
 it('counts dispatch attempts separately, retains A-B-A budgets and closes openers on actual normal dispatch',()=>{const {state,snapshot,ledger}=setup();const choose=(identity:EngagementIdentity)=>ledger.choose([strategy],identity,4000,state,snapshot,1000);const first=choose(a);expect(first.state).toBe('cast');expect(ledger.snapshot().entries[0]!.rules).toEqual([]);if(first.state!=='cast')throw Error();ledger.dispatched(first,1,1000);ledger.settled(1,'confirmed',a);expect(choose(b).state).toBe('cast');expect(choose(a).state).toBe('normal');ledger.normalDispatched(b);expect(choose(b).state).toBe('normal');expect(ledger.snapshot().entries[0]!.rules[0]).toMatchObject({attempts:1,uses:1});});
 it.each(['uncertain','rejected'] as const)('does not count %s as success or blindly retry the same rule',outcome=>{const {state,snapshot,ledger}=setup();const choice=ledger.choose([strategy],a,4000,state,snapshot,1000);if(choice.state!=='cast')throw Error();ledger.dispatched(choice,1,1000);ledger.settled(1,outcome,a);expect(ledger.snapshot().entries[0]!.rules[0]!.uses).toBe(0);expect(ledger.choose([strategy],a,4000,state,snapshot,2000).state).toBe(outcome==='uncertain'?'wait':'normal');});
 it('keeps canceled uncertainty through pauses and refuses late credit after actor reuse',()=>{const {state,snapshot,ledger}=setup();const choice=ledger.choose([strategy],a,4000,state,snapshot,1000);if(choice.state!=='cast')throw Error();ledger.dispatched(choice,1,1000);ledger.cancel();ledger.settled(1,'confirmed',a);expect(ledger.choose([strategy],a,4000,state,snapshot,2000).state).toBe('wait');ledger.remove(a.id);const reused={...a,incarnation:3};const next=ledger.choose([strategy],reused,4000,state,snapshot,2000);if(next.state!=='cast')throw Error();ledger.dispatched(next,2,2000);ledger.settled(1,'confirmed',a);expect(ledger.snapshot().entries[0]!.rules[0]!.uses).toBe(0);ledger.settled(2,'confirmed',a);expect(ledger.snapshot().entries[0]!.rules[0]!.uses).toBe(0);ledger.reset();expect(ledger.snapshot().entries).toEqual([]);});
 it('holds unknown opener prerequisites and skips known-false conditions deterministically',()=>{const {state,snapshot,ledger}=setup();const conditional={...strategy,conditions:[{field:'actorStatus' as const,actor:{scope:'target' as const},statusId:1,operator:'eq' as const,value:true}]};expect(ledger.choose([conditional],a,4000,state,snapshot,1000).state).toBe('wait');const falseCondition={...conditional,conditions:[{...conditional.conditions[0]!,actor:{scope:'self' as const}}]};expect(ledger.choose([falseCondition,strategy],a,4000,state,snapshot,1000).state).toBe('cast');});
 it('bounds live identities without evicting and reopening spent allowances',()=>{const {state,snapshot,ledger}=setup();for(let id=1;id<=300;id++)ledger.normalDispatched({...a,id});expect(ledger.choose([strategy],{...a,id:301},4000,state,snapshot,1000).state).toBe('wait');expect(ledger.choose([strategy],a,4000,state,snapshot,1000).state).toBe('normal');expect(ledger.snapshot().truncated).toBe(true);});
});

describe('strategy condition precedence', () => {
  it.each([false, true])('waits on unavailable evidence with a known false condition and reversed=%s', reverse => {
    const { state, snapshot, ledger } = setup();
    const conditional: AttackStrategyRule = { ...strategy, conditions: [
      { field: 'actorStatus', actor: { scope: 'self' }, statusId: 1, operator: 'eq', value: true },
      { field: 'actorCasting', actor: { scope: 'self' }, operator: 'eq', value: false },
    ] };
    if (reverse) conditional.conditions!.reverse();
    expect(ledger.choose([conditional, { ...strategy, id: 'fallback' }], a, 4000, state, snapshot, 1_000))
      .toEqual({ state: 'wait', reason: 'Strategy open actor conditions are unavailable.' });
  });
});
