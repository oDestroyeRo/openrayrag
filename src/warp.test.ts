import {describe,expect,it} from 'vitest';
import {ManualWarp,WARP_SELECTION_MS,type WarpContext,type WarpGuardStore} from './warp';
import type {WarpBindingInput,WarpWire} from './warp-protocol';
import type {MemoSlots} from './memo-protocol';
import {quantity} from './domain-values';
import type {GameEvent} from './protocol';
import {actionConfirmationTimeout} from './automation';
export function warpFixture(store?:WarpGuardStore){
 let now=1000;const sent:WarpWire[]=[];
 const binding:WarpBindingInput={world:'00000000-0000-4000-8000-000000000001',actorId:0,incarnation:1,connectionEpoch:1,revision:1,map:'prt_fild08',x:10,y:10,generation:0,level:4,inventoryRevision:1,equipmentRevision:1,spRevision:1,skillsRevision:1};
 const c:Omit<WarpContext,'slots'|'binding'>&{slots:MemoSlots|null;binding:WarpBindingInput|null}={ready:true,idle:true,character:'Synthetic',connection:1,binding,slots:[{map:'prontera',x:100,y:100},null,null,null],unavailable:null,sp:100,gems:quantity(3),reserve:quantity(1),cost:26,resourcesReady:true,groundAllowed:t=>t.x!==10||t.y!==10};
 const owner=new ManualWarp(w=>sent.push(w),()=>now,store);
 const context=()=>({...c,binding:c.binding?{...c.binding,generation:owner.revision}:null});
 const preview=()=>{owner.prepare({type:'warpGround',slot:0,target:{x:11,y:10}},context());return owner.snapshot(context()).preview!;};
 const ground=()=>{const request=preview();owner.dispatch(request,context());return request;};
 const event=(e:GameEvent)=>owner.observe([e],context());
 const execution=():GameEvent=>({type:'skillResult',source:0,skillId:55,level:4,mode:'ground',position:{x:10,y:10},targetPosition:{x:11,y:10},motionSeconds:1});
 const sp=(value=74)=>{c.sp=value;c.binding!.spRevision++;event({type:'sp',sp:value,maxSp:100});};
 const step=(ms:number)=>{now+=ms;owner.tick(context());};
 const ready=()=>{event({type:'warpState',state:1});event(execution());sp();step(1000);};
 const activate=()=>{owner.prepare({type:'warpActivate'},context());owner.dispatch(owner.snapshot(context()).preview,context());};
 return {owner,sent,c,context,preview,ground,event,execution,sp,step,ready,activate,snapshot:()=>owner.snapshot(context()),elapse:(ms:number)=>{now+=ms;}};
}
describe('bounded manual Warp Portal owner',()=>{
 it('requires separate ground and fresh activation previews, exact ordered selection/result/SP and motion',()=>{
  const t=warpFixture(),r=t.ground();expect(t.sent).toEqual([{stage:'ground',level:4,x:11,y:10}]);
  t.event({type:'warpState',state:1});expect(t.snapshot().activation).toBeNull();t.event(t.execution());expect(t.snapshot().state).toBe('selectionObserved');expect(t.snapshot().activation).toBeNull();
  t.sp();expect(t.snapshot().activation).toBeNull();t.step(1000);expect(t.snapshot().activation?.preview.spRevision).toBe(r.preview.spRevision+1);
  expect(()=>t.owner.dispatch(t.snapshot().activation,t.context())).toThrow('preview');t.activate();expect(t.sent).toEqual([{stage:'ground',level:4,x:11,y:10},{stage:'activate',slot:0}]);
  expect(t.snapshot()).toMatchObject({state:'activationSent',blocked:true,pending:false,activation:null});expect(t.snapshot().reason).toContain('creation is unconfirmed');expect(()=>t.activate()).toThrow();
 });
 it.each(['beforeWaiting','spBeforeExecution','duplicateWaiting','duplicateExecution','wrongCell','wrongLevel','indirect','foreign'])('does not enable activation on %s',kind=>{
  const t=warpFixture();t.ground();if(kind==='beforeWaiting')t.event(t.execution());else if(kind==='spBeforeExecution')t.sp();else{t.event({type:'warpState',state:1});if(kind==='duplicateWaiting')t.event({type:'warpState',state:1});else{const e=t.execution();if(e.type!=='skillResult')throw new Error();if(kind==='wrongCell')e.targetPosition={x:12,y:10};if(kind==='wrongLevel')e.level=3;if(kind==='indirect')e.indirect=true;if(kind==='foreign')e.source=1;t.event(e);if(kind==='duplicateExecution')t.event(e);}}
  t.step(1000);expect(t.snapshot().activation).toBeNull();expect(t.sent).toHaveLength(1);
 });
 it.each(['inventory','equipment','skill','memo','cell','world','incarnation','socket','manual','policy','unexpectedSp'])('retires activation after %s change',kind=>{
  const t=warpFixture();t.ground();t.ready();expect(t.snapshot().activation).not.toBeNull();
  if(kind==='inventory')t.c.binding!.inventoryRevision++;if(kind==='equipment')t.c.binding!.equipmentRevision++;if(kind==='skill')t.c.binding!.skillsRevision++;if(kind==='memo')t.c.binding!.revision++;if(kind==='cell')t.c.binding!.x++;if(kind==='world')t.c.binding!.world='00000000-0000-4000-8000-000000000002';if(kind==='incarnation')t.c.binding!.incarnation++;if(kind==='socket')t.owner.connectionChanged(true);if(kind==='manual'||kind==='policy')t.owner.cancel('Input changed.');if(kind==='unexpectedSp')t.sp(80);
  t.owner.tick(t.context());expect(t.snapshot().activation).toBeNull();expect(t.owner.blocked).toBe(true);expect(()=>t.activate()).toThrow();expect(t.sent).toHaveLength(1);
 });
 it('never permits standing on the target, including after a preview',()=>{const t=warpFixture();expect(()=>t.owner.prepare({type:'warpGround',slot:0,target:{x:10,y:10}},t.context())).toThrow('different');const request=t.preview();t.c.binding!.x=11;expect(()=>t.owner.dispatch(request,t.context())).toThrow('stale');expect(t.sent).toEqual([]);});
 it.each([0,1,2,3])('requires nonempty learned slot %s',slot=>{const t=warpFixture();t.c.binding!.level=slot||1;if(slot===0)t.c.slots![0]=null;expect(()=>t.owner.prepare({type:'warpGround',slot:slot as 0|1|2|3,target:{x:11,y:10}},t.context())).toThrow();expect(t.sent).toEqual([]);});
 it('reserves one gemstone before both stages and does not assume a waiver',()=>{const t=warpFixture();t.c.gems=quantity(1);expect(()=>t.ground()).toThrow('reserve');t.c.gems=quantity(2);t.ground();t.ready();t.c.gems=quantity(1);expect(()=>t.activate()).toThrow();expect(t.sent).toHaveLength(1);});
 it('charges the effective ground cost only; activation can use zero remaining SP',()=>{const t=warpFixture();t.c.sp=26;t.ground();t.event({type:'warpState',state:1});t.event(t.execution());t.sp(0);t.step(1000);t.activate();expect(t.sent.at(-1)).toEqual({stage:'activate',slot:0});});
 it.each(['before','waiting','execution','sp','activation'])('Stop at %s never reopens activation from late events',phase=>{const t=warpFixture();if(phase==='before'){const r=t.preview();t.owner.cancel('Stop');expect(()=>t.owner.dispatch(r,t.context())).toThrow();expect(t.sent).toEqual([]);return;}t.ground();if(phase!=='waiting'){t.event({type:'warpState',state:1});t.event(t.execution());}if(phase==='sp'||phase==='activation'){t.sp();t.step(1000);}if(phase==='activation')t.activate();t.owner.cancel('Stop');t.event({type:'warpState',state:1});t.event(t.execution());t.sp();t.step(1000);expect(t.snapshot().activation).toBeNull();expect(t.owner.blocked).toBe(true);expect(t.sent).toHaveLength(phase==='activation'?2:1);});
 it('bounds both observation and selection clocks without releasing queued cast uncertainty',()=>{for(const selection of [false,true]){const t=warpFixture();t.ground();if(selection)t.ready();t.step(selection?WARP_SELECTION_MS:actionConfirmationTimeout({type:'skill'}));expect(t.snapshot()).toMatchObject({blocked:true,pending:false,activation:null});t.event({type:'warpState',state:0});expect(t.snapshot().selection).toBe('cleared');expect(t.owner.blocked).toBe(true);}});
 it.each(['map','clear','spawn','none','effect','time'])('does not release activation on %s',kind=>{const t=warpFixture();t.ground();t.ready();t.activate();if(kind==='map')t.event({type:'map',map:'prontera'});if(kind==='clear')t.event({type:'clear'});if(kind==='none')t.event({type:'warpState',state:0});if(kind==='spawn'||kind==='effect')t.event({type:'spawn',entity:{id:kind==='effect'?0:1,classId:4,name:'Unattributed',kind:4,x:11,y:10,hp:1,maxHp:1,dead:false,level:1}});t.step(60000);expect(t.snapshot()).toMatchObject({state:'activationSent',blocked:true,activation:null});expect(t.sent).toHaveLength(2);});
 it.each([true,false])('resource changes or waiver absence never confirm creation (consumption %s)',consume=>{const t=warpFixture();t.ground();t.ready();t.activate();if(consume){t.c.binding!.inventoryRevision++;t.c.gems=quantity(2);t.event({type:'inventoryDelta',add:false,bagId:717,change:1,weight:1});}t.sp();t.event({type:'skillFailure',reason:1});expect(t.snapshot().state).toBe('activationSent');expect(t.owner.blocked).toBe(true);expect(t.snapshot().activation).toBeNull();expect(t.sent).toHaveLength(2);});
 it('persists only uncertainty before transport and restores it without intent on page replacement',()=>{let held=false;const store={read:()=>held,write:(v:boolean)=>{held=v;}},t=warpFixture(store);t.ground();expect(held).toBe(true);const replaced=warpFixture(store);expect(replaced.owner.blocked).toBe(true);expect(replaced.snapshot().activation).toBeNull();expect(()=>replaced.ground()).toThrow();expect(replaced.sent).toEqual([]);});
 it('fails closed on guard read/write/clear errors',()=>{const t=warpFixture({read:()=>false,write:()=>{throw new Error('storage');}});expect(()=>t.ground()).toThrow('stored');expect(t.sent).toEqual([]);expect(t.owner.blocked).toBe(true);const read=warpFixture({read:()=>{throw new Error();},write:()=>{}});expect(read.owner.blocked).toBe(true);});
 it('requires proved own death plus ready revival; fresh resources reconcile missing evidence but reset alone cannot',()=>{const t=warpFixture();t.ground();t.owner.cancel('Stop');t.event({type:'death',id:1});expect(t.owner.blocked).toBe(true);t.c.ready=false;t.event({type:'death',id:0});t.c.binding!.incarnation++;t.c.slots=null;t.c.ready=true;t.owner.tick(t.context());expect(t.owner.blocked).toBe(true);
  t.c.binding!.spRevision++;t.event({type:'stats',hp:100,maxHp:100,level:30,sp:60,maxSp:100});expect(t.owner.blocked).toBe(false);expect(t.owner.takeRecoveredMemo()?.[0]).toEqual({map:'prontera',x:100,y:100});expect(t.sent).toHaveLength(1);
 });
 it('keeps activation spending uncertain until full inventory and SP readback even after death',()=>{const t=warpFixture();t.ground();t.ready();t.activate();t.c.ready=false;t.event({type:'death',id:0});t.c.binding!.incarnation++;t.c.ready=true;t.owner.tick(t.context());expect(t.owner.blocked).toBe(true);t.c.binding!.spRevision++;t.event({type:'stats',hp:100,maxHp:100,level:30,sp:74,maxSp:100});expect(t.owner.blocked).toBe(true);t.c.binding!.inventoryRevision++;t.event({type:'inventory',items:[],equipment:Array(10).fill(0),ammoId:-1});expect(t.owner.blocked).toBe(false);expect(t.sent).toHaveLength(2);});
 it('requires captured Enter request, full initialization, fresh memo, official Ready and own readiness after reconnect',()=>{
  const t=warpFixture();t.ground();t.owner.connectionChanged(true);t.event({type:'enter',id:0,map:'prt_fild08'});t.event({type:'memoSlots',slots:t.c.slots!});expect(t.owner.blocked).toBe(true);
  t.owner.connectionChanged(true);t.owner.initialization({type:'enterRequest',character:'Synthetic'});t.c.ready=false;t.event({type:'enter',id:0,map:'prt_fild08'});t.event({type:'stats',hp:100,maxHp:100,level:30,sp:100,maxSp:100});t.event({type:'skills',learned:[{skillId:55,level:4}]});t.event({type:'inventory',items:[],equipment:Array(10).fill(0),ammoId:-1});
  expect(t.owner.blocked).toBe(true);t.event({type:'memoSlots',slots:t.c.slots!});t.owner.initialization({type:'playerReady'});t.owner.tick(t.context());expect(t.owner.blocked).toBe(true);
  t.c.ready=true;t.event({type:'spawn',entity:{id:0,classId:4,name:'Synthetic',kind:0,x:10,y:10,hp:100,maxHp:100,dead:false,level:30}});expect(t.owner.blocked).toBe(false);expect(t.snapshot().activation).toBeNull();expect(t.sent).toHaveLength(1);
 });
 it('holds late-captured or ambiguous external selection without inventing an owner',()=>{const t=warpFixture();t.event({type:'warpState',state:1});expect(t.owner.blocked).toBe(true);expect(t.snapshot().activation).toBeNull();expect(()=>t.ground()).toThrow();expect(t.sent).toEqual([]);});
});

