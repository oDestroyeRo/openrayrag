import { describe, expect, it } from 'vitest';
import { clientDashboard } from './client-dashboard';
import { DEFAULT_AUTOMATION, DEFAULT_SETTINGS } from '../settings/settings';
import { DEFAULT_RECOVERY_ITEMS, DEFAULT_SP_ITEMS } from '../recovery/recovery-items';

const context = { fieldRequested: false, held: false, limitReason: '', loginBusy: false };
const settings = { ...DEFAULT_SETTINGS, automation: {
  ...structuredClone(DEFAULT_AUTOMATION), hpPotions: structuredClone(DEFAULT_RECOVERY_ITEMS), spPotions: structuredClone(DEFAULT_SP_ITEMS),
} };
const recoveryOff = 'Sitting off · HP items off · SP items off · Respawn off';

describe('Run dashboard presentation', () => {
  it('describes failed current-field admission without claiming readiness or retained target eligibility',()=>{
    const current={...settings,map:'prt_fild08',targets:[]};
    expect(clientDashboard({player:{},compatible:true}, {...context,setupReason:'Choose selected monsters or disable selected combat.'},current))
      .toMatchObject({state:'SETUP',headline:'Setup needs attention',setup:`No targets selected · Own drops · ${recoveryOff}`});
  });
  it.each([
    ['retaliate', [], 'Defend against attackers'],
    ['both', [1002], '1 selected targets + defense'],
  ] as const)('shows %s defense in the setup summary without implying an active attack', (mode, targets, summary) => {
    const configured = { ...settings, targets: [...targets], automation: structuredClone(settings.automation) };
    configured.automation.combat.mode = mode;
    expect(clientDashboard(null, context, configured)).toMatchObject({
      state: 'OFFLINE', headline: 'Connect your character', setup: `${summary} · Own drops · ${recoveryOff}`,
    });
  });

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
    const configured = { ...settings, map: 'prt_fild08', targets: [1002], automation: structuredClone(settings.automation) };
    configured.automation.loot.ownership = 'all'; configured.automation.recovery.enabled = true;
    const before = structuredClone(configured);
    const mapInfo = { code: 'prt_fild08', name: 'Field', source: 'database' as const, monsters: [{ classId: 1002, name: 'Poring', level: 1, maxHp: 10, spawnCount: 10, visibleCount: 0 }] };
    const recovery = 'Sitting on (HP unobserved; SP unobserved) · HP items off · SP items off · Respawn off';
    expect(clientDashboard(null, context, configured, mapInfo).setup).toBe(`Poring · All drops · ${recovery}`);
    expect(clientDashboard(null, context, configured, { ...mapInfo, code: 'prontera' }).setup).toBe(`1 selected targets · All drops · ${recovery}`);
    expect(configured).toEqual(before);
    expect(clientDashboard(null, context, null).setup).toBe('Setup needs attention · review your settings');
  });

  it.each(Array.from({ length: 16 }, (_, modes) => [modes] as const))('reports independently configured recovery modes for combination %i', modes => {
    const configured = { ...settings, automation: structuredClone(settings.automation) };
    configured.automation.recovery.enabled = (modes & 1) !== 0;
    configured.automation.hpPotions!.mode = (modes & 2) !== 0 ? 'any' : 'off';
    configured.automation.spPotions!.mode = (modes & 4) !== 0 ? 'selected' : 'off';
    configured.automation.spPotions!.itemIds = [505];
    configured.automation.respawn.enabled = (modes & 8) !== 0;
    const summary = clientDashboard(null, context, configured).setup;
    expect(summary).toContain((modes & 1) !== 0 ? 'Sitting on' : 'Sitting off');
    expect(summary).toContain((modes & 2) !== 0 ? 'HP items: any carried (stock unobserved; HP unobserved)' : 'HP items off');
    expect(summary).toContain((modes & 4) !== 0 ? 'SP items: 1 selected (stock unobserved; SP unobserved)' : 'SP items off');
    expect(summary).toContain((modes & 8) !== 0 ? 'Respawn on' : 'Respawn off');
  });

  it('keeps configured item choices separate from missing, carried and reserved stock', () => {
    const configured = { ...settings, automation: structuredClone(settings.automation) };
    configured.automation.hpPotions!.mode = 'any';
    configured.automation.hpPotions!.minStock = 3;
    configured.automation.spPotions!.mode = 'selected'; configured.automation.spPotions!.itemIds = [505];
    const snapshot = { player: { hp: 100, maxHp: 100 }, character: {
      stats: { sp: 20, maxSp: 100 }, inventoryKnown: true, inventory: [{ itemId: 501, count: 1 }, { itemId: 501, count: 2 }],
    } };
    const before = structuredClone({ configured, snapshot });
    expect(clientDashboard(snapshot, context, configured).setup).toContain('Sitting off · HP items: any carried (3 carried; no usable stock) · SP items: 1 selected (0 carried; no usable stock) · Respawn off');
    expect(clientDashboard({ ...snapshot, character: { ...snapshot.character, inventoryKnown: false } }, context, configured).setup)
      .toContain('HP items: any carried (stock unobserved) · SP items: 1 selected (stock unobserved)');
    expect(clientDashboard({ ...snapshot, character: { ...snapshot.character, inventory: [{ itemId: 501, count: -1 }] } }, context, configured).setup)
      .toContain('HP items: any carried (stock unobserved)');
    expect({ configured, snapshot }).toEqual(before);
  });

  it('includes advanced recovery rules when simple item recovery is off without counting the same stock twice', () => {
    const configured = { ...settings, automation: structuredClone(settings.automation) };
    configured.automation.items = [
      { itemId: 501, resource: 'hp', belowPercent: 60, minStock: 0, cooldownSeconds: 5 },
      { itemId: 505, resource: 'sp', belowPercent: 30, minStock: 0, cooldownSeconds: 5 },
    ];
    const snapshot = { player: { hp: 100, maxHp: 100 }, character: {
      stats: { sp: 20, maxSp: 100 }, inventoryKnown: true, inventory: [{ itemId: 501, count: 3 }, { itemId: 505, count: 2 }],
    } };
    expect(clientDashboard(snapshot, context, configured).setup).toContain('HP items: 1 rule (3 carried) · SP items: 1 rule (2 carried)');
    configured.automation.hpPotions!.mode = 'selected'; configured.automation.hpPotions!.itemIds = [501];
    expect(clientDashboard(snapshot, context, configured).setup).toContain('HP items: 1 selected + 1 rule (3 carried)');
  });

  it('uses the larger shared-item reserve and advanced-rule precedence when describing usable stock', () => {
    const configured = { ...settings, automation: structuredClone(settings.automation) };
    configured.automation.hpPotions = { ...DEFAULT_RECOVERY_ITEMS, mode: 'selected', itemIds: [518], minStock: 1 };
    configured.automation.spPotions = { ...DEFAULT_SP_ITEMS, mode: 'selected', itemIds: [518], minStock: 5 };
    const snapshot = { player: { hp: 100, maxHp: 100 }, character: {
      stats: { sp: 20, maxSp: 100 }, inventoryKnown: true, inventory: [{ itemId: 518, count: 5 }],
    } };
    expect(clientDashboard(snapshot, context, configured).setup).toContain('HP items: 1 selected (5 carried; no usable stock) · SP items: 1 selected (5 carried; no usable stock)');
    configured.automation.spPotions.mode = 'off';
    expect(clientDashboard(snapshot, context, configured).setup).toContain('HP items: 1 selected (5 carried) · SP items off');
    configured.automation.spPotions.mode = 'selected';
    configured.automation.items = [{ itemId: 518, resource: 'hp', belowPercent: 60, minStock: 0, cooldownSeconds: 5 }];
    expect(clientDashboard(snapshot, context, configured).setup).toContain('HP items: 1 selected + 1 rule (5 carried) · SP items: 1 selected (5 carried; no usable stock)');
    configured.automation.items[0]!.minStock = 5;
    expect(clientDashboard(snapshot, context, configured).setup).toContain('HP items: 1 selected + 1 rule (5 carried; no usable stock)');
  });

  it('keeps sitting configured when novice skill or SP prerequisites are unavailable', () => {
    const configured = { ...settings, automation: structuredClone(settings.automation) };
    configured.automation.recovery.enabled = true;
    const snapshot = { player: { classId: 0, hp: 50, maxHp: 100 }, character: { skillsKnown: false, learned: [] } };
    expect(clientDashboard(snapshot, context, configured).setup).toContain('Sitting on (Basic Mastery unverified; SP unobserved)');
    expect(clientDashboard({ ...snapshot, character: { skillsKnown: true, learned: [{ skillId: 1, level: 1 }], stats: { sp: 10, maxSp: 100 } } }, context, configured).setup)
      .toContain('Sitting on (Basic Mastery below 2)');
    expect(clientDashboard({ ...snapshot, character: { skillsKnown: true, learned: [{ skillId: 1, level: 2 }], stats: { sp: 10, maxSp: 100 } } }, context, configured).setup)
      .toContain('Sitting on · HP items off');
  });
});
