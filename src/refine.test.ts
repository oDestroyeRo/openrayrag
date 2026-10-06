import { itemId as domainItemId, quantity, revisionFor, incrementRevision } from './domain-values';
import { admitInventoryItem, type DomainInventoryItem } from './character-state-logic';
import {describe,it,expect} from 'vitest';
import {ManualRefine,refineMetadata,type RefineContext} from './refine';
import {DEFAULT_AUTOMATION} from './settings';
import type {GameEvent} from './protocol';
import type {InventoryItem} from './protocol-feature';
import type {RefinePacket} from './refine-protocol';
const item:InventoryItem={bagId:700,itemId:1201,type:2,count:1,flags:0,refine:0,guid:'01'.repeat(16),slots:[0,0,0,0]};
type FixtureItem = {-readonly [K in keyof Omit<DomainInventoryItem,'slots'>]: DomainInventoryItem[K]} & {slots?:number[]};
function fixtureItem(item:InventoryItem):FixtureItem {return {...admitInventoryItem(item),slots:item.slots?.slice()};}
const policy=structuredClone(DEFAULT_AUTOMATION);
function fixture(start=0,itemId=1201){let now=1000;const sent:RefinePacket[]=[];const target={...structuredClone(item),itemId,refine:start},meta=refineMetadata(domainItemId(itemId))!;
 const context:Omit<RefineContext,'inventory'|'equipment'> & {inventory:FixtureItem[]|null;equipment:number[]|null}={ready:true,settled:true,identity:'own-life',character:'Synthetic',readbackKey:'session-initialization',connection:revisionFor('connection',1),map:'prt_in',npcId:0,npcIdentity:'npc-life',npcGeneration:2,npcMode:'refine',promptToken:'bb'.repeat(16),
  inventory:[fixtureItem(target),fixtureItem({bagId:meta.oreItemId,itemId:meta.oreItemId,type:1,count:3})],equipment:Array(14).fill(0),zeny:100000,inventoryRevision:revisionFor('inventory',1),equipmentRevision:revisionFor('equipment',1),currencyRevision:revisionFor('currency',1),activityRevision:revisionFor('activity',1)};
 const owner=new ManualRefine(packet=>sent.push(packet),()=>now,()=> 'aa'.repeat(16));
 const input={targetBagId:target.bagId,catalystBagId:0 as const,policy,maxSpend:10000,minZeny:0};
 const preview=()=>{owner.preview(input,context);return{...input,previewToken:owner.snapshot(context).preview!.token};};
 const send=()=>owner.dispatch(preview(),context);
 const observe=(e:GameEvent)=>{if(e.type==='inventoryDelta'){const row=context.inventory!.find(row=>row.bagId===e.bagId);if(row)row.count=quantity(row.count-e.change);context.inventoryRevision=incrementRevision(context.inventoryRevision);}
  if(e.type==='inventoryItem'){const at=context.inventory!.findIndex(row=>row.bagId===e.item.bagId);if(at>=0)context.inventory![at]=fixtureItem(e.item);context.inventoryRevision=incrementRevision(context.inventoryRevision);}
  if(e.type==='currency'){context.zeny=e.zeny;context.currencyRevision=incrementRevision(context.currencyRevision);} owner.observe([e],context);};
 const ore=():GameEvent=>({type:'inventoryDelta',add:false,bagId:meta.oreItemId,change:1,weight:0});
 const currency=():GameEvent=>({type:'currency',zeny:100000-meta.zenyCost});
 const mutation=(delta=1):GameEvent=>({type:'inventoryItem',item:{...structuredClone(target),refine:start+delta}});
 return{owner,context,sent,input,target,meta,preview,send,observe,ore,currency,mutation,advance:(ms:number)=>{now+=ms;owner.tick(context);}};
}
describe('single no-catalyst refine owner',()=>{
 it.each([false,true])('confirms exact detached evidence in either receipt order (reverse=%s), including duplicate source currency',reverse=>{const f=fixture();f.send();expect(f.owner.snapshot(f.context).state).toBe('pending');
  const events=[f.ore(),f.currency(),f.currency(),f.mutation()];for(const e of reverse?events.reverse():events)f.observe(e);
  expect(f.owner.snapshot(f.context).state).toBe('improved');expect(f.sent).toEqual([{targetBagId:700,oreItemId:1010,catalystBagId:0}]);});
 it('distinguishes permitted downgrade and rejects a downgrade at a guaranteed source threshold',()=>{const risky=fixture(7);risky.send();risky.observe(risky.mutation(-1));risky.observe(risky.ore());risky.observe(risky.currency());expect(risky.owner.snapshot(risky.context).state).toBe('downgraded');
  const safe=fixture(1);safe.send();safe.observe(safe.ore());safe.observe(safe.currency());safe.observe(safe.mutation(-1));expect(safe.owner.snapshot(safe.context).state).toBe('uncertain');});
 it.each([1,2,3,4,0])('publishes correct rank %s resource and source threshold metadata',rank=>{const ids=[1201,1250,1119,1136,2101];const id=ids[rank===0?4:rank-1]!;const meta=refineMetadata(domainItemId(id))!;expect(meta.rank).toBe(rank);
  expect([meta.oreItemId,meta.zenyCost]).toEqual(({1:[1010,200],2:[1011,1000],3:[984,5000],4:[984,10000],0:[985,2000]} as Record<number,number[]>)[rank]);expect(meta.thresholds).toHaveLength(10);expect(meta.thresholds[0]).toBe(100);});
 it.each(['equipped','unknown','nonrefinable','plus10','guid','cards','missingOre','insufficientOre','budget','zeny','floor','reserve','dispositionBudget','mode','npc','unsettled','unready'] as const)('rejects %s before transport',kind=>{const f=fixture();
  if(kind==='equipped')f.context.equipment![12]=700;else if(kind==='unknown')f.context.inventory![0]!.itemId=domainItemId(999999);
  else if(kind==='nonrefinable')f.context.inventory![0]!.itemId=domainItemId(2601);else if(kind==='plus10')f.context.inventory![0]!.refine=10;
  else if(kind==='guid')delete f.context.inventory![0]!.guid;else if(kind==='cards')delete f.context.inventory![0]!.slots;
  else if(kind==='missingOre')f.context.inventory!.pop();else if(kind==='insufficientOre')f.context.inventory![1]!.count=quantity(0);
  else if(kind==='budget')f.input.maxSpend=199;else if(kind==='zeny')f.context.zeny=199;else if(kind==='reserve')f.input.minZeny=100000;
  else if(kind==='floor')f.input.policy={...structuredClone(policy),items:[{itemId:1010,resource:'hp',belowPercent:50,minStock:3,cooldownSeconds:1}]};
  else if(kind==='dispositionBudget')f.input.policy={...structuredClone(policy),disposition:{rules:[],maxSpend:199}};
  else if(kind==='mode')f.context.npcMode='dialog';else if(kind==='npc')f.context.npcIdentity=null;else if(kind==='unsettled')f.context.settled=false;else f.context.ready=false;
  expect(()=>f.send()).toThrow();expect(f.sent).toEqual([]);});
 it.each(['revision','sameRevisionMutation','policy','npcLife','ownLife','equipment','currency','npcGeneration','activity'] as const)('invalidates preview for %s',kind=>{const f=fixture(),request=f.preview();
  if(kind==='revision')f.context.inventoryRevision=incrementRevision(f.context.inventoryRevision);else if(kind==='sameRevisionMutation')f.context.inventory![0]!.slots![0]=4001;
  else if(kind==='policy')request.policy={...structuredClone(policy),items:[{itemId:1010,resource:'hp',belowPercent:50,minStock:1,cooldownSeconds:1}]};
  else if(kind==='npcLife')f.context.npcIdentity='new';else if(kind==='ownLife')f.context.identity='new';else if(kind==='equipment')f.context.equipmentRevision=incrementRevision(f.context.equipmentRevision);
  else if(kind==='currency')f.context.currencyRevision=incrementRevision(f.context.currencyRevision);else if(kind==='activity')f.context.activityRevision=incrementRevision(f.context.activityRevision);else f.context.npcGeneration++;
  expect(()=>f.owner.dispatch(request,f.context)).toThrow();expect(f.sent).toEqual([]);});
 it.each(['costOnly','wrongGuid','wrongCards','wrongFlags','wrongCount','wrongBag','wrongDelta','unchanged','extraDebit','duplicateMutation','duplicateOre'] as const)('does not confirm %s',kind=>{const f=fixture();f.send();f.observe(f.ore());f.observe(f.currency());
  const e=f.mutation();if(e.type!=='inventoryItem')throw new Error();
  if(kind==='wrongGuid')e.item.guid='02'.repeat(16);else if(kind==='wrongCards')e.item.slots![0]=4001;else if(kind==='wrongFlags')e.item.flags=1;else if(kind==='wrongCount')e.item.count=2;
  else if(kind==='wrongBag')e.item.bagId=701;else if(kind==='wrongDelta')e.item.refine=2;else if(kind==='unchanged')e.item.refine=0;
  else if(kind==='extraDebit')f.observe({type:'currency',zeny:99000});else if(kind==='duplicateOre')f.observe(f.ore());
  if(kind==='duplicateMutation'){const g=fixture();g.send();g.observe(g.mutation());g.observe(g.mutation());g.observe(g.ore());g.observe(g.currency());expect(g.owner.blocked).toBe(true);return;}
  if(kind!=='costOnly')f.observe(e);expect(f.owner.blocked).toBe(true);expect(f.owner.snapshot(f.context).state).not.toBe('improved');});
 it.each(['stop','timeout','npcEnd','map','identity','error'] as const)('preserves economic ownership through %s and never repeats or resumes',kind=>{const f=fixture();f.send();
  if(kind==='stop')f.owner.cancel('Stopped');else if(kind==='timeout')f.advance(10000);else if(kind==='npcEnd'){f.context.npcMode='idle';f.owner.tick(f.context);}
  else if(kind==='map'){f.context.map='another';f.owner.tick(f.context);}else if(kind==='identity'){f.context.identity='another';f.owner.tick(f.context);}else f.observe({type:'requestFailure',reason:1});
  expect(f.owner.blocked).toBe(true);expect(()=>f.owner.dispatch({...f.input,previewToken:'aa'.repeat(16)},f.context)).toThrow();
  f.observe(f.ore());f.observe(f.currency());f.observe(f.mutation());expect(f.owner.snapshot(f.context).state).toBe(['map','identity'].includes(kind)?'uncertain':'reconciled');expect(f.sent).toHaveLength(1);});
 it('reconciles only fresh full inventory and currency after an uncertain context without inventing success',()=>{const f=fixture();f.send();f.owner.cancel('Disconnect');f.context.identity='new';f.observe(f.currency());expect(f.owner.blocked).toBe(true);
  f.observe({type:'inventory',items:structuredClone(f.context.inventory!),equipment:f.context.equipment!,ammoId:-1});expect(f.owner.snapshot(f.context).state).toBe('reconciled');expect(f.owner.snapshot(f.context).reason).toContain('remains unknown');});
 it('does not mix reconciliation readbacks across lifetimes',()=>{const f=fixture();f.send();f.owner.cancel('Disconnected');f.observe(f.currency());f.context.identity='another';f.context.readbackKey='another-initialization';
  f.observe({type:'inventory',items:structuredClone(f.context.inventory!),equipment:f.context.equipment!,ammoId:-1});expect(f.owner.blocked).toBe(true);f.observe(f.currency());expect(f.owner.blocked).toBe(false);});
 it('captures receipt before transport throws and keeps the spend fenced',()=>{const f=fixture();const owner=new ManualRefine(()=>{throw new Error('socket');},()=>1000,()=> 'aa'.repeat(16));owner.preview(f.input,f.context);
  expect(()=>owner.dispatch({...f.input,previewToken:owner.snapshot(f.context).preview!.token},f.context)).toThrow('uncertain');expect(owner.blocked).toBe(true);});
 it('rejects duplicate commits after confirmed outcomes and does not expose private identity',()=>{const f=fixture(),request=f.preview();f.owner.dispatch(request,f.context);f.observe(f.ore());f.observe(f.currency());f.observe(f.mutation());expect(()=>f.owner.dispatch(request,f.context)).toThrow();expect(JSON.stringify(f.owner.snapshot(f.context))).not.toContain(item.guid!);});
});

