import { describe, expect, it } from 'vitest';
import { clientDashboard } from './client-dashboard';
import { DEFAULT_AUTOMATION, DEFAULT_SETTINGS } from './settings';

const context = { fieldRequested: false, held: false, limitReason: '', loginBusy: false };
const settings = { ...DEFAULT_SETTINGS, automation: structuredClone(DEFAULT_AUTOMATION) };

describe('Run dashboard presentation', () => {
  it('shows offline and unknown state without inventing character or activity evidence', () => {
    expect(clientDashboard(null, context, settings)).toMatchObject({ state: 'OFFLINE', headline: 'Connect your character' });
    expect(clientDashboard({ connected: true, compatible: false }, context, settings).headline).toBe('Choose your character');
    expect(clientDashboard({ running: true, target: 'Poring' }, context, settings).headline).toBe('Bot running');
  });
  it('uses the observed controller task label only during an active run', () => {
    expect(clientDashboard({ running: true, task: { kind: 'attack', pending: true, label: 'Walking toward Poring' }, reason: 'Confirmed safe route.' }, context, settings))
      .toMatchObject({ state: 'RUNNING', headline: 'Walking toward Poring', reason: 'Walking toward Poring' });
    expect(clientDashboard({ running: true, task: { kind: 'idle', pending: false, label: 'Ready. Choose your targets and press Start.' } }, context, settings).headline).toBe('Bot running');
    expect(clientDashboard({ running: false, player: {}, compatible: true, task: { label: 'Attacking Poring' } }, context, settings).headline).toBe('Ready to start');
  });
  it.each([
    { refine: { blocked: true, reason: 'Waiting for the exact refine transaction; disconnect cannot resolve it.' } },
    { warp: { blocked: true, reason: 'Waiting for authoritative Warp initialization; do not repeat the request.' } },
  ])('keeps an unresolved owner’s complete reason and waiting headline', owner => {
    const view = clientDashboard({ ...owner, reason: 'Stopped by you.' }, { ...context, held: true }, settings);
    expect(view.state).toBe('WAITING'); expect(view.headline).toBe('Waiting to continue');
    expect(view.reason).toBe(owner.refine?.reason ?? owner.warp?.reason);
  });
  it('retains a configured death-limit reason independently of an old active task', () => {
    expect(clientDashboard({ running: true, task: { label: 'Attacking Poring' } }, { ...context, fieldRequested: true, limitReason: 'Death limit reached: 1 / 1.' }, settings))
      .toMatchObject({ state: 'WAITING', headline: 'Waiting to continue', reason: 'Death limit reached: 1 / 1.' });
  });
  it('waits for fresh connected status without replacing owner or run-limit reasons', () => {
    const connected = { connected: true, compatible: true, player: {}, reason: 'Last observed field status.' };
    const stale = { ...context, fresh: false };
    expect(clientDashboard(connected, stale, settings)).toMatchObject({ state: 'READY', headline: 'Waiting for fresh game status', reason: connected.reason });
    expect(clientDashboard({ ...connected, running: true, task: { kind: 'attack', pending: true, label: 'Attacking Poring' } }, { ...stale, held: true }, settings))
      .toMatchObject({ state: 'RUNNING', headline: 'Waiting for fresh game status', reason: 'Attacking Poring' });
    expect(clientDashboard({ ...connected, refine: { blocked: true, reason: 'Waiting for an exact refine receipt.' } }, { ...stale, held: true }, settings))
      .toMatchObject({ state: 'WAITING', headline: 'Waiting to continue', reason: 'Waiting for an exact refine receipt.' });
    expect(clientDashboard(connected, { ...stale, limitReason: 'Death limit reached.', fieldRequested: true }, settings))
      .toMatchObject({ state: 'WAITING', headline: 'Waiting to continue', reason: 'Death limit reached.' });
  });
  it('summarizes current setup without altering it or borrowing names from another field', () => {
    const configured = { ...settings, map: 'prt_fild08', targets: [1002], automation: structuredClone(DEFAULT_AUTOMATION) };
    configured.automation.loot.ownership = 'all'; configured.automation.recovery.enabled = true;
    const before = structuredClone(configured);
    const mapInfo = { code: 'prt_fild08', name: 'Field', source: 'database' as const, monsters: [{ classId: 1002, name: 'Poring', level: 1, maxHp: 10, spawnCount: 10, visibleCount: 0 }] };
    expect(clientDashboard(null, context, configured, mapInfo).setup).toBe('Poring · All drops · Recovery on');
    expect(clientDashboard(null, context, configured, { ...mapInfo, code: 'prontera' }).setup).toBe('1 selected targets · All drops · Recovery on');
    expect(configured).toEqual(before);
    expect(clientDashboard(null, context, null).setup).toBe('Setup needs attention · review your settings');
  });
});
