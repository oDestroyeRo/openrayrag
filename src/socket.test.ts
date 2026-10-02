import {describe,expect,it} from 'vitest';
import {ManualSocket,SOCKET_METADATA,type SocketContext} from './socket';
import {socketCommand,validateSocketEnvelope,type SocketAction} from './socket-protocol';
import {CharacterState} from './character-state';
import {BitWriter} from './binary';
import {decode,type GameEvent} from './protocol';
import type {InventoryItem} from './protocol-feature';
import {validControllerAction,CompanionController} from './controller';
import {validFeatureStatus} from './feature-ui';
import {validSocketSnapshot} from './socket-ui';
import cases from './data/socket-request-cases.json';
import {DEFAULT_SETTINGS,DEFAULT_AUTOMATION,validateAutomation} from './settings';

const weapon=():InventoryItem=>({bagId:20001,itemId:1102,type:2,count:1,flags:0,refine:4,guid:'00112233445566778899aabbccddeeff',slots:[4002,0,0,0]});
const card=():InventoryItem=>({bagId:4002,itemId:4002,type:1,count:3});
function setup(sendThrow=false){
  let now=1000;const sent:SocketAction[]=[],state=new CharacterState();
  state.apply({type:'inventory',items:[weapon(),card(),{bagId:501,itemId:501,type:1,count:5}],equipment:Array(10).fill(0),ammoId:-1},1);
  const context:SocketContext={ready:true,settled:true,character:'Test',identity:'world:1:1',readbackKey:'world:1:1',connection:1,map:'prontera',inventoryKnown:true,equipmentKnown:true,
    inventoryRevision:state.inventoryRevision,equipmentRevision:state.equipmentRevision,inventory:state.inventory,equipment:state.equipment,ammoId:-1,floors:new Map([[4002,1]])};
  const c=()=>({...context,inventory:state.inventory,inventoryKnown:state.inventoryKnown,inventoryRevision:state.inventoryRevision,
    equipmentRevision:state.equipmentRevision,equipment:state.equipment,ammoId:state.ammoId});
  const owner=new ManualSocket(a=>{sent.push(a);if(sendThrow)throw Error('write');},()=>now,()=> 'a'.repeat(32));
  const prepare=()=>{owner.prepare({targetBagId:20001,cardBagId:4002},c());return owner.snapshot(c()).preview!;};
  const dispatch=()=>{const p=prepare();owner.dispatch({targetBagId:p.targetBagId,cardBagId:p.cardBagId,previewToken:p.previewToken},c());};
  const observe=(event:GameEvent)=>{state.apply(event as Parameters<CharacterState['apply']>[0],1);owner.observe([event],c());};
  const removal:GameEvent={type:'inventoryDelta',add:false,bagId:4002,change:1,weight:0};
  const mutation:GameEvent={type:'inventoryItem',item:{...weapon(),slots:[4002,4002,0,0]}};
  return{state,context,c,owner,sent,prepare,dispatch,observe,removal,mutation,advance:()=>{now+=10001;owner.tick(c());}};
}
describe('manual one-card socket boundaries',()=>{
  it('matches outgoing63 and existing incoming63 exactly, without a type byte',()=>{
    expect([...socketCommand({type:'socket',targetBagId:20001,cardBagId:4002})]).toEqual([63,33,78,0,0,162,15,0,0]);
    const p=new BitWriter().u8(63).i32(20001).i32(1102).i16(1).u8(0).u8(4);
    for(const n of '00112233445566778899aabbccddeeff'.match(/../g)!)p.u8(parseInt(n,16));
    p.i32(4002).i32(4002).i32(0).i32(0);const packet=p.finish();
    expect(packet).toHaveLength(45);expect(decode(packet)).toEqual([{type:'inventoryItem',item:{...weapon(),slots:[4002,4002,0,0]}}]);
    for(let n=1;n<packet.length;n++)expect(()=>decode(packet.slice(0,n))).toThrow();
    expect(()=>decode(Uint8Array.from([...packet,0]))).toThrow();
  });
  it('shares strict manual-only native cases and rejects generic actions',()=>{
    for(const row of cases){const accepts=()=>{try{row.mode==='socket'?validateSocketEnvelope(row.request,true):validateSocketEnvelope(row.request,false);return true;}catch{return false;}};
      expect(accepts(),row.name).toBe(row.valid);expect(validControllerAction(row.request)).toBe(false);}
    expect(validControllerAction({type:'socket',targetBagId:20001,cardBagId:4002})).toBe(false);
  });
  it('bounds the whole UTF-8 policy envelope even when the protection policy is structurally valid',()=>{
    const large=structuredClone(DEFAULT_AUTOMATION);large.combat.rules=Array.from({length:64},(_,i)=>({classId:i+1,action:'attack',priority:0,
      conditions:Array.from({length:16},()=>({field:'actorCasting',actor:{scope:'actor',id:1,world:'12345678-1234-1234-1234-123456789abc',incarnation:1},operator:'eq',value:true}))}));
    expect(()=>validateAutomation(large)).not.toThrow();
    expect(()=>validateSocketEnvelope({targetBagId:20001,cardBagId:4002,policy:large},false)).toThrow('65,536');
    const ascii=structuredClone(DEFAULT_AUTOMATION);ascii.travel.waypoints=Array.from({length:64},()=>({map:'x'.repeat(64),x:1,y:1}));
    ascii.follow.name='ก'.repeat(48);expect(()=>validateSocketEnvelope({targetBagId:20001,cardBagId:4002,policy:ascii},false)).not.toThrow();
    ascii.follow.name='\ud800';expect(()=>validateSocketEnvelope({targetBagId:20001,cardBagId:4002,policy:ascii},false)).toThrow('Unicode');
    ascii.follow.name='\ufeff名前';expect(()=>validateSocketEnvelope({targetBagId:20001,cardBagId:4002,policy:ascii},false)).not.toThrow();
  });
  it('uses pinned class/mask/capacity and verifies public IDs/names',()=>{
    expect(Object.keys(SOCKET_METADATA)).toHaveLength(1499);
    expect(SOCKET_METADATA[1102]).toMatchObject({code:'Sword_',name:'Sword',itemClass:2,mask:16,capacity:4});
    expect(SOCKET_METADATA[2102]).toMatchObject({itemClass:3,mask:32,capacity:1});
    const s=setup(),p=s.prepare();expect(p.slot).toBe(1);expect(p.cost).toBe(1);expect(s.sent).toEqual([]);
    expect(JSON.stringify(s.owner.snapshot(s.c()))).not.toContain(weapon().guid);
  });
  it('accepts legal duplicate installed cards and always chooses the first zero',()=>{
    const s=setup();s.state.inventory.set(20001,{...weapon(),slots:[4002,0,4002,0]});expect(s.prepare().slot).toBe(1);
  });
  it('covers every generated target capacity and card-mask class without label permissions',()=>{
    const cards=[...new Map(Object.entries(SOCKET_METADATA).filter(([,m])=>m.itemClass===5).map(([id,m])=>[m.mask,{id:Number(id),m}])).values()];
    for(const [id,m]of Object.entries(SOCKET_METADATA).filter(([,m])=>m.itemClass!==5&&m.capacity>0)){
      for(const source of cards){const s=setup();s.state.inventory.clear();s.state.inventory.set(20001,{...weapon(),itemId:Number(id),slots:[0,0,0,0]});
        s.state.inventory.set(source.id,{type:1,bagId:source.id,itemId:source.id,count:2});
        const operation=()=>s.owner.prepare({targetBagId:20001,cardBagId:source.id},s.c());
        if((m.mask&source.m.mask)!==0){expect(operation).not.toThrow();expect(s.owner.snapshot(s.c()).preview!.slot).toBe(0);}
        else expect(operation).toThrow('mask');}
    }
  });
  it.each(['crafted','full','zeroCapacity','unsupportedTail','unknownSlot','missingGuid','nilGuid','badGuid','refineUnknown','flagsUnknown','regularTarget','unknownClass','incompatible','uniqueCard','reserve','missingBag','equipped','ammo'])('rejects %s before any write',condition=>{
    const s=setup(),t=weapon();
    if(condition==='crafted')t.flags=1;if(condition==='full')t.slots=[4002,4002,4002,4002];
    if(condition==='zeroCapacity')t.itemId=1129;if(condition==='unsupportedTail'){t.itemId=2102;t.slots=[0,4002,0,0];}
    if(condition==='unknownSlot')t.slots=[999999,0,0,0];if(condition==='missingGuid')delete t.guid;if(condition==='nilGuid')t.guid='0'.repeat(32);
    if(condition==='badGuid')t.guid='bad';if(condition==='refineUnknown')delete t.refine;if(condition==='flagsUnknown')delete t.flags;
    if(condition==='regularTarget')t.type=1;if(condition==='unknownClass')t.itemId=501;
    s.state.inventory.set(20001,t);
    if(condition==='incompatible')s.state.inventory.set(4002,{...card(),bagId:4002,itemId:4001});
    if(condition==='uniqueCard')s.state.inventory.set(4002,{...card(),type:2});if(condition==='reserve')s.context.floors=new Map([[4002,3]]);
    if(condition==='missingBag')s.state.inventory.delete(20001);if(condition==='equipped')s.state.equipment[9]=20001;if(condition==='ammo')s.state.ammoId=20001;
    expect(()=>s.prepare()).toThrow();expect(s.sent).toEqual([]);
  });
  it.each(Array.from({length:14},(_,i)=>i))('protects every equipped alias %s',slot=>{
    const s=setup();s.state.equipment[slot]=20001;expect(()=>s.prepare()).toThrow();expect(s.sent).toEqual([]);
  });
  it.each(['inventoryRevision','equipmentRevision','guid','itemId','count','refine','flags','slots','reserve','identity','connection','map','dead','unsettled','unknownInventory','unknownEquipment'])('revalidates %s atomically before dispatch',change=>{
    const s=setup(),p=s.prepare(),t=s.state.inventory.get(20001)!;
    if(change==='inventoryRevision')s.state.inventoryRevision++;if(change==='equipmentRevision')s.state.equipmentRevision++;
    if(change==='guid')t.guid='b'.repeat(32);if(change==='itemId')t.itemId=1101;if(change==='count')t.count=2;if(change==='refine')t.refine=5;
    if(change==='flags')t.flags=2;if(change==='slots')t.slots=[4002,4002,0,0];if(change==='reserve')s.context.floors=new Map([[4002,2]]);
    if(change==='identity')s.context.identity='new';if(change==='connection')s.context.connection++;if(change==='map')s.context.map='other';
    if(change==='dead')s.context.ready=false;if(change==='unsettled')s.context.settled=false;if(change==='unknownInventory')s.state.inventoryKnown=false;
    if(change==='unknownEquipment')s.context.equipmentKnown=false;
    expect(()=>s.owner.dispatch({targetBagId:20001,cardBagId:4002,previewToken:p.previewToken},s.c())).toThrow();expect(s.sent).toEqual([]);
  });
  it.each([false,true])('confirms exact paired evidence in either order %s',reverse=>{
    const s=setup();s.dispatch();s.observe(reverse?s.mutation:s.removal);expect(s.owner.busy).toBe(true);s.observe(reverse?s.removal:s.mutation);
    expect(s.owner.snapshot(s.c()).state).toBe('confirmed');expect(s.sent).toHaveLength(1);
    s.owner.observe([s.removal,s.mutation,s.removal,s.mutation],s.c());expect(s.owner.busy).toBe(false);expect(s.sent).toHaveLength(1);
  });
  it('does not double consume for duplicate metadata evidence; extra real decrements cannot confirm',()=>{
    const s=setup();s.dispatch();s.observe(s.mutation);s.observe(s.mutation);s.observe(s.removal);expect(s.owner.snapshot(s.c()).state).toBe('confirmed');
    const t=setup();t.dispatch();t.observe(t.removal);t.observe(t.removal);t.observe(t.mutation);expect(t.owner.busy).toBe(true);expect(t.sent).toHaveLength(1);
  });
  it.each(['costOnly','metadataOnly','wrongGuid','wrongSlot','changedRefine','changedFlags','changedItem','extraCard','otherBag','equipment'])('never confirms %s evidence',kind=>{
    const s=setup();s.dispatch();
    if(kind==='costOnly')s.observe(s.removal);else if(kind==='metadataOnly')s.observe(s.mutation);
    else{if(kind==='extraCard'){s.observe({...s.removal,type:'inventoryDelta',change:2});s.observe(s.mutation);}
      else if(kind==='otherBag'){s.observe({type:'inventoryDelta',add:false,bagId:501,change:1,weight:0});s.observe(s.removal);s.observe(s.mutation);}
      else if(kind==='equipment'){s.observe({type:'equipment',slot:0,bagId:20001,equipped:true});s.observe(s.removal);s.observe(s.mutation);}
      else{const item={...weapon(),slots:[4002,4002,0,0]};if(kind==='wrongGuid')item.guid='b'.repeat(32);if(kind==='wrongSlot')item.slots=[4002,0,4002,0];if(kind==='changedRefine')item.refine=5;if(kind==='changedFlags')item.flags=2;if(kind==='changedItem')item.itemId=1101;s.observe(s.removal);s.observe({type:'inventoryItem',item});}}
    expect(s.owner.busy).toBe(true);expect(s.sent).toHaveLength(1);
  });
  it.each(['Stop','timeout','map','death','socket','character','reconnect'])('retains uncertainty after %s without replay',boundary=>{
    const s=setup();s.dispatch();if(boundary==='timeout')s.advance();else s.owner.cancel(boundary);
    expect(s.owner.busy).toBe(true);expect(()=>s.prepare()).toThrow();s.observe(s.removal);s.observe(s.mutation);
    expect(s.owner.snapshot(s.c())).toMatchObject({state:'confirmed',pending:false});expect(s.owner.snapshot(s.c()).reason).toContain('Late exact');expect(s.sent).toHaveLength(1);
  });
  it('taints sparse correlation after official input and needs a later complete readback',()=>{
    const s=setup();s.dispatch();s.owner.cancel('Stop');s.owner.externalInput();s.observe(s.removal);s.observe(s.mutation);
    expect(s.owner.busy).toBe(true);expect(s.owner.snapshot(s.c()).state).toBe('uncertain');expect(s.sent).toHaveLength(1);
    s.observe({type:'inventory',items:[{...weapon(),slots:[4002,4002,0,0]},{...card(),count:2},{bagId:501,itemId:501,type:1,count:5}],equipment:Array(10).fill(0),ammoId:-1});
    expect(s.owner.snapshot(s.c()).state).toBe('reconciled');expect(s.sent).toHaveLength(1);
  });
  it('never combines initialization readback with another actor lifetime or later sparse inventory',()=>{
    for(const mismatch of ['lifetime','revision']){
      const s=setup();s.dispatch();s.owner.externalInput();s.context.ready=false;s.context.identity='';s.context.readbackKey='enter-one';
      s.observe({type:'inventory',items:[weapon(),card()],equipment:Array(10).fill(0),ammoId:-1});
      if(mismatch==='lifetime')s.context.readbackKey='enter-two';else s.observe(s.removal);
      s.context.ready=true;s.context.identity='world:2:1';s.owner.tick(s.c());expect(s.owner.busy).toBe(true);
      s.observe({type:'inventory',items:[weapon(),card()],equipment:Array(10).fill(0),ammoId:-1});expect(s.owner.busy).toBe(false);
      expect(s.owner.snapshot(s.c()).state).toBe('reconciled');expect(s.sent).toHaveLength(1);
    }
  });
  it.each(['ready','settled','inventoryKnown','equipmentKnown'] as const)('rejected %s admission immediately retires the original token without an interval tick',field=>{
    const s=setup(),preview=s.prepare();
    if(field==='inventoryKnown')s.state.inventoryKnown=false;else s.context[field]=false;
    const request={targetBagId:preview.targetBagId,cardBagId:preview.cardBagId,previewToken:preview.previewToken};
    expect(()=>s.owner.dispatch(request,s.c())).toThrow();
    if(field==='inventoryKnown')s.state.inventoryKnown=true;else s.context[field]=true;
    expect(s.owner.snapshot(s.c()).preview).toBeNull();expect(()=>s.owner.dispatch(request,s.c())).toThrow('stale');expect(s.sent).toEqual([]);
  });
  it('captures send exception, refuses replay, and reconciles fresh stock without declaring success',()=>{
    const s=setup(true);expect(()=>s.dispatch()).toThrow('uncertain');expect(s.owner.busy).toBe(true);expect(s.sent).toHaveLength(1);
    s.observe({type:'inventory',items:[weapon(),card(),{bagId:501,itemId:501,type:1,count:5}],equipment:Array(10).fill(0),ammoId:-1});
    expect(s.owner.snapshot(s.c()).state).toBe('reconciled');expect(()=>s.prepare()).toThrow('already sent');expect(s.sent).toHaveLength(1);
  });
  it('does not treat a newer character or actor as the old receipt owner',()=>{
    const s=setup();s.dispatch();s.context.identity='world:1:2';s.owner.tick(s.c());s.observe(s.removal);s.observe(s.mutation);
    expect(s.owner.busy).toBe(true);s.context.character='Other';s.observe({type:'inventory',items:[weapon(),card()],equipment:[],ammoId:-1});expect(s.owner.busy).toBe(true);
  });
  it('can reconcile initialization inventory observed before the own spawn without inventing an outcome',()=>{
    const s=setup();s.dispatch();s.context.connection=2;s.context.ready=false;s.context.identity='';s.context.readbackKey='new-enter';s.context.character='';s.owner.tick(s.c());
    s.observe({type:'inventory',items:[weapon(),card()],equipment:Array(10).fill(0),ammoId:-1});expect(s.owner.busy).toBe(true);
    s.context.identity='new-world:1:1';s.context.character='Test';s.context.ready=true;s.owner.tick(s.c());
    expect(s.owner.snapshot(s.c()).state).toBe('reconciled');expect(s.sent).toHaveLength(1);expect(()=>s.prepare()).toThrow('already sent');
  });
  it('bounds purpose-specific telemetry and rejects leaked private fields',()=>{
    const s=setup();s.prepare();const snapshot=s.owner.snapshot(s.c());expect(validSocketSnapshot(snapshot)).toBe(true);expect(validFeatureStatus({socket:snapshot})).toBe(true);
    expect(validSocketSnapshot({...snapshot,targets:[{...snapshot.targets[0],guid:weapon().guid}]})).toBe(false);
    expect(validSocketSnapshot({...snapshot,cards:Array(201).fill(snapshot.cards[0])})).toBe(false);
  });
});

