import { validateFormSettings, type Settings } from './settings';
export interface FormDocument {version:1;revision:number;selectedProfileId:string|null;settings:Settings}
export function formDocument(value:unknown):FormDocument {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid current settings document.');
  const v=value as Record<string,unknown>;
  if(Object.keys(v).length!==4||!['version','revision','selectedProfileId','settings'].every(k=>Object.hasOwn(v,k))||v.version!==1||!Number.isSafeInteger(v.revision)||Number(v.revision)<0
    ||v.selectedProfileId!==null&&(typeof v.selectedProfileId!=='string'||! /^[a-zA-Z0-9_-]{1,64}$/.test(v.selectedProfileId)))throw new Error('Invalid current settings document.');
  return {version:1,revision:Number(v.revision),selectedProfileId:v.selectedProfileId as string|null,settings:validateFormSettings(v.settings as Settings)};
}
/** Decide revisions from document content without reading or persisting a form. */
export function nextFormSave(document: FormDocument, revision: number, last: string | null): { document: FormDocument; revision: number; content: string } {
  const content = JSON.stringify({ ...document, revision: 0 });
  const nextRevision = content !== last ? revision + 1 : revision;
  return { document: structuredClone({ ...document, revision: nextRevision }), revision: nextRevision, content };
}
