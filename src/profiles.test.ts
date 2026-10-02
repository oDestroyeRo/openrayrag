import { describe, expect, it } from 'vitest';
import { DEFAULT_AUTOMATION, DEFAULT_SETTINGS, DEFAULT_ESCAPE } from './settings';
import { MAX_PROFILES, PROFILE_STORAGE_KEY, ProfileStore } from './profiles';
import { CurrentForm, formDocument } from './current-form';

const settings = () => ({ ...DEFAULT_SETTINGS, map: 'prt_fild08', targets: [1002] });
function fixture() {
  const data = new Map<string, string>(); let id = 0;
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
  return { data, storage, store: new ProfileStore(storage, () => `profile-${++id}`, () => 100) };
}
describe('named profiles', () => {
  it.each(['own','all'] as const)('keeps the canonical %s pickup scope and master switch through export/import without run evidence', ownership => {
    for(const loot of [false,true]) {
      const f=fixture(),automation=structuredClone(DEFAULT_AUTOMATION);automation.loot.ownership=ownership;
      const saved=f.store.save('Loot policy','Test',{...settings(),loot,automation});
      const imported=f.store.import(f.store.export(saved.id))[0]!;
      expect(imported.settings.loot).toBe(loot);expect(imported.settings.automation!.loot).toEqual(automation.loot);
      expect(Object.keys(imported.settings.automation!.loot)).toEqual(['ownership','defaultAction','rules']);
      expect(f.store.forMap(imported.id,'prt_fild08','Test').settings.automation!.loot.ownership).toBe(ownership);
    }
  });
  it('round-trips optional actor resource conditions and rejects malformed thresholds atomically', () => {
    const f=fixture(),automation=structuredClone(DEFAULT_AUTOMATION);
    automation.items=[{itemId:501,resource:'hp',belowPercent:80,minStock:0,cooldownSeconds:1,conditions:[{field:'actorSpPercent',actor:{scope:'self'},operator:'gte',value:25.5}]}];
    const saved=f.store.save('Resources','',{...settings(),automation});const exported=f.store.export(saved.id);
    expect(f.store.import(exported)[0]?.settings.automation?.items).toEqual(automation.items);
    const malformed=JSON.parse(exported);malformed.profiles[0].settings.automation.items[0].conditions[0].value=101;
    const before=f.data.get(PROFILE_STORAGE_KEY);expect(()=>f.store.import(JSON.stringify(malformed))).toThrow();expect(f.data.get(PROFILE_STORAGE_KEY)).toBe(before);
    expect(DEFAULT_AUTOMATION.items).toEqual([]);
  });
  it('persists resource conditions in current forms without relaxing strict schema or restoring run intent', async () => {
    const automation=structuredClone(DEFAULT_AUTOMATION);
    automation.items=[{itemId:501,resource:'hp',belowPercent:80,minStock:0,cooldownSeconds:1,conditions:[
      {field:'actorHpPercent',actor:{scope:'self'},operator:'lte',value:60},
      {field:'actorSpPercent',actor:{scope:'self'},operator:'gte',value:25.5},
    ]}];
    const configured={...settings(),automation},writes:unknown[]=[];
    const form=new CurrentForm(()=>({settings:configured,selectedProfileId:'resources'}),async document=>{writes.push(structuredClone(document));return document.revision;});
    form.restore(null,()=>{throw new Error('No prior form should be applied.');});
    const saved=await form.flush(),restored=formDocument(JSON.parse(JSON.stringify(saved)));
    expect(restored.settings.automation!.items).toEqual(automation.items);
    expect(restored.settings.targets).toEqual(configured.targets);
    expect(Object.keys(restored).sort()).toEqual(['revision','selectedProfileId','settings','version']);
    for(const change of [{value:101},{operator:'ne'},{actor:{scope:'candidate'}},{observedHp:40}]) {
      const malformed=structuredClone(saved);Object.assign(malformed.settings.automation!.items[0]!.conditions![0]!,change);
      expect(()=>formDocument(malformed)).toThrow();
    }
    automation.items[0]!.conditions![0]!.value=NaN;
    await expect(form.flush()).rejects.toThrow();expect(writes).toHaveLength(1);
  });
  it('round-trips protected disposition and rejects invalid imports atomically', () => {
    const f=fixture();const automation=structuredClone(DEFAULT_AUTOMATION);automation.disposition={maxSpend:0,rules:[{itemId:501,keep:1,minimum:2,desired:3,maximum:4,store:true,sell:false,cart:false,restock:'storage',allowUnique:false}]};
    automation.escape={...DEFAULT_ESCAPE,enabled:true,mode:'save',minStock:2};
    automation.loadout.enabled=true;automation.loadout.minAmmoStock=5;
    const saved=f.store.save('Protected stock','Raon',{...settings(),automation});const exported=f.store.export(saved.id);
    expect(f.store.import(exported)[0]?.settings.automation?.disposition).toEqual(automation.disposition);
    expect(f.store.import(exported)[0]?.settings.automation?.escape).toEqual(automation.escape);
    expect(f.store.import(exported)[0]?.settings.automation?.loadout).toEqual(automation.loadout);
    const legacy=JSON.parse(exported);delete legacy.profiles[0].settings.automation.escape;delete legacy.profiles[0].settings.automation.loadout;
    expect(f.store.import(JSON.stringify(legacy))[0]?.settings.automation).toMatchObject({escape:DEFAULT_ESCAPE,loadout:DEFAULT_AUTOMATION.loadout,disposition:automation.disposition});
    const document=JSON.parse(exported);document.profiles[0].settings.automation.disposition.rules[0].maximum=2;
    const before=f.data.get(PROFILE_STORAGE_KEY);expect(()=>f.store.import(JSON.stringify(document))).toThrow();expect(f.data.get(PROFILE_STORAGE_KEY)).toBe(before);
    document.profiles[0].settings.automation.disposition.rules[0].maximum=4;document.profiles[0].settings.automation.disposition.rules[0].unknown=true;
    expect(()=>f.store.import(JSON.stringify(document))).toThrow();expect(f.data.get(PROFILE_STORAGE_KEY)).toBe(before);
  });
  it('round-trips detached settings without account or run state', () => {
    const f = fixture(); const input = settings();
    const saved = f.store.save(' Field eight ', 'Raon', input);
    input.targets.push(1003);
    expect(saved.name).toBe('Field eight');
    expect(f.store.forMap(saved.id, 'prt_fild08').settings.targets).toEqual([1002]);
    const restored = new ProfileStore(f.storage).list();
    expect(restored).toEqual([saved]);
    expect(Object.keys(JSON.parse(f.store.export(saved.id)).profiles[0])).toEqual(['id', 'name', 'character', 'savedAt', 'settings']);
    expect(() => f.store.forMap(saved.id, 'pay_fild02')).toThrow('Enter prt_fild08');
    expect(() => f.store.forMap(saved.id, 'prt_fild08', 'Another character')).toThrow('Select Raon');
  });
  it('validates every imported profile before writing anything', () => {
    const f = fixture(); const first = f.store.save('One', '', settings());
    const document = JSON.parse(f.store.export(first.id));
    document.profiles.push({ ...document.profiles[0], id: 'bad', settings: { ...settings(), radius: 999 } });
    const before = f.data.get(PROFILE_STORAGE_KEY);
    expect(() => f.store.import(JSON.stringify(document))).toThrow();
    expect(f.data.get(PROFILE_STORAGE_KEY)).toBe(before);
    expect(f.store.list()).toHaveLength(1);
  });
  it('imports using fresh IDs and rejects unknown sensitive fields', () => {
    const f = fixture(); const first = f.store.save('One', '', settings());
    const imported = f.store.import(f.store.export(first.id));
    expect(imported[0]?.id).not.toBe(first.id);
    const document = JSON.parse(f.store.export(first.id));
    document.profiles[0].settings.password = 'excluded';
    expect(() => f.store.import(JSON.stringify(document))).toThrow('unknown or missing settings');
    document.profiles[0].settings = settings(); document.profiles[0].credentials = {};
    expect(() => f.store.import(JSON.stringify(document))).toThrow('metadata');
  });
  it('bounds profiles, document size and version', () => {
    const f = fixture();
    for (let n = 0; n < MAX_PROFILES; n++) f.store.save(`Profile ${n}`, '', settings());
    expect(() => f.store.save('Overflow', '', settings())).toThrow('at most');
    expect(() => f.store.import(' '.repeat(256_001))).toThrow('too large');
    expect(() => f.store.import('{"version":2,"profiles":[]}')).toThrow('Unsupported');
  });
  it('preserves in-memory profiles when persistence fails', () => {
    const store = new ProfileStore({ getItem: () => null, setItem: () => { throw new Error('storage full'); } }, () => 'one');
    expect(() => store.save('One', '', settings())).toThrow('storage full');
    expect(store.list()).toEqual([]);
  });
  it('ignores invalid saved documents and supports update/delete', () => {
    const f = fixture(); f.data.set(PROFILE_STORAGE_KEY, '{"version":1,"profiles":[{}]}');
    expect(new ProfileStore(f.storage).list()).toEqual([]);
    const first = f.store.save('One', '', settings());
    f.store.save('Renamed', 'Raon', settings(), first.id);
    expect(f.store.list().map(profile => profile.name)).toEqual(['Renamed']);
    f.store.remove(first.id); expect(f.store.list()).toEqual([]);
  });
  it('round-trips automation and rejects nested fields before persistence', () => {
    const f=fixture();const profile=f.store.save('Recovery','Raon',{...settings(),automation:structuredClone(DEFAULT_AUTOMATION)});
    expect(f.store.forMap(profile.id,'prt_fild08').settings.automation).toEqual(DEFAULT_AUTOMATION);
    const document=JSON.parse(f.store.export(profile.id));document.profiles[0].settings.automation.follow.password='excluded';
    const before=f.data.get(PROFILE_STORAGE_KEY);expect(()=>f.store.import(JSON.stringify(document))).toThrow('unknown automation');expect(f.data.get(PROFILE_STORAGE_KEY)).toBe(before);
  });
  it('imports older automation profiles with escape disabled and round-trips explicit escape controls',()=>{
    const f=fixture();const profile=f.store.save('Escape','Test',{...settings(),automation:structuredClone(DEFAULT_AUTOMATION)});
    const document=JSON.parse(f.store.export(profile.id));delete document.profiles[0].settings.automation.escape;
    expect(f.store.import(JSON.stringify(document))[0]!.settings.automation!.escape).toEqual(DEFAULT_ESCAPE);
    document.profiles[0].settings.automation.escape={...DEFAULT_ESCAPE,enabled:true,mode:'save',method:'skill',minStock:2,cooldownSeconds:120};
    const imported=f.store.import(JSON.stringify(document))[0]!;
    expect(f.store.forMap(imported.id,'prt_fild08').settings.automation!.escape).toEqual(document.profiles[0].settings.automation.escape);
    expect(f.store.export(imported.id)).not.toContain('latched');expect(f.store.export(imported.id)).not.toContain('escapeGuard');
  });
});
describe('loadout profile compatibility',()=>{
 it('migrates stored v1 profiles and imported legacy automation to disabled loadout',()=>{
  const f=fixture(),saved=f.store.save('Legacy','',{...settings(),automation:structuredClone(DEFAULT_AUTOMATION)}),doc=JSON.parse(f.store.export(saved.id));delete doc.profiles[0].settings.automation.loadout;
  f.data.set(PROFILE_STORAGE_KEY,JSON.stringify(doc));expect(new ProfileStore(f.storage).list()[0]!.settings.automation!.loadout.enabled).toBe(false);
  expect(f.store.import(JSON.stringify(doc))[0]!.settings.automation!.loadout.enabled).toBe(false);
 });
 it('preserves ordered ammo preferences and rejects captured prior identities',()=>{
  const f=fixture(),automation=structuredClone(DEFAULT_AUTOMATION);automation.loadout.enabled=true;automation.loadout.ammoPreferences=[{itemId:1751},{itemId:1750}];
  const saved=f.store.save('Arrows','',{...settings(),automation});expect(f.store.forMap(saved.id,'prt_fild08').settings.automation!.loadout).toEqual(automation.loadout);
  const doc=JSON.parse(f.store.export(saved.id));doc.profiles[0].settings.automation.loadout.prior={guid:'excluded'};expect(()=>f.store.import(JSON.stringify(doc))).toThrow('unknown automation');
 });
});


