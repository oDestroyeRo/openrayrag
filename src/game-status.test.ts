import { describe, expect, it } from 'vitest';
import { CompanionController } from './controller';
import { DEFAULT_MAP_POLICY } from './map-policy';
import { statusHeartbeatFresh, validStatus } from './game-status';
import type { Entity } from './protocol';
const player:Entity={id:1,kind:0,classId:0,name:'Fixture',level:1,hp:100,maxHp:100,x:169,y:193,dead:false,statuses:[]};
describe('native full status and heartbeat boundary during route planning',()=>{
  it('accepts real planning telemetry through the full predicate and keeps heartbeat fresh past seven seconds',()=>{
    const c=new CompanionController(()=>{},()=>100_000);c.connect(true);c.engine.receive([{type:'enter',id:1,map:'prt_fild08'},{type:'spawn',entity:player}]);c.world.reset('prt_fild08');
    c.travel.start('prt_fild08',player,'payon',10,true,{...DEFAULT_MAP_POLICY,mode:'weighted'});
    let receivedAt=100_000;
    try {
      for(let seconds=0;seconds<=8;seconds++) {
        const status={...c.snapshot(),sessionId:'offline-fixture',login:{phase:'complete',message:''},reconnectAvailable:false,mapInfo:{code:'prt_fild08',name:'Field',source:'observed',monsters:[]}};
        expect(status.travel.state).toBe('planning');expect(status.state).toBe('running');expect(validStatus(status)).toBe(true);
        expect(status.memo).toBeDefined();expect(status.socket).toBeDefined();
        expect(validStatus({...status,memo:{...status.memo,blocked:'invalid'}})).toBe(false);
        expect(validStatus({...status,socket:{...status.socket,pending:'invalid'}})).toBe(false);
        receivedAt=100_000+seconds*1000;expect(statusHeartbeatFresh(receivedAt,receivedAt+1000)).toBe(true);
      }
      expect(statusHeartbeatFresh(receivedAt,receivedAt+7001)).toBe(false);
    } finally { c.stop(); }
  });
});
