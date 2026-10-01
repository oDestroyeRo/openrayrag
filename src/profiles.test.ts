import { describe, expect, it } from 'vitest';
import { DEFAULT_AUTOMATION, DEFAULT_SETTINGS } from './settings';
import { MAX_PROFILES, PROFILE_STORAGE_KEY, ProfileStore } from './profiles';

const settings = () => ({ ...DEFAULT_SETTINGS, map: 'prt_fild08', targets: [1002] });
function fixture() {
  const data = new Map<string, string>(); let id = 0;
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
  return { data, storage, store: new ProfileStore(storage, () => `profile-${++id}`, () => 100) };
}
describe('named profiles', () => {
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
});