it('retains ownership when equipment authority is unknown despite otherwise exact receipts',()=>{const f=fixture();f.send();f.context.equipment=null;f.observe(f.ore());f.observe(f.currency());f.observe(f.mutation());expect(f.owner.blocked).toBe(true);expect(f.owner.snapshot(f.context).state).not.toBe('improved');});
it('stages post-Enter initialization readbacks until own ready spawn without mixing session keys',()=>{const f=fixture();f.send();f.owner.cancel('Reconnect');f.context.ready=false;f.context.identity=null;f.context.readbackKey='new-announced-session';f.observe(f.currency());f.observe({type:'inventory',items:structuredClone(f.context.inventory!),equipment:f.context.equipment!,ammoId:-1});expect(f.owner.blocked).toBe(true);
 f.context.ready=true;f.context.identity='new-ready-life';f.owner.observe([],f.context);expect(f.owner.snapshot(f.context).state).toBe('reconciled');expect(f.owner.snapshot(f.context).reason).toContain('remains unknown');});
it('does not stage readbacks before an announced character identity exists',()=>{const f=fixture();f.send();f.owner.cancel('Reconnect');f.context.ready=false;f.context.identity=null;f.context.readbackKey=null;f.observe(f.currency());f.observe({type:'inventory',items:structuredClone(f.context.inventory!),equipment:f.context.equipment!,ammoId:-1});f.context.ready=true;f.context.identity='new-life';f.context.readbackKey='new-announcement';f.owner.observe([],f.context);expect(f.owner.blocked).toBe(true);});

