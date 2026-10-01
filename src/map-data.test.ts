import { describe, expect, it, vi } from 'vitest';
import { currentMapInfo, loadMapCatalog, parseMapCatalog, validMapInfo, MAP_DATA_URL } from './map-data';
import { type Entity } from './protocol';

// Public prt_fild05 rows from the deployed map/monster JSON, 2026-10-01.
const rows = [
  [4000,'Poring',1,51,70], [4002,'Lunatic',3,79,30], [4008,'Thief Bug Egg',4,143,20],
  [4003,'Pupa',6,214,30], [4007,'Thief Bug',8,152,10], [4010,'Green Plant',1,10,6], [4013,'Blue Plant',1,10,1],
] as const;
const maps = { Items: [{ Code: 'prt_fild05', Name: 'Prontera Field 5' }, { Code: 'prontera', Name: 'Prontera' }] };
const monsters = { Items: rows.map(([Id,Name,Level,HP,Count]) => ({ Id,Name,Level,HP,Spawns:[{Map:'prt_fild05',Count:Number(Count)}] })) };
const entity: Entity = { id: 1, classId: 4000, name: 'Poring', kind: 1, level: 1, hp: 51, maxHp: 51, dead: false, x: 1, y: 1 };

describe('official map information', () => {
  it('reads the seven deployed field types and combines repeated spawn rules', () => {
    const data = structuredClone(monsters);
    data.Items[0]!.Spawns.push({Map:'prt_fild05',Count:5});
    const catalog = parseMapCatalog(maps,data);
    expect(catalog.get('prt_fild05')?.name).toBe('Prontera Field 5');
    expect(catalog.get('prt_fild05')?.monsters).toHaveLength(7);
    expect(catalog.get('prt_fild05')?.monsters.find(m=>m.classId===4000)?.spawnCount).toBe(75);
    expect(catalog.get('prontera')?.monsters).toEqual([]);
  });
  it('keeps configured population distinct from live visible entities, including beyond radar capacity', () => {
    const catalog=parseMapCatalog(maps,monsters);
    const live=Array.from({length:160},(_,id)=>({...entity,id:id+1}));
    live.push({...entity,id:999,classId:4999,name:'Event monster',level:8});
    live.push({...entity,id:1000,kind:0}, {...entity,id:1001,dead:true});
    const info=currentMapInfo('prt_fild05',live,catalog,false);
    expect(info.monsters.find(m=>m.classId===4000)).toMatchObject({spawnCount:70,visibleCount:160});
    expect(info.monsters.find(m=>m.classId===4999)).toMatchObject({spawnCount:null,visibleCount:1});
    expect(info.monsters.find(m=>m.classId===4002)).toMatchObject({spawnCount:30,visibleCount:0});
    expect(catalog.get('prt_fild05')?.monsters[0]?.visibleCount).toBe(0);
    expect(validMapInfo(info,'prt_fild05')).toBe(true);
    expect(validMapInfo(info,'prontera')).toBe(false);
  });
  it('falls back to observed types on an unknown map or when metadata is unavailable', () => {
    const info=currentMapInfo('event_map',[entity],null,false);
    expect(info).toMatchObject({name:'event_map',source:'observed'});
    expect(info.monsters[0]).toMatchObject({classId:4000,spawnCount:null,visibleCount:1});
    expect(currentMapInfo('event_map',[entity],null,true).source).toBe('loading');
  });
  it('rejects malformed exports and invalid IPC map information', () => {
    expect(()=>parseMapCatalog({},monsters)).toThrow();
    expect(()=>parseMapCatalog(maps,{Items:[{...monsters.Items[0],Id:-1}]})).toThrow();
    expect(()=>parseMapCatalog(maps,{Items:[{...monsters.Items[0],Spawns:[{Map:'../map',Count:1}]}]})).toThrow();
    const info=currentMapInfo('prt_fild05',[entity],null,false);
    expect(validMapInfo({...info,monsters:[...info.monsters,...info.monsters]},info.code)).toBe(false);
  });
  it('loads only the two public assets without credentials and rejects failed fetches', async () => {
    const fetcher=vi.fn<typeof fetch>(async url => new Response(JSON.stringify(String(url).endsWith('/maps.json') ? maps : monsters)));
    const catalog=await loadMapCatalog(fetcher);
    expect(catalog.get('prt_fild05')?.monsters).toHaveLength(7);
    expect(fetcher.mock.calls.map(call=>call[0])).toEqual([`${MAP_DATA_URL}maps.json`,`${MAP_DATA_URL}monsterdatabase.json`]);
    expect(fetcher.mock.calls.every(call=>call[1]?.credentials==='omit')).toBe(true);
    await expect(loadMapCatalog(async()=>new Response('',{status:404}))).rejects.toThrow('unavailable');
  });
});
