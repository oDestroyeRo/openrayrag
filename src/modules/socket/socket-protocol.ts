import { bagId, itemId, quantity, type BagId, type ItemId, type Quantity } from '../../shared/domain-values';
import { BitWriter } from '../../shared/binary';
import { validateAutomation, type AutomationSettingsInput as AutomationSettings, type ValidatedAutomationSettings } from '../settings/settings';
import { dispositionStockFloors } from '../services/disposition-ui';

export interface SocketSelectionInput { targetBagId:number;cardBagId:number }
export interface SocketSelection { readonly targetBagId:BagId;readonly cardBagId:BagId }
export interface SocketRequest extends SocketSelection { previewToken: string }
export interface SocketPreviewRequest extends SocketSelectionInput { policy:AutomationSettings }
export interface SocketCommitRequest extends SocketSelectionInput { previewToken:string;policy:AutomationSettings }
export type ValidatedSocketPreviewRequest = SocketSelection & {readonly policy:ValidatedAutomationSettings};
export type ValidatedSocketCommitRequest = SocketRequest & {readonly policy:ValidatedAutomationSettings};
export interface SocketAction extends SocketSelectionInput { type: 'socket' }
function selection(value: unknown, commit: boolean): SocketSelection & { previewToken?: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid socket request.');
  const v = value as Record<string, unknown>, keys = commit ? ['targetBagId','cardBagId','previewToken'] : ['targetBagId','cardBagId'];
  if (Object.keys(v).length !== keys.length || Object.keys(v).some(key => !keys.includes(key))) throw new Error('Unknown socket request fields.');
  for (const key of ['targetBagId','cardBagId']) if (!Number.isSafeInteger(v[key]) || Number(v[key]) <= 0 || Number(v[key]) > 2147483647) throw new Error('Socket bag IDs must be positive int32 values.');
  if (v.targetBagId === v.cardBagId) throw new Error('Choose separate target and card bags.');
  if (commit && (typeof v.previewToken !== 'string' || !/^[a-f0-9]{32}$/.test(v.previewToken))) throw new Error('Request a current socket preview first.');
  return {targetBagId:bagId(v.targetBagId),cardBagId:bagId(v.cardBagId),...(commit?{previewToken:v.previewToken as string}:{})};
}
export const validateSocketSelection = (value: unknown): SocketSelection => selection(value,false);
export const validateSocketRequest = (value: unknown): SocketRequest => selection(value,true) as SocketRequest;
export function validateSocketEnvelope(value:unknown,commit:false):ValidatedSocketPreviewRequest;
export function validateSocketEnvelope(value:unknown,commit:true):ValidatedSocketCommitRequest;
export function validateSocketEnvelope(value:unknown,commit:boolean):ValidatedSocketPreviewRequest|ValidatedSocketCommitRequest {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid socket request.');
  if(new TextEncoder().encode(JSON.stringify(value)).length>65_536)throw new Error('Socket request exceeds its 65,536-byte limit.');
  const {policy,...request}=value as Record<string,unknown>;
  if(!policy||typeof policy!=='object'||Array.isArray(policy))throw new Error('Current protection settings are required.');
  const selected=selection(request,commit),checked=validateAutomation(policy as AutomationSettings);
  const name=checked.follow.name;
  if(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(new TextEncoder().encode(name))!==name)throw new Error('Policy contains an incomplete Unicode character.');
  return {...selected,policy:structuredClone(checked)} as ValidatedSocketPreviewRequest|ValidatedSocketCommitRequest;
}
export function socketStockFloors(policy:AutomationSettings):ReadonlyMap<ItemId,Quantity>{
  const floors=new Map<ItemId,Quantity>();
  for(const row of [...dispositionStockFloors(policy),...(policy.disposition?.rules??[]).map(rule=>({itemId:rule.itemId,count:rule.keep}))]){const id=itemId(row.itemId);floors.set(id,quantity(Math.max(floors.get(id)??0,row.count)));}
  return floors;
}
/** Manual transport only; never accepted by generic action/routine validators. */
export function socketCommand(action: SocketAction): Uint8Array<ArrayBuffer> {
  const {type,...input}=action;
  if(type!=='socket')throw new Error('Invalid socket action.');
  const s=validateSocketSelection(input);
  return new BitWriter().u8(63).i32(s.targetBagId).i32(s.cardBagId).finish();
}
