import { describe, expect, it, vi } from 'vitest';
import { clientStatus, clientSp, clientDeaths, clientDeathCap } from './client-status';
import { CompanionController } from '../runtime/controller';

const context = { fieldRequested: false, held: false, limitReason: '', loginBusy: false };
const ready = { connected: true, compatible: true, running: false, runRequested: false, player: { name: 'Synthetic' }, login: { phase: 'idle', message: '' }, reason: 'Stopped by you.' };

describe('current owner presentation', () => {
  it('presents current-field admission failure as setup work without replacing an active owner',()=>{
    const setupReason='Choose selected monsters or disable selected combat.';
    expect(clientStatus(ready,{...context,setupReason})).toEqual({state:'SETUP',reason:setupReason});
    expect(clientStatus({...ready,running:true},{...context,setupReason}).state).toBe('RUNNING');
    expect(clientStatus({...ready,refine:{blocked:true,reason:'Waiting for the exact receipt.'}},{...context,setupReason,held:true}))
      .toEqual({state:'WAITING',reason:'Waiting for the exact receipt.'});
  });
  it('shows fresh held manual work as WAITING and returns READY only after it settles', () => {
    const pending = { ...ready, refine: { blocked: true, reason: 'Waiting for the refine transaction to reconcile.' } };
    const before = structuredClone(pending);
    expect(clientStatus(pending, { ...context, held: true })).toEqual({ state: 'WAITING', reason: pending.refine.reason });
    expect(pending).toEqual(before);
    expect(clientStatus(ready, context)).toEqual({ state: 'READY', reason: ready.reason });
  });
  it('presents the actual requested-run reason while retaining the idle official refine warning',()=>{
    const refine={blocked:true,reason:'Official refine resources remain unknown.'};
    expect(clientStatus({...ready,runRequested:true,running:true,reason:'Attacking Poring.',refine},context))
      .toEqual({state:'RUNNING',reason:'Attacking Poring.'});
    expect(clientStatus({...ready,refine},{...context,held:true}))
      .toEqual({state:'WAITING',reason:refine.reason});
    expect(clientStatus({...ready,runRequested:true,reason:refine.reason,refine},context).reason).toBe(refine.reason);
  });
  it('projects an optional held Warp owner and explains a bare Stop without releasing it', () => {
    const stopped = { ...ready, warp: { blocked: true, reason: 'Stopped by you.' } };
    const view = clientStatus(stopped, context);
    expect(view.state).toBe('WAITING');
    expect(view.reason).toContain('Stopped by you.');
    expect(view.reason).toContain('Automation is held until verified recovery');
    expect(view.reason).toContain('reconnect alone do not release the hold');
    expect(stopped.warp.blocked).toBe(true);
    const exact = 'Selection is unresolved; waiting for authoritative resource reconciliation.';
    expect(clientStatus({ ...stopped, warp: { blocked: true, reason: exact } }, context).reason).toBe(exact);
  });
  it('presents the actual controller hold after Stop without sending or reconciling anything', () => {
    const transport=vi.fn();let persisted=false;
    const controller=new CompanionController(transport,()=>1000,()=>null,transport,transport,transport,transport,transport,{read:()=>persisted,write:value=>{persisted=value;}});
    controller.warp.externalWarp();
    const held=controller.snapshot();
    expect(held.warp.blocked).toBe(true);expect(persisted).toBe(true);
    expect(clientStatus(held,context)).toEqual({state:'WAITING',reason:held.warp.reason});
    controller.stop();
    const stopped=controller.snapshot();
    expect(stopped).toMatchObject({running:false,runRequested:false,reason:'Stopped by you.',warp:{blocked:true,reason:'Stopped by you.'}});
    const view=clientStatus(stopped,context);
    expect(view.state).toBe('WAITING');expect(view.reason).toContain('Stopped by you.');
    expect(view.reason).toContain('Automation is held until verified recovery');
    expect(controller.snapshot()).toEqual(stopped);expect(persisted).toBe(true);expect(transport).not.toHaveBeenCalled();
  });
  it('preserves field limit and login message precedence above current owner reasons', () => {
    const pending = { ...ready, actionResult: { status: 'pending', reason: 'Waiting for exact equipment readback.' } };
    expect(clientStatus(pending, { ...context, held: true }).reason).toBe(pending.actionResult.reason);
    expect(clientStatus(pending, { ...context, held: true, limitReason: 'Death limit reached.' }).reason).toBe('Death limit reached.');
    expect(clientStatus({ ...pending, login: { phase: 'failed', message: 'Sign-in failed.' } }, { ...context, held: true }).reason).toBe('Sign-in failed.');
    expect(clientStatus(pending, { ...context, loginBusy: true }).reason).toBe('Loading the game for automatic sign-in…');
  });
  it('retains running, requested, connected and offline presentation priorities', () => {
    expect(clientStatus({ ...ready, running: true }, { ...context, held: true }).state).toBe('RUNNING');
    expect(clientStatus({ ...ready, running: true }, { ...context, fieldRequested: true, limitReason: 'Limit reached.' }).state).toBe('WAITING');
    expect(clientStatus(ready, { ...context, fieldRequested: true }).state).toBe('WAITING');
    expect(clientStatus({ ...ready, runRequested: true }, context).state).toBe('WAITING');
    expect(clientStatus({ ...ready, player: null }, context).state).toBe('CONNECTED');
    expect(clientStatus({ ...ready, player: null, connected: false }, context).state).toBe('OFFLINE');
  });
});

describe('observed session readouts', () => {
  it('uses observed SP only and bounds the visual meter without changing the readout', () => {
    expect(clientSp({ sp: 0, maxSp: 200 })).toEqual({ text: '0 / 200', width: '0%' });
    expect(clientSp({ sp: 75, maxSp: 200 })).toEqual({ text: '75 / 200', width: '37.5%' });
    expect(clientSp({ sp: 201, maxSp: 200 })).toEqual({ text: '201 / 200', width: '100%' });
    for (const value of [null, {}, { sp: null, maxSp: 200 }, { sp: 1, maxSp: 0 }, { sp: -1, maxSp: 200 }, { sp: Infinity, maxSp: 200 }]) expect(clientSp(value)).toEqual({ text: '— / —', width: '0%' });
  });
  it('distinguishes unknown deaths, disabled policy and saved legacy zero', () => {
    expect(clientDeaths(0)).toBe('0'); expect(clientDeaths(7)).toBe('7');
    for (const value of [undefined, null, Infinity, -1]) expect(clientDeaths(value)).toBe('—');
    expect(clientDeathCap({ enabled: false, maxDeaths: 1 })).toBe('Off');
    expect(clientDeathCap({ enabled: true, maxDeaths: 0 })).toBe('0 (legacy cap)');
    expect(clientDeathCap({ enabled: true, maxDeaths: 3 })).toBe('3');
    for (const value of [undefined, {}, { enabled: true, maxDeaths: -1 }, { enabled: true, maxDeaths: 101 }]) expect(clientDeathCap(value)).toBe('—');
  });
});
