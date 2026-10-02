import {describe,it,expect,vi} from 'vitest';
import {RetreatLedger,planRetreat} from './retreat';
import {GridNavigator,type WalkGrid} from './navigation';
import {DEFAULT_AUTOMATION,DEFAULT_RETREAT,DEFAULT_SETTINGS,retreatSettings,validateAutomation} from './settings';
import {ProfileStore} from './profiles';
import {attackDistance} from './combat';
import type {ActionIdentity} from './actor-identity';
import cases from './data/retreat-cases.json';
const open:WalkGrid={width:30,height:30,walkable:()=>true};
describe('retreat candidate geometry and bounded work',()=>{
 it('selects exact path cost then greater separation and stable y/x ties',()=>{
  const nav=new GridNavigator(open),plan=planRetreat(nav,{x:10,y:10},{x:12,y:10},10,DEFAULT_RETREAT)!;
  expect(plan).toEqual({destination:{x:7,y:10},cells:[{x:10,y:10},{x:9,y:10},{x:8,y:10},{x:7,y:10}],cost:30});
  expect(planRetreat(nav,{x:10,y:10},{x:12,y:10},10,DEFAULT_RETREAT)).toEqual(plan);
 });
 it('respects walls, diagonal sides, portals, and projectile sight separately',()=>{
  const nav=new GridNavigator({width:30,height:30,walkable:p=>p.x!==9||p.y!==10,seeThrough:()=>true,portals:[{x:8,y:10,halfWidth:0,halfHeight:0}]}),from={x:10,y:10},target={x:12,y:10};
  const plan=planRetreat(nav,from,target,10,DEFAULT_RETREAT)!;expect(nav.validRoute(plan.cells)).toBe(true);expect(nav.canAttack(plan.destination,target,10)).toBe(true);expect(plan.cells.some(p=>p.x===9&&p.y===10||p.x===8&&p.y===10)).toBe(false);
  const opaque=new GridNavigator({...open,seeThrough:p=>p.x>=10});const blocked=planRetreat(opaque,from,target,10,DEFAULT_RETREAT)!;expect(opaque.canAttack(blocked.destination,target,10)).toBe(true);expect(blocked.destination.x).toBeGreaterThanOrEqual(10);
 });
 it('does not take a closer, out-of-range or excessive-length destination',()=>{
  const nav=new GridNavigator(open),from={x:10,y:10},target={x:12,y:10};
  expect(planRetreat(nav,from,target,10,DEFAULT_RETREAT,2)).toBeNull();
  const plan=planRetreat(nav,from,target,5,DEFAULT_RETREAT)!;expect(plan.cells.length-1).toBeLessThanOrEqual(12);expect(attackDistance(plan.destination,target)).toBe(5);
 });
 it('counts rejected geometry and failed exact plans in finite candidate caps',()=>{
  const nav=new GridNavigator(open),safe=vi.spyOn(nav,'safe').mockReturnValue(true),canAttack=vi.spyOn(nav,'canAttack').mockReturnValue(true),plan=vi.spyOn(nav,'plan').mockReturnValue(null);
  expect(planRetreat(nav,{x:15,y:15},{x:17,y:15},14,{...DEFAULT_RETREAT,maxPathSteps:20})).toBeNull();expect(safe.mock.calls.length).toBeLessThanOrEqual(128);expect(canAttack.mock.calls.length).toBeLessThanOrEqual(128);expect(plan).toHaveBeenCalledTimes(32);
 });
});
describe('durable per-lifetime retreat budget',()=>{
 const identity=(id=0,incarnation=1):ActionIdentity=>({world:'00000000-0000-0000-0000-000000000001',selfId:0,selfIncarnation:1,targetId:id,targetIncarnation:incarnation});
 it('preserves total/no-progress anchors and spent attempts across dispatches',()=>{
  const ledger=new RetreatLedger(),entry=ledger.dispatch(identity(),100)!;entry.accepted=true;entry.progress=200;entry.attempts=2;
  expect(ledger.dispatch(identity(),500)).toBe(entry);expect(entry).toMatchObject({since:100,progress:200,attempts:2,accepted:false});
  expect(ledger.dispatch(identity(0,2),600)).toMatchObject({since:600,attempts:0});
 });
 it('refuses the 301st live entry without eviction or budget refill',()=>{
  const ledger=new RetreatLedger();for(let id=0;id<300;id++)ledger.dispatch(identity(id),100)!.attempts=3;
  expect(ledger.dispatch(identity(300),200)).toBeNull();expect(ledger.dispatch(identity(0),300)!.attempts).toBe(3);ledger.remove(0);expect(ledger.dispatch(identity(300),400)).not.toBeNull();ledger.clear();expect(ledger.dispatch(identity(1),500)!.since).toBe(500);
 });
});
describe('strict optional retreat settings/profile contract',()=>{
 it.each(cases)('$name',({valid,policy})=>{
  const automation={...structuredClone(DEFAULT_AUTOMATION),retreat:policy};
  if(valid)expect(validateAutomation(automation as never).retreat).toEqual(policy);else expect(()=>validateAutomation(automation as never)).toThrow();
 });
 it('keeps old profiles omitted and new profiles detached with no run evidence',()=>{
  const storage=new Map<string,string>();let id=0;const store=new ProfileStore({getItem:k=>storage.get(k)??null,setItem:(k,v)=>{storage.set(k,v);}},()=>`p-${++id}`);
  const settings={...DEFAULT_SETTINGS,map:'prt_fild08',targets:[4000],automation:structuredClone(DEFAULT_AUTOMATION)};
  const old=store.save('Old','Self',settings);expect(store.import(store.export(old.id))[0]!.settings.automation).not.toHaveProperty('retreat');expect(retreatSettings(settings).enabled).toBe(false);
  settings.automation.retreat={...DEFAULT_RETREAT,enabled:true};const added=store.save('New','Self',settings);const imported=store.import(store.export(added.id))[0]!;expect(imported.settings.automation!.retreat).toEqual(settings.automation.retreat);
  const document=JSON.parse(store.export(added.id));document.profiles[0].settings.automation.retreat.stepsSpent=2;expect(()=>store.import(JSON.stringify(document))).toThrow();
 });
});