describe('Warp deadlines, reset failures and external lifetimes',()=>{
 it('retains an activation proposal at the SP revision boundary until unchanged dispatch admission',()=>{
  const writes:boolean[]=[],t=warpFixture({read:()=>false,write:held=>{writes.push(held);}});
  t.c.binding!.spRevision=2147483647;t.ground();t.ready();
  expect(t.snapshot().activation?.preview.spRevision).toBe(2147483648);
  expect(()=>t.owner.prepare({type:'warpActivate'},t.context())).not.toThrow();
  const proposal=t.snapshot().preview;expect(proposal?.preview.spRevision).toBe(2147483648);
  expect(()=>t.owner.dispatch(proposal,t.context())).toThrow('Invalid Warp Portal value.');
  expect(t.snapshot().preview).toEqual(proposal);expect(t.snapshot().state).toBe('selectionObserved');
  expect(t.sent).toHaveLength(1);expect(writes).toEqual([true]);expect(t.owner.blocked).toBe(true);
 });
 it.each([-0.25,0,0.125])('preserves signed motion settlement of %s seconds before activation',motion=>{
  const t=warpFixture();t.ground();t.event({type:'warpState',state:1});
  const execution=t.execution();if(execution.type!=='skillResult')throw new Error('Expected skill result');execution.motionSeconds=motion;
  t.event(execution);t.sp();expect(t.snapshot().activation!==null).toBe(motion<=0);
  if(motion>0){t.step(motion*1000-1);expect(t.snapshot().activation).toBeNull();t.step(1);expect(t.snapshot().activation).not.toBeNull();}
  expect(t.sent).toHaveLength(1);expect(t.owner.blocked).toBe(true);
 });
 it.each([0,1])('expires activation at its bounded deadline without replay (late by %s ms)',late=>{
  const t=warpFixture();t.ground();t.ready();t.activate();
  t.elapse(actionConfirmationTimeout({type:'skill'})+late);
  // No polling tick: the incoming packet itself must retire the observation window.
  t.sp();
  expect(t.snapshot()).toMatchObject({state:'activationSent',pending:false,blocked:true,activation:null,preview:null});
  expect(t.snapshot().reason).toContain('activation observation window ended');
  expect(t.snapshot().resourceEvidence).toContain('Late activation SP');
  t.c.binding!.inventoryRevision++;t.c.gems=quantity(2);t.event({type:'inventoryDelta',add:false,bagId:717,change:1,weight:1});
  expect(t.snapshot().resourceEvidence).toContain('Late activation inventory');
  expect(t.snapshot().reason).toContain('creation remains unconfirmed');
  const generation=t.snapshot().generation;t.step(60000);expect(t.snapshot().generation).toBe(generation);expect(t.sent).toHaveLength(2);
 });
 it('ends activation observation on backwards time and retains the spent-resource fence',()=>{
  const t=warpFixture();t.ground();t.ready();t.activate();t.step(-1);
  expect(t.snapshot().reason).toContain('clock changed');expect(t.snapshot().blocked).toBe(true);expect(()=>t.activate()).toThrow();expect(t.sent).toHaveLength(2);
 });
 it('does not turn a late ground execution or SP readback into a fresh selection allowance',()=>{
  for(const missing of ['execution','sp']){
   const t=warpFixture();t.ground();t.event({type:'warpState',state:1});if(missing==='sp')t.event(t.execution());
   t.elapse(actionConfirmationTimeout({type:'skill'}));if(missing==='execution')t.event(t.execution());t.sp();
   expect(t.snapshot()).toMatchObject({state:'stopped',pending:false,blocked:true,activation:null});expect(()=>t.activate()).toThrow();expect(t.sent).toHaveLength(1);
  }
 });
 it('gives the matched ground result a finite selection window while keeping SP within the original deadline',()=>{
  const t=warpFixture();t.ground();t.elapse(25000);t.event({type:'warpState',state:1});t.event(t.execution());t.sp();t.step(1000);
  expect(t.snapshot().activation).not.toBeNull();t.step(WARP_SELECTION_MS-1001);expect(t.snapshot().activation).not.toBeNull();
  t.step(1);expect(t.snapshot()).toMatchObject({state:'stopped',blocked:true,activation:null});expect(t.sent).toHaveLength(1);
 });
 it('retains both the guard and memo hold when persistent reset clearing fails',()=>{
  let stored=false,failClear=true;const writes:boolean[]=[];
  const t=warpFixture({read:()=>stored,write:held=>{writes.push(held);if(!held&&failClear)throw new Error('Storage unavailable');stored=held;}});
  t.ground();t.ready();t.c.ready=false;t.event({type:'death',id:0});t.c.slots=null;t.c.binding!.incarnation++;t.c.ready=true;t.owner.tick(t.context());
  expect(stored).toBe(true);expect(t.owner.blocked).toBe(true);expect(t.snapshot().reason).toContain('guard could not be cleared');expect(t.owner.takeRecoveredMemo()).toBeNull();expect(t.snapshot().activation).toBeNull();
  failClear=false;t.owner.tick(t.context());expect(stored).toBe(false);expect(t.owner.blocked).toBe(false);expect(t.owner.takeRecoveredMemo()?.[0]?.map).toBe('prontera');
  expect(writes).toEqual([true,false,false]);expect(t.sent).toHaveLength(1);
 });
 it.each(['restored','lateSelection'])('reconciles an intent-free %s guard only after own death and fresh full resources',kind=>{
  let stored=kind==='restored';const t=warpFixture({read:()=>stored,write:held=>{stored=held;}});
  if(kind==='lateSelection')t.event({type:'warpState',state:1});
  t.c.ready=false;t.event({type:'death',id:0});t.c.binding!.incarnation++;t.c.slots=null;t.c.ready=true;t.owner.tick(t.context());expect(t.owner.blocked).toBe(true);
  t.sp();expect(t.owner.blocked).toBe(true); // A delta with no captured baseline cannot repair a page-replacement gap.
  t.event({type:'stats',hp:100,maxHp:100,level:30,sp:74,maxSp:100});expect(t.owner.blocked).toBe(true);
  t.c.binding!.inventoryRevision++;t.event({type:'inventory',items:[],equipment:Array(10).fill(0),ammoId:-1});
  expect(t.owner.blocked).toBe(false);expect(stored).toBe(false);expect(t.owner.takeRecoveredMemo()?.[0]?.map).toBe('prontera');expect(t.sent).toEqual([]);expect(t.snapshot().activation).toBeNull();
 });
 it('cannot recover from foreign death, different-character revival, a memo contradiction or incomplete resources',()=>{
  for(const fault of ['foreignDeath','character','memo','resources']){
   const t=warpFixture();t.ground();t.ready();t.c.ready=false;
   if(fault==='memo'){t.c.slots=null;t.event({type:'serverEvent',event:8,value:0,text:''});}
   t.event({type:'death',id:fault==='foreignDeath'?1:0});t.c.binding!.incarnation++;t.c.ready=true;
   if(fault==='character')t.c.character='Different';if(fault==='resources')t.c.resourcesReady=false;
   t.owner.tick(t.context());expect(t.owner.blocked).toBe(true);expect(t.owner.takeRecoveredMemo()).toBeNull();expect(t.sent).toHaveLength(1);
  }
 });
 it.each(['duplicate','wrongLevel','wrongTarget','foreign'])('treats %s cast starts as observations, never unique selection confirmation',kind=>{
  const t=warpFixture();t.ground();const cast:GameEvent={type:'castStart',id:0,skillId:55,level:4,position:{x:10,y:10},targetPosition:{x:11,y:10},remainingSeconds:.5,flags:0};
  t.event(cast);
  t.event({...cast,...(kind==='wrongLevel'?{level:3}:kind==='wrongTarget'?{targetPosition:{x:12,y:10}}:kind==='foreign'?{id:1}:{})});
  t.ready();expect(t.snapshot().activation===null).toBe(kind!=='foreign');expect(t.sent).toHaveLength(1);
 });
 it('does not release a restored guard on stale initialization, duplicated Enter or map-ready actor reactivation',()=>{
  for(const fault of ['missingEnter','duplicateEnter','worldRefresh','wrongCharacter','missingReady','spawnBeforeReady']){
   const t=warpFixture({read:()=>true,write:()=>{}});t.owner.connectionChanged(true);
   if(fault!=='missingEnter')t.owner.initialization({type:'enterRequest',character:'Synthetic'});
   if(fault==='duplicateEnter')t.owner.initialization({type:'enterRequest',character:'Synthetic'});
   t.c.ready=false;t.event({type:'enter',id:0,map:'prt_fild08'});
   t.event({type:'stats',hp:100,maxHp:100,level:30,sp:100,maxSp:100});t.event({type:'skills',learned:[{skillId:55,level:4}]});t.event({type:'inventory',items:[],equipment:Array(10).fill(0),ammoId:-1});t.event({type:'memoSlots',slots:t.c.slots!});
   const spawn:GameEvent={type:'spawn',entity:{id:0,classId:4,name:fault==='wrongCharacter'?'Different':'Synthetic',kind:0,x:10,y:10,hp:100,maxHp:100,dead:false,level:30}};
   if(fault==='spawnBeforeReady'){t.c.ready=true;t.event(spawn);}
   if(fault!=='missingReady')t.owner.initialization({type:'playerReady'});
   if(fault==='worldRefresh')t.event({type:'clear'});
   t.c.ready=true;if(fault!=='spawnBeforeReady')t.event(spawn);t.owner.tick(t.context());
   expect(t.owner.blocked,fault).toBe(true);expect(t.snapshot().activation).toBeNull();expect(t.sent).toEqual([]);
  }
 });
});