it('keeps the old economic owner when a different character receives full readbacks',()=>{const f=fixture();f.send();f.owner.cancel('Character changed');f.context.character='Another';f.context.identity='another';f.context.readbackKey='another';f.observe(f.currency());f.observe({type:'inventory',items:structuredClone(f.context.inventory!),equipment:f.context.equipment!,ammoId:-1});expect(f.owner.blocked).toBe(true);expect(f.owner.snapshot(f.context).state).toBe('uncertain');});


it.each(['ready','settled','identity','npcIdentity','inventory','equipment','zeny'] as const)('permanently retires a preview after %s authority is lost and restored',key=>{
 const f=fixture(),request=f.preview(),before=structuredClone(f.context);
 if(key==='ready'||key==='settled')f.context[key]=false;else f.context[key]=null;
 f.owner.tick(f.context);expect(f.owner.snapshot(f.context).preview).toBeNull();Object.assign(f.context,before);
 expect(()=>f.owner.dispatch(request,f.context)).toThrow('new refine preview');expect(f.sent).toEqual([]);
});
it('retires a preview when commit discovers lost settlement even without an intervening tick',()=>{const f=fixture(),request=f.preview();f.context.settled=false;
 expect(()=>f.owner.dispatch(request,f.context)).toThrow();f.context.settled=true;expect(()=>f.owner.dispatch(request,f.context)).toThrow();expect(f.sent).toEqual([]);});