it('preserves legacy explicit escape profiles while strictly validating new threat settings and rejecting ephemeral state', () => {
  const f = fixture(), automation = structuredClone(DEFAULT_AUTOMATION);
  automation.escape = { enabled: true, hpBelowPercent: 20, mode: 'random', method: 'item', minStock: 0, cooldownSeconds: 60 };
  const saved = f.store.save('Legacy escape', 'Test', { ...settings(), automation });
  expect(f.store.import(f.store.export(saved.id))[0]!.settings.automation!.escape).toEqual(automation.escape);
  const doc = JSON.parse(f.store.export(saved.id));
  Object.assign(doc.profiles[0].settings.automation.escape, { hpEnabled: false, threatEnabled: true, threatCount: 64, threatWindowSeconds: 60 });
  const imported = f.store.import(JSON.stringify(doc))[0]!;
  expect(imported.settings.automation!.escape).toMatchObject({ hpEnabled: false, threatEnabled: true, threatCount: 64, threatWindowSeconds: 60 });
  for (const patch of [{ threatCount: 0 }, { threatWindowSeconds: 61 }, { threatEnabled: null }, { recovery: { hpPercent: 100, threatCount: 1, quietSeconds: 60 } }, { actorId: 0 }, { pending: true }]) {
    const invalid = structuredClone(doc); Object.assign(invalid.profiles[0].settings.automation.escape, patch);
    expect(() => f.store.import(JSON.stringify(invalid))).toThrow();
  }
});
