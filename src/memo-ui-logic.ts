import type { MemoSnapshot } from './memo';
import { validateMemoRequest, type MemoLocation } from './memo-protocol';
const object=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const integer=(v:unknown,min=0,max=2147483647):boolean=>Number.isInteger(v)&&Number(v)>=min&&Number(v)<=max;
const exact=(v:Record<string,unknown>,keys:string[]):boolean=>Object.keys(v).length===keys.length&&Object.keys(v).every(key=>keys.includes(key));
const location=(v:unknown):v is MemoLocation=>{const p=object(v);return exact(p,['map','x','y'])&&typeof p.map==='string'&&/^[a-zA-Z0-9_-]{1,64}$/.test(p.map)&&integer(p.x,0,32767)&&integer(p.y,0,32767);};
export function validMemoSnapshot(input:unknown):input is MemoSnapshot {
  const v=object(input);
  if(!exact(v,['generation','revision','slots','pending','blocked','state','reason','ready','learnedWarp','unavailable'])||!integer(v.generation)||!integer(v.revision)
    ||typeof v.pending!=='boolean'||typeof v.blocked!=='boolean'||(v.pending&&!v.blocked)
    ||!['unknown','observed','alreadyCurrent','sent','notified','confirmed','uncertain'].includes(String(v.state))||typeof v.reason!=='string'||v.reason.length>512
    ||!(v.learnedWarp===null||integer(v.learnedWarp,0,255))||!(v.unavailable===null||typeof v.unavailable==='string'&&v.unavailable.length<=512)
    ||!(v.slots===null||Array.isArray(v.slots)&&v.slots.length===4&&v.slots.every(slot=>slot===null||location(slot))))return false;
  if(v.ready===null)return true;
  try {const r=validateMemoRequest({type:'memoSave',slot:0,preview:v.ready});return r.preview.revision===v.revision&&v.slots!==null&&!v.blocked&&v.unavailable===null;}catch{return false;}
}
