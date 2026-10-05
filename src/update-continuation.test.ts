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

function pending<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function settle() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
function installationFixture() {
  const f = fixture();
  const nonce = 'f'.repeat(32);
  const adapter = {
    flush: vi.fn(async () => f.continuation.form),
    game: vi.fn(() => ({ open: true, status: f.fresh })),
    interrupted: vi.fn(() => false),
    status: vi.fn(),
  };
  f.invoke.mockImplementation(async command => {
    if (command === 'update_reserve') return nonce;
    if (command === 'update_install') return true;
    if (command === 'update_continuation') return null;
    return undefined;
  });
  const calls = (command: string) => f.invoke.mock.calls.filter(call => call[0] === command);
  return { ...f, adapter, nonce, calls, install: () => f.owner.install(f.field, adapter) };
}
describe('update installation transaction', () => {
  it('flushes before reservation and bounds unconfirmed installation to 20 retries before release', async () => {
    vi.useFakeTimers();
    const f = installationFixture(), saving = pending<typeof f.continuation.form>(), reservation = pending<string>();
    f.adapter.flush.mockReturnValue(saving.promise);
    f.invoke.mockImplementation(async command => {
      if (command === 'update_reserve') return reservation.promise;
      if (command === 'update_install') return false;
      return undefined;
    });
    const installation = f.install();
    expect(f.adapter.status).toHaveBeenLastCalledWith('Saving current settings before updating.');
    expect(f.calls('update_reserve')).toEqual([]);
    saving.resolve(f.continuation.form); await settle();
    expect(f.adapter.status).toHaveBeenLastCalledWith('Preparing the connection for update confirmation.');
    expect(f.calls('update_install')).toEqual([]);
    reservation.resolve(f.nonce); await settle();
    await vi.advanceTimersByTimeAsync(2100); await installation;
    expect(f.calls('update_install')).toHaveLength(20);
    expect(f.calls('update_release')).toEqual([['update_release', { nonce: f.nonce }]]);
    expect(f.calls('update_cancel')).toEqual([['update_cancel', { stop: false }]]);
    expect(f.adapter.status).toHaveBeenLastCalledWith('Update waits for game confirmation that all actions have stopped. It will retry automatically.');
    expect(JSON.stringify(f.adapter.status.mock.calls)).not.toContain(f.nonce);
  });
  it('reserves frozen final counters after preparation without renewing the original field allowances', async () => {
    const f = installationFixture();
    f.field.restore(f.continuation.field);
    f.runtime.status.kills = 2;
    const installation = f.install(); await settle();
    expect(f.calls('update_prepare')).toHaveLength(1);
    expect(f.calls('update_reserve')).toEqual([]);
    f.owner.prepared({ requestId, checkpoint: f.runtime }); await installation;
    expect(f.calls('update_reserve')[0]?.[1]).toMatchObject({
      document: f.continuation.form,
      continuation: { version: 1, field: { totals: { kills: 2 }, desired: { automation: { limits: { kills: 3 } } } } },
    });
    expect(f.calls('update_install')).toHaveLength(1);
    expect(f.calls('update_release')).toHaveLength(1);
  });
  it.each([
    ['Waiting for a fresh stopped client before updating.', 'The connection has not confirmed a fresh stopped state.'],
    ['Waiting for login to settle.', 'Sign-in has not finished.'],
    ['synthetic-private-account-path', 'The connection could not be prepared for update confirmation.'],
    [new Error('synthetic-private-account-path'), 'The connection could not be prepared for update confirmation.'],
    ['toString', 'The connection could not be prepared for update confirmation.'],
  ])('bounds reservation diagnostics for %s', async (error, reason) => {
    const f = installationFixture();
    f.invoke.mockImplementation(async command => { if (command === 'update_reserve') throw error; });
    await f.install();
    expect(f.calls('update_install')).toEqual([]);
    expect(f.calls('update_release')).toEqual([]);
    expect(f.adapter.status).toHaveBeenLastCalledWith(`Update deferred. ${reason} It will retry automatically.`);
    expect(JSON.stringify(f.adapter.status.mock.calls)).not.toContain('synthetic-private-account-path');
  });
  it('releases a changed game confirmation and reports a generic retryable diagnostic', async () => {
    const f = installationFixture();
    f.invoke.mockImplementation(async command => {
      if (command === 'update_reserve') return f.nonce;
      if (command === 'update_install') throw 'Update settlement changed.';
      return undefined;
    });
    await f.install();
    expect(f.calls('update_release')).toEqual([['update_release', { nonce: f.nonce }]]);
    expect(f.adapter.status).toHaveBeenLastCalledWith('Update deferred. Game activity changed during update confirmation. It will retry automatically.');
  });
  it('stops before reservation when Close interrupts the pending settings flush', async () => {
    const f = installationFixture(), saving = pending<typeof f.continuation.form>();
    f.adapter.flush.mockReturnValue(saving.promise);
    const installation = f.install(); f.adapter.interrupted.mockReturnValue(true);
    saving.resolve(f.continuation.form); await installation;
    expect(f.calls('update_reserve')).toEqual([]);
    expect(f.calls('update_install')).toEqual([]);
    expect(f.calls('update_cancel')).toHaveLength(1);
  });
  it.each(['settings', 'reserve', 'install', 'release', 'recovery'] as const)('Stop invalidates delayed %s without reviving continuation', async stage => {
    vi.useFakeTimers();
    const f = installationFixture(), delayed = pending<unknown>();
    if (stage === 'settings') f.adapter.flush.mockImplementation(async () => { await delayed.promise; return f.continuation.form; });
    f.invoke.mockImplementation(async command => {
      if (command === `update_${stage}`) return delayed.promise;
      if (command === 'update_reserve') return f.nonce;
      if (command === 'update_install') return true;
      if (command === 'update_continuation') return stage === 'recovery' ? delayed.promise : f.continuation;
      return undefined;
    });
    if (stage === 'release' || stage === 'recovery') f.adapter.game.mockReturnValue({ open: false, status: f.fresh });
    const installation = f.install(); await settle();
    await f.owner.cancel(true); f.field.stop();
    expect(f.owner.stopped).toBe(true); expect(f.owner.pending).toBe(false);
    delayed.resolve(stage === 'reserve' ? f.nonce : stage === 'recovery' ? f.continuation : true);
    await vi.advanceTimersByTimeAsync(100); const result = await installation;
    expect(result.continuation).toBeNull(); expect(f.owner.pending).toBe(false); expect(f.field.requested).toBe(false);
    expect(f.owner.automaticLogin(account)).toBe(false);
    if (stage === 'settings' || stage === 'reserve') expect(f.calls('update_install')).toEqual([]);
    else expect(f.calls('update_install')).toHaveLength(1);
    expect(f.calls('update_release')).toHaveLength(stage === 'settings' ? 0 : 1);
    if (stage === 'release') expect(f.calls('update_continuation')).toEqual([]);
  });
  it('keeps replacement close and resume inside the transaction until same-process recovery is settled', async () => {
    const f = installationFixture(), recovery = pending<unknown>();
    f.field.restore(f.continuation.field);
    f.adapter.game.mockReturnValue({ open: false, status: f.fresh });
    f.invoke.mockImplementation(async command => {
      if (command === 'update_reserve') return f.nonce;
      if (command === 'update_install') return true;
      if (command === 'update_continuation') return recovery.promise;
      return undefined;
    });
    const installation = f.install(); await settle();
    expect(f.owner.gameClosed()).toBe(false);
    await expect(f.install()).rejects.toThrow(/already pending/);
    recovery.resolve(f.continuation); const result = await installation;
    expect(result).toMatchObject({ continuation: f.continuation, retired: false, recoveryFailed: false });
    expect(f.owner.pending).toBe(true); expect(f.field.requested).toBe(true);
    expect(f.owner.gameClosed()).toBe(false); expect(f.calls('update_cancel')).toEqual([]);
    const resumed = f.owner.resume(f.fresh, account, f.field);
    f.owner.restored({ requestId, success: true }); expect(await resumed).toBe(true);
  });
  it('releases even when release fails, retires failed recovery and cancels the remaining native ownership', async () => {
    const f = installationFixture();
    f.adapter.game.mockReturnValue({ open: false, status: f.fresh });
    f.invoke.mockImplementation(async command => {
      if (command === 'update_reserve') return f.nonce;
      if (command === 'update_install') return true;
      if (command === 'update_release') throw new Error('synthetic-private-release');
      if (command === 'update_continuation') throw new Error('synthetic-private-recovery');
      return undefined;
    });
    expect(await f.install()).toEqual({ continuation: null, retired: true, recoveryFailed: true });
    expect(f.calls('update_release')).toHaveLength(1); expect(f.calls('update_cancel')).toHaveLength(1);
    expect(f.owner.gameClosed()).toBe(true);
  });
  it('preserves Stop that wins while startup suppression metadata is pending', async () => {
    const f = installationFixture(), metadata = pending<unknown>();
    f.invoke.mockImplementation(async command => command === 'update_startup_stopped' ? metadata.promise : f.continuation);
    const startup = f.owner.startup(f.field);
    await f.owner.cancel(true); metadata.resolve(false);
    expect(await startup).toBeNull(); expect(f.owner.stopped).toBe(true);
    expect(f.calls('update_continuation')).toEqual([]);
  });
  it('suppresses startup login when native Stop suppression could not be verified', async () => {
    const f = installationFixture();
    f.invoke.mockRejectedValue(new Error('synthetic startup failure'));
    await expect(f.owner.startup(f.field)).rejects.toThrow('synthetic startup failure');
    expect(f.owner.stopped).toBe(true); expect(f.owner.pending).toBe(false);
    expect(f.calls('update_continuation')).toEqual([]);
  });
});
