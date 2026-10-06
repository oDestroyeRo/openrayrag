import { bagId, quantity, type BagId, type Quantity } from './domain-values';
import { BitWriter } from './binary';
import { validateAutomation, type AutomationSettingsInput as AutomationSettings, type ValidatedAutomationSettings } from './settings';

export interface RefineGuards { policy: AutomationSettings; maxSpend: number; minZeny: number }
export interface RefinePreviewRequest extends RefineGuards { targetBagId: number; catalystBagId: 0 }
export interface RefineRequest extends RefinePreviewRequest { previewToken: string }
export interface ValidatedRefinePreviewRequest { readonly targetBagId:BagId;readonly catalystBagId:0;readonly policy:ValidatedAutomationSettings;readonly maxSpend:Quantity;readonly minZeny:Quantity }
export interface ValidatedRefineRequest extends ValidatedRefinePreviewRequest { readonly previewToken:string }
export interface RefinePacket { targetBagId: number; oreItemId: number; catalystBagId: 0 }
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error('Invalid refine request.');
  return value as Record<string, unknown>;
}
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new Error('Invalid refine number.');
  return value;
}
export function validateRefineRequest(value: unknown, preview: true): ValidatedRefinePreviewRequest;
export function validateRefineRequest(value: unknown, preview?: false): ValidatedRefineRequest;
export function validateRefineRequest(value: unknown, preview = false): ValidatedRefinePreviewRequest | ValidatedRefineRequest {
  const encoded=JSON.stringify(value);
  if(typeof encoded!=='string'||new TextEncoder().encode(encoded).length>65536)throw new Error('Refine request exceeds its limit.');
  const v = record(value, ['targetBagId','catalystBagId','policy','maxSpend','minZeny',...preview ? [] : ['previewToken']]);
  if (v.catalystBagId !== 0) throw new Error('Catalysts are not supported.');
  const result: ValidatedRefinePreviewRequest = { targetBagId: bagId(integer(v.targetBagId,1,2147483647)), catalystBagId:0,
    policy: structuredClone(validateAutomation(v.policy as AutomationSettings)), maxSpend:quantity(integer(v.maxSpend,0,2000000000)), minZeny:quantity(integer(v.minZeny,0,2147483647)) };
  const name=result.policy.follow.name;
  for(let i=0;i<name.length;i++){const code=name.charCodeAt(i);if(code>=0xd800&&code<=0xdbff){const next=name.charCodeAt(++i);if(!(next>=0xdc00&&next<=0xdfff))throw new Error('Invalid protection policy text.');}else if(code>=0xdc00&&code<=0xdfff)throw new Error('Invalid protection policy text.');}
  if (preview) return result;
  if (typeof v.previewToken !== 'string' || !/^[a-f0-9]{32}$/.test(v.previewToken)) throw new Error('Invalid refine preview token.');
  return { ...result, previewToken:v.previewToken };
}
/** Dedicated manual transport. This packet is deliberately absent from routine actions. */
export function refineCommand(value: RefinePacket): Uint8Array {
  const v = record(value,['targetBagId','oreItemId','catalystBagId']);
  if (v.catalystBagId !== 0) throw new Error('Catalysts are not supported.');
  return new BitWriter().u8(80).i32(integer(v.targetBagId,1,2147483647)).i32(integer(v.oreItemId,1,2147483647)).i32(0).finish();
}

export function validateRefineAdvance(value: unknown): string {
  const v=record(value,['promptToken']);
  if(typeof v.promptToken!=='string'||!/^[a-f0-9]{32}$/.test(v.promptToken))throw new Error('Invalid refining dialogue token.');
  return v.promptToken;
}