describe('Warp reset evidence cannot cross a missing character snapshot',()=>{
 it('cannot reuse captured memo slots across a reconnect or Enter even after death and fresh resources',()=>{
  for(const boundary of ['connection','enter']){
   const t=warpFixture();t.ground();t.ready();t.c.slots=null;
   if(boundary==='connection'){t.owner.connectionChanged(true);t.c.connection++;t.c.binding!.connectionEpoch++;}else t.event({type:'enter',id:0,map:'prt_fild08'});
   t.c.ready=false;t.event({type:'death',id:0});t.event({type:'stats',hp:100,maxHp:100,level:30,sp:74,maxSp:100});t.event({type:'inventory',items:[],equipment:Array(10).fill(0),ammoId:-1});
   t.c.ready=true;t.c.binding!.incarnation++;t.owner.tick(t.context());expect(t.owner.blocked).toBe(true);expect(t.owner.takeRecoveredMemo()).toBeNull();expect(t.snapshot().reason).toContain('memo readback');expect(t.sent).toHaveLength(1);
  }
 });
 it('does not treat a different named own replacement and its death as the original character reset',()=>{
  const t=warpFixture();t.ground();t.ready();t.c.character='Different';t.c.binding!.incarnation++;t.c.ready=false;t.event({type:'death',id:0});t.c.ready=true;t.c.binding!.incarnation++;t.owner.tick(t.context());
  expect(t.owner.blocked).toBe(true);expect(t.sent).toHaveLength(1);
 });
});