it.each([false,true])('requires fresh full reconciliation after manual input destroys sparse attribution (inventory first=%s)',inventoryFirst=>{
 const f=fixture();f.send();f.owner.externalInput();
 // The official client can now have submitted a second economic request. The first request's exact receipt is no longer enough.
 f.observe(f.ore());f.observe(f.currency());f.observe(f.currency());f.observe(f.mutation());
 expect(f.owner.blocked).toBe(true);expect(f.owner.snapshot(f.context).state).toBe('uncertain');
 f.observe(f.ore());f.observe({type:'currency',zeny:99600});f.observe(f.mutation(2));
 expect(f.owner.blocked).toBe(true);expect(()=>f.preview()).toThrow();
 const full:GameEvent={type:'inventory',items:structuredClone(f.context.inventory!),equipment:f.context.equipment!,ammoId:-1};
 const balance:GameEvent={type:'currency',zeny:99600};
 for(const event of inventoryFirst?[full,balance]:[balance,full])f.observe(event);
 expect(f.owner.snapshot(f.context).state).toBe('reconciled');expect(f.owner.snapshot(f.context).reason).toContain('remains unknown');expect(f.sent).toHaveLength(1);
});
it('retires an unsent preview on manual input before a game response arrives',()=>{const f=fixture(),request=f.preview();f.owner.externalInput();
 expect(()=>f.owner.dispatch(request,f.context)).toThrow();expect(f.sent).toEqual([]);});
