import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompanionController } from './controller';
import { PersistentFieldRun } from './reconnect';
import { DEFAULT_AUTOMATION, DEFAULT_SETTINGS } from './settings';
import { validStatus } from './game-status';
import { UpdateContinuationOwner, validateUpdateContinuation, type UpdateContinuation } from './update-continuation';
import { MacroRuntime, type MacroScript } from './macros';

const account = { username: 'synthetic', characterSlot: 1, mode: 'botOnly' as const };
const requestId = 'a'.repeat(32);
function fixture() {
  const now=Date.now();
  const settings={...DEFAULT_SETTINGS,map:'prt_fild08',targets:[4000],automation:structuredClone(DEFAULT_AUTOMATION)};
  settings.automation.limits.kills=3;
  const controller=new CompanionController(()=>{},()=>now);
  controller.connect(true);controller.engine.receive([{type:'enter',id:1,map:settings.map},
    {type:'spawn',entity:{id:1,kind:0,classId:0,name:'Fixture',level:7,hp:100,maxHp:100,x:100,y:100,dead:false}}]);
  controller.world.reset(settings.map);
  const status={...controller.snapshot(),runRequested:true,sessionId:'old',reconnectAvailable:true,
    login:{phase:'complete' as const,message:''},mapInfo:{code:settings.map,name:'Field',source:'observed' as const,monsters:[]}};
  expect(validStatus(status)).toBe(true);
  const field=new PersistentFieldRun(()=>now);field.begin(settings,'Fixture','old');
  const runtime:UpdateContinuation['runtime']={version:1,frozenAt:now,status,settings,macro:null,
    partyHeal:{version:1,attempts:0,confirmed:0,cooldownUntil:0},run:{startedAt:now,kills:0,pickups:0,deaths:0}};
  const continuation:UpdateContinuation={version:1,account,form:{version:1,revision:2,selectedProfileId:'fixture',settings},
    field:field.checkpoint()!,runtime,savedAccount:true};
  const invoke=vi.fn(async (_command:string,_args?:Record<string,unknown>):Promise<unknown>=>undefined);
  const owner=new UpdateContinuationOwner(invoke,()=>requestId,500);
  const restoredField=new PersistentFieldRun(()=>now);
  const fresh={...status,sessionId:'next',runRequested:false,kills:0,looted:0,deaths:0,attacks:0};
  return {owner,invoke,continuation,field:restoredField,fresh,runtime};
}
afterEach(()=>vi.useRealTimers());
describe('one-shot updater continuation owner',()=>{
  it('applies final frozen counters before observing the successor and sends remaining field limits',async()=>{
    const f=fixture();f.continuation.runtime.status.kills=2;
    f.owner.claim(f.continuation,f.field);expect(f.field.metrics.kills).toBe(2);
    f.field.observe(f.fresh);
    const resumed=f.owner.resume(f.fresh,account,f.field);
    expect(f.invoke).toHaveBeenCalledWith('update_restore',expect.objectContaining({requestId,
      settings:expect.objectContaining({automation:expect.objectContaining({limits:expect.objectContaining({kills:1})})})}));
    f.owner.restored({requestId,success:true});expect(await resumed).toBe(true);expect(f.owner.pending).toBe(false);
    expect(await f.owner.resume(f.fresh,account,f.field)).toBe(false);
  });
  it('does not auto-login without a saved matching account',()=>{
    const f=fixture();f.continuation.savedAccount=false;f.owner.claim(f.continuation,f.field);
    expect(f.owner.needsSignIn).toBe(true);expect(f.owner.automaticLogin(account)).toBe(false);
    expect(f.invoke).not.toHaveBeenCalled();
    const g=fixture();g.owner.claim(g.continuation,g.field);
    expect(g.owner.automaticLogin(account)).toBe(true);
    for(const profile of [null,{...account,username:'other'},{...account,characterSlot:2},{...account,mode:'gameClient' as const}])
      expect(g.owner.automaticLogin(profile)).toBe(false);
  });
  it('waits for matching account, character and new compatible page',async()=>{
    const f=fixture();f.owner.claim(f.continuation,f.field);
    for(const status of [f.continuation.runtime.status,{...f.fresh,compatible:false},
      {...f.fresh,player:{...f.fresh.player!,name:'Other'}}])expect(await f.owner.resume(status,account,f.field)).toBe(false);
    expect(await f.owner.resume(f.fresh,{...account,characterSlot:0},f.field)).toBe(false);
    expect(f.invoke).not.toHaveBeenCalled();
  });
  it('Stop rejects a delayed restore and late acknowledgement cannot revive continuation',async()=>{
    const f=fixture();f.owner.claim(f.continuation,f.field);
    const resumed=f.owner.resume(f.fresh,account,f.field);const rejected=expect(resumed).rejects.toThrow(/cancelled/);
    const cancelled=f.owner.cancel();f.field.stop();f.owner.restored({requestId,success:true});
    await rejected;await cancelled;expect(f.owner.pending).toBe(false);expect(f.field.requested).toBe(false);
    expect(await f.owner.resume(f.fresh,account,f.field)).toBe(false);
  });
  it('discards a delayed recovery claim when Stop wins during the native reply',async()=>{
    const f=fixture();let reply!:(value:unknown)=>void;
    const load=new Promise<unknown>(resolve=>{reply=resolve;});
    const claim=f.owner.claimFrom(load,f.field,true);
    await f.owner.cancel();reply(f.continuation);
    expect(await claim).toBeNull();expect(f.owner.pending).toBe(false);expect(f.field.requested).toBe(false);
    expect(f.owner.automaticLogin(account)).toBe(false);
  });
  it('holds a timed-out restore without blindly sending a second activation',async()=>{
    vi.useFakeTimers();const f=fixture();f.owner.claim(f.continuation,f.field);
    const resumed=f.owner.resume(f.fresh,account,f.field);const rejected=expect(resumed).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(500);await rejected;
    expect(await f.owner.resume(f.fresh,account,f.field)).toBe(false);expect(f.invoke).toHaveBeenCalledTimes(1);
    await f.owner.cancel();
  });
  it('matches reply kind and owner, and cancels a pending preparation',async()=>{
    const f=fixture(),prepared=f.owner.prepare(),rejected=expect(prepared).rejects.toThrow(/cancelled/);
    f.owner.restored({requestId,success:true});f.owner.prepared({requestId:'b'.repeat(32),checkpoint:f.runtime});
    await f.owner.cancel();await rejected;
    f.owner.prepared({requestId,checkpoint:f.runtime});expect(f.owner.pending).toBe(false);
  });
  it('resumes a macro ledger with no field checkpoint rather than issuing Start macro again',async()=>{
    const f=fixture();const script:MacroScript={version:1,name:'Monitor',durationSeconds:0,maxActions:0,maxSpend:0,
      rules:[{name:'One farm',priority:0,cooldownSeconds:0,maxRuns:1,conditions:[{field:'level',operator:'gte',value:1}],
        steps:[{type:'farm',map:'prt_fild08',targets:[4000],timeoutSeconds:20}]}]};
    const macro=new MacroRuntime();macro.start(script);macro.tick({level:7});macro.acknowledge(1,true);
    f.continuation.field=null;f.continuation.runtime.macro=macro.checkpoint()!;
    f.continuation.runtime.frozenAt=Date.now();
    f.continuation.runtime.status.macro=macro.snapshot();
    f.owner.claim(f.continuation,f.field);const resumed=f.owner.resume(f.fresh,account,f.field);
    expect(f.invoke).toHaveBeenCalledWith('update_restore',{requestId,checkpoint:f.continuation.runtime});
    f.owner.restored({requestId,success:true});expect(await resumed).toBe(true);
    expect(f.field.requested).toBe(false);
  });
  it('rejects malformed or mismatched continuation before restoring field intent',()=>{
    for(const mutate of [
      (c:Record<string,unknown>)=>{c.password='forbidden';},
      (c:Record<string,unknown>)=>{c.version=2;},
      (c:Record<string,unknown>)=>{c.savedAccount='true';},
      (c:Record<string,unknown>)=>{(c.account as Record<string,unknown>).characterSlot=3;},
      (c:Record<string,unknown>)=>{(c.field as Record<string,unknown>).character='Other';},
      (c:Record<string,unknown>)=>{(c.runtime as Record<string,unknown>).frozenAt=Number.MAX_SAFE_INTEGER;},
    ]){
      const f=fixture(),bad:Record<string,unknown>=structuredClone(f.continuation) as unknown as Record<string,unknown>;mutate(bad);
      expect(()=>f.owner.claim(bad,f.field)).toThrow();expect(f.field.requested).toBe(false);expect(f.owner.pending).toBe(false);
    }
    const f=fixture();expect(validateUpdateContinuation(f.continuation).form.selectedProfileId).toBe('fixture');
  });
});