describe('controller socket ownership',()=>{
  function live(){let now=100_000;const sent:SocketAction[]=[],other:unknown[]=[];const c=new CompanionController(a=>other.push(a),()=>now,()=>null,()=>{},()=>{},a=>sent.push(a));
    c.connect(true);c.engine.receive([{type:'enter',id:1,map:'prontera'},{type:'spawn',entity:{id:1,kind:0,classId:0,name:'Test',hp:100,maxHp:100,level:1,x:1,y:1,dead:false}},
      {type:'inventory',items:[weapon(),card()],equipment:Array(10).fill(0),ammoId:-1}]);
    const preview=()=>{c.perform('socketPreview',{targetBagId:20001,cardBagId:4002,policy:DEFAULT_AUTOMATION});return c.snapshot().socket.preview!;};
    const dispatch=()=>{const p=preview();c.perform('socket',{targetBagId:20001,cardBagId:4002,previewToken:p.previewToken,policy:DEFAULT_AUTOMATION});};
    const delta=()=>c.receive(new BitWriter().u8(50).bool(false).i32(4002).i16(1).i32(0).bool(false).finish());
    const mutation=()=>{const w=new BitWriter().u8(63).i32(20001).i32(1102).i16(1).u8(0).u8(4);for(const n of weapon().guid!.match(/../g)!)w.u8(parseInt(n,16));w.i32(4002).i32(4002).i32(0).i32(0);c.receive(w.finish());};
    return{c,sent,other,preview,dispatch,delta,mutation,step:()=>{now+=1000;c.tick();}};}
  it('previews without sending, then one send excludes every other owner until exact receipt',()=>{
    const s=live();s.preview();expect(s.sent).toEqual([]);s.dispatch();
    expect(()=>s.c.start(DEFAULT_SETTINGS)).toThrow();expect(()=>s.c.perform('command',{type:'equip',bagId:20001,equipped:true})).toThrow();
    expect(()=>s.c.perform('social',{type:'chat',channel:0,text:'Hi'})).toThrow();expect(()=>s.c.perform('socketPreview',{targetBagId:20001,cardBagId:4002,policy:DEFAULT_AUTOMATION})).toThrow();
    s.step();expect(s.sent).toHaveLength(1);s.delta();expect(s.c.snapshot().socket.pending).toBe(true);s.mutation();expect(s.c.snapshot().socket.state).toBe('confirmed');expect(s.other).toEqual([]);
  });
  it('Stop retains pending receipt; late exact packets drain without resuming or retrying',()=>{
    const s=live();s.dispatch();s.c.stop();for(let i=0;i<3;i++)s.step();expect(s.c.snapshot().socket.state).toBe('uncertain');
    s.mutation();s.delta();expect(s.c.snapshot().socket.state).toBe('confirmed');expect(s.c.runRequested).toBe(false);expect(s.sent).toHaveLength(1);
  });
  it('honors current visible reserves, detaches them and refuses changed policy without starting a run',()=>{
    const s=live(),historical=structuredClone(DEFAULT_AUTOMATION);historical.items=[{itemId:4002,resource:'hp',belowPercent:50,minStock:99,cooldownSeconds:1}];
    s.c.engine.settings={...DEFAULT_SETTINGS,automation:historical};
    const visible=structuredClone(DEFAULT_AUTOMATION);
    s.c.perform('socketPreview',{targetBagId:20001,cardBagId:4002,policy:visible});const p=s.c.snapshot().socket.preview!;
    expect(p.card.reserve).toBe(0);expect(s.c.runRequested).toBe(false);expect(s.sent).toEqual([]);
    visible.disposition={maxSpend:0,rules:[{itemId:4002,keep:2,minimum:2,desired:2,maximum:2,store:false,sell:false,cart:false,restock:'off',allowUnique:false}]};
    expect(s.c.snapshot().socket.preview?.card.reserve).toBe(0);
    expect(()=>s.c.perform('socket',{targetBagId:20001,cardBagId:4002,previewToken:p.previewToken,policy:visible})).toThrow('stale');
    visible.disposition.rules[0]!.keep=3;visible.disposition.rules[0]!.minimum=3;visible.disposition.rules[0]!.desired=3;visible.disposition.rules[0]!.maximum=3;
    expect(()=>s.c.perform('socketPreview',{targetBagId:20001,cardBagId:4002,policy:visible})).toThrow('reserve');expect(s.sent).toEqual([]);
  });
  it('uses Enter-matched actor identity including zero, and rejects pre-Enter or reused own actors',()=>{
    const s=live();s.c.engine.receive([{type:'enter',id:0,map:'prontera'},{type:'spawn',entity:{id:0,kind:0,classId:0,name:'Zero',hp:100,maxHp:100,level:1,x:1,y:1,dead:false}},
      {type:'inventory',items:[weapon(),card()],equipment:Array(10).fill(0),ammoId:-1}]);
    s.preview();expect(s.c.snapshot().socket.preview).not.toBeNull();
    s.c.connect(true);s.c.engine.receive([{type:'map',map:'prontera'},{type:'spawn',entity:{id:0,kind:0,classId:0,name:'Zero',hp:100,maxHp:100,level:1,x:1,y:1,dead:false}},
      {type:'inventory',items:[weapon(),card()],equipment:Array(10).fill(0),ammoId:-1}]);expect(()=>s.preview()).toThrow();expect(s.sent).toEqual([]);
  });
  it('rejects official-client observed casting and retires its preview until an exact cast stop',()=>{
    const s=live();s.preview();s.c.engine.receive([{type:'castStart',id:1,skillId:11,level:1,position:{x:1,y:1},remainingSeconds:5,flags:0}]);
    s.step();expect(s.c.snapshot().socket.preview).toBeNull();expect(()=>s.preview()).toThrow('settle');expect(s.sent).toEqual([]);
    s.c.engine.receive([{type:'castStop',id:1}]);s.preview();expect(s.c.snapshot().socket.preview).not.toBeNull();expect(s.sent).toEqual([]);
  });
});