it.each([false,true])('waits for both fresh full readback components after external input (inventory first=%s)',inventoryFirst=>{const f=fixture();f.send();f.owner.externalInput();
 const inventory:GameEvent={type:'inventory',items:structuredClone(f.context.inventory!),equipment:f.context.equipment!,ammoId:-1};
 const events=inventoryFirst?[inventory,f.currency()]:[f.currency(),inventory];f.observe(events[0]!);expect(f.owner.blocked).toBe(true);f.observe(events[1]!);
 expect(f.owner.snapshot(f.context).state).toBe('reconciled');expect(f.owner.snapshot(f.context).reason).toContain('remains unknown');expect(f.sent).toHaveLength(1);
});
it('cannot reconcile a manual interruption using a full inventory superseded by sparse economic evidence',()=>{const f=fixture();f.send();f.owner.externalInput();
 const full=():GameEvent=>({type:'inventory',items:structuredClone(f.context.inventory!),equipment:f.context.equipment!,ammoId:-1});f.observe(full());f.observe(f.ore());f.observe(f.currency());
 expect(f.owner.blocked).toBe(true);f.observe(full());expect(f.owner.snapshot(f.context).state).toBe('reconciled');expect(f.sent).toHaveLength(1);
});
it('keeps maintenance excluded through preview, pending, canceled and uncertain ownership',()=>{const f=fixture();expect(f.owner.maintenanceBlocked).toBe(false);const request=f.preview();expect(f.owner.maintenanceBlocked).toBe(true);
 f.owner.dispatch(request,f.context);expect(f.owner.maintenanceBlocked).toBe(true);f.owner.cancel('Stopped');expect(f.owner.maintenanceBlocked).toBe(true);
 f.observe(f.ore());f.observe(f.currency());f.observe(f.mutation());expect(f.owner.maintenanceBlocked).toBe(false);
 const g=fixture();g.preview();g.owner.externalInput();expect(g.owner.maintenanceBlocked).toBe(false);
});

it('keeps official economic ownership independent of a reconciled Companion receipt',()=>{
 const f=fixture();f.send();f.owner.officialCommand('Synthetic');f.observe(f.ore());f.observe(f.currency());f.observe(f.mutation());
 f.observe({type:'inventory',items:structuredClone(f.context.inventory!),equipment:f.context.equipment!,ammoId:-1});f.observe(f.currency());
 expect(f.owner.blocked).toBe(true);expect(f.owner.maintenanceBlocked).toBe(true);expect(f.owner.snapshot(f.context).state).toBe('uncertain');
 f.context.identity='new-ready';f.context.connection++;f.owner.reconcileOfficialInitialization(f.context);
 expect(f.owner.blocked).toBe(false);expect(f.owner.snapshot(f.context).reason).toContain('remains unknown');expect(f.sent).toHaveLength(1);
});
it('never reassigns an unknown or conflicting official character owner to a later snapshot',()=>{
 for(const character of [null,'Another']){const f=fixture();f.owner.officialCommand('Synthetic');f.owner.officialCommand(character);f.context.connection++;f.owner.reconcileOfficialInitialization(f.context);
  expect(f.owner.blocked).toBe(true);expect(f.sent).toEqual([]);}
});