describe('Warp process maintenance ownership',()=>{
 it.each(['restored','readFailure','writeFailure'])('blocks maintenance for %s uncertainty even without a live stage',kind=>{
  const t=warpFixture({read:()=>{if(kind==='readFailure')throw new Error('Unavailable');return kind==='restored';},write:()=>{if(kind==='writeFailure')throw new Error('Unavailable');}});
  if(kind==='writeFailure')expect(()=>t.ground()).toThrow();expect(t.owner.settledForMaintenance()).toBe(false);t.owner.cancel('Stop');t.owner.connectionChanged(true);t.step(60000);expect(t.owner.settledForMaintenance()).toBe(false);expect(t.sent).toEqual([]);
 });
 it('keeps maintenance blocked when reset persistence fails and releases only after successful reconciliation',()=>{
  let failClear=true;const t=warpFixture({read:()=>false,write:held=>{if(!held&&failClear)throw new Error('Unavailable');}});t.ground();t.ready();t.c.ready=false;t.event({type:'death',id:0});t.c.binding!.incarnation++;t.c.ready=true;t.owner.tick(t.context());
  expect(t.owner.settledForMaintenance()).toBe(false);failClear=false;t.owner.tick(t.context());expect(t.owner.settledForMaintenance()).toBe(true);expect(t.snapshot().preview).toBeNull();expect(t.sent).toHaveLength(1);
 });
});
