import { map } from 'effect/Array';
import { SOCKET_METADATA } from './socket-logic';
import type { SocketSnapshot } from './socket';
export function socketSlotsText(slots:readonly number[]):string {
  return map(slots,id=>id?SOCKET_METADATA[id]?.name??`Item #${id}`:'empty').join(', ');
}
/** Bound purpose-specific telemetry; raw GUIDs and arbitrary inventory fields are absent. */
export function validSocketSnapshot(value:unknown):value is SocketSnapshot{
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const v=value as Record<string,unknown>;
  if(Object.keys(v).some(k=>!['state','pending','reason','targets','cards','preview'].includes(k))
    ||!['idle','preview','pending','confirmed','uncertain','reconciled'].includes(String(v.state))||typeof v.pending!=='boolean'
    ||typeof v.reason!=='string'||v.reason.length>1024||!Array.isArray(v.targets)||v.targets.length>200||!Array.isArray(v.cards)||v.cards.length>200)return false;
  const id=(x:unknown)=>Number.isSafeInteger(x)&&Number(x)>0&&Number(x)<=2147483647;
  const record=(x:unknown):Record<string,unknown>|null=>x&&typeof x==='object'&&!Array.isArray(x)?x as Record<string,unknown>:null;
  const target=(x:unknown)=>{const t=record(x);return !!t&&Object.keys(t).length===6&&Object.keys(t).every(k=>['bagId','itemId','name','refine','slots','capacity'].includes(k))&&id(t.bagId)&&id(t.itemId)
    &&typeof t.name==='string'&&t.name.length<=256&&Number.isInteger(t.refine)&&Number(t.refine)>=0&&Number(t.refine)<=255&&Number.isInteger(t.capacity)&&Number(t.capacity)>=1&&Number(t.capacity)<=4
    &&Array.isArray(t.slots)&&t.slots.length===4&&t.slots.every(x=>x===0||id(x));};
  const card=(x:unknown)=>{const t=record(x);return !!t&&Object.keys(t).length===5&&Object.keys(t).every(k=>['bagId','itemId','name','count','reserve'].includes(k))&&id(t.bagId)&&id(t.itemId)
    &&typeof t.name==='string'&&t.name.length<=256&&Number.isInteger(t.count)&&Number(t.count)>=1&&Number(t.count)<=32767&&Number.isInteger(t.reserve)&&Number(t.reserve)>=0&&Number(t.reserve)<=32767;};
  if(!v.targets.every(target)||!v.cards.every(card))return false;
  if(v.preview===null)return true;
  const p=record(v.preview);
  return !!p&&Object.keys(p).length===7&&Object.keys(p).every(k=>['targetBagId','cardBagId','previewToken','target','card','slot','cost'].includes(k))&&id(p.targetBagId)&&id(p.cardBagId)
    &&typeof p.previewToken==='string'&&/^[a-f0-9]{32}$/.test(p.previewToken)&&target(p.target)&&card(p.card)&&Number.isInteger(p.slot)&&Number(p.slot)>=0&&Number(p.slot)<Number(record(p.target)?.capacity)&&p.cost===1
    &&p.targetBagId===record(p.target)?.bagId&&p.cardBagId===record(p.card)?.bagId;
}
