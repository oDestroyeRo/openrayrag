import { appendAll, filter, map, dedupe } from 'effect/Array';
import { pipe, flow } from 'effect/Function';
import { validateServiceDefinition, type NpcServiceDefinition, type ServiceOutcome } from './npc-services-logic';
import { DomainValueError, mapCode, milliseconds, itemId, quantity, type MapCode, type Milliseconds, type ItemId, type Quantity } from '../../shared/domain-values';
import type { ReadonlyData } from '../settings/settings';
declare const serviceValue: unique symbol;
export type SavedServiceId = string & { readonly [serviceValue]: 'SavedServiceId' };
export type ServiceContractId = string & { readonly [serviceValue]: 'ServiceContractId' };
function serviceText(value: unknown, maximum: number, domain: 'SavedServiceId' | 'ServiceContractId'): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) throw new DomainValueError(domain, typeof value === 'string' ? 'range' : 'type', 'service text.');
  return value;
}
export function savedServiceId(value: unknown): SavedServiceId {
  const id = serviceText(value, 64, 'SavedServiceId');
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new DomainValueError('SavedServiceId', 'range', 'service identifier.');
  return id as SavedServiceId;
}
export function serviceContractId(value: unknown): ServiceContractId { return serviceText(value, 128, 'ServiceContractId') as ServiceContractId; }
export type ServiceDefinitionInput = ReadonlyData<Omit<NpcServiceDefinition, 'workflow'> & {
  workflow: Omit<NpcServiceDefinition['workflow'], 'timeoutMs'> & { timeoutMs: number | undefined };
}>;
type SavedServiceOutcome<Value extends ServiceOutcome = ServiceOutcome> = Value extends ServiceOutcome ? ReadonlyData<Omit<Value, 'timeoutMs'> & { timeoutMs: Milliseconds }> : never;
export type SavedServiceDefinition = ReadonlyData<Omit<NpcServiceDefinition, 'id' | 'contractId' | 'map' | 'basicSkillLevel' | 'workflow' | 'outcome'> & {
  id: SavedServiceId; contractId: ServiceContractId; map: MapCode; basicSkillLevel: Quantity;
  workflow: Omit<NpcServiceDefinition['workflow'], 'maxSpend' | 'timeoutMs' | 'minStock'> & { maxSpend: Quantity; timeoutMs: Milliseconds | undefined; minStock: { itemId: ItemId; count: Quantity }[] };
  outcome: SavedServiceOutcome;
}>;
/** The general service schema owns validation order; registry domains arise only after it succeeds. */
export function checkedSavedService(input: unknown): SavedServiceDefinition {
  const service = validateServiceDefinition(input);
  return { ...service, id: savedServiceId(service.id), contractId: serviceContractId(service.contractId),
    map: mapCode(service.map), basicSkillLevel: quantity(service.basicSkillLevel),
    workflow: { ...service.workflow, maxSpend: quantity(service.workflow.maxSpend), timeoutMs: service.workflow.timeoutMs === undefined ? undefined : milliseconds(service.workflow.timeoutMs),
      minStock: map(service.workflow.minStock, stock => ({ itemId: itemId(stock.itemId), count: quantity(stock.count) })) },
    outcome: { ...service.outcome, timeoutMs: milliseconds(service.outcome.timeoutMs) } };
}
export const MAX_SERVICES = 20;
const serviceIds = flow(map<readonly ServiceDefinitionInput[], string>(service => service.id), dedupe);
export function parseServiceDocument(text: string): readonly SavedServiceDefinition[] {
  if (new TextEncoder().encode(text).length > 256_000) throw new Error('Service document is too large.');
  const v: unknown = JSON.parse(text);
  if (
    !v ||
    typeof v !== 'object' ||
    Array.isArray(v) ||
    Object.keys(v).length !== 2 ||
    !Object.hasOwn(v, 'version') ||
    !Object.hasOwn(v, 'services')
  )
    throw new Error('Invalid service document fields.');
  const d = v as { version: unknown; services: unknown };
  if (d.version !== 1 || !Array.isArray(d.services) || d.services.length > MAX_SERVICES)
    throw new Error('Unsupported service document.');
  const services = map(d.services, checkedSavedService);
  if (serviceIds(services).length !== services.length) throw new Error('Service IDs must be unique.');
  return services;
}
export function encodeServiceDocument(services: readonly ServiceDefinitionInput[]): string {
  const text = JSON.stringify({ version: 1, services });
  parseServiceDocument(text);
  return text;
}
export function serviceSaveAllowed(services: readonly ServiceDefinitionInput[], existingId?: string): void {
  if (existingId && !services.some(service => service.id === existingId)) throw new Error('Choose an existing service to update.');
  if (!existingId && services.length >= MAX_SERVICES) throw new Error(`Keep at most ${MAX_SERVICES} services.`);
}
export function savedServices(services: readonly ServiceDefinitionInput[], input: unknown, id: string, existingId?: string): { readonly services: readonly SavedServiceDefinition[]; readonly saved: SavedServiceDefinition } {
  const saved = checkedSavedService({ ...validateServiceDefinition(input), id });
  if (!existingId && services.some(service => service.id === saved.id)) throw new Error('Could not create a unique service ID.');
  return { services: pipe(services, filter(service => service.id !== saved.id), appendAll([saved]), map(checkedSavedService)), saved };
}
export function serviceImportAllowed(services: readonly ServiceDefinitionInput[], imported: readonly ServiceDefinitionInput[]): void {
  if (!imported.length) throw new Error('Service document is empty.');
  if (services.length + imported.length > MAX_SERVICES) throw new Error(`Keep at most ${MAX_SERVICES} services.`);
}
export function importedServices(services: readonly ServiceDefinitionInput[], imported: readonly ServiceDefinitionInput[], ids: readonly string[]): readonly SavedServiceDefinition[] {
  if (ids.length !== imported.length) throw new Error('Could not create unique service IDs.');
  const copies = map(imported, (service, index) => checkedSavedService({ ...service, id: ids[index] }));
  if (serviceIds([...services, ...copies]).length !== services.length + copies.length) throw new Error('Could not create unique service IDs.');
  return copies;
}
export function exportService(services: readonly ServiceDefinitionInput[], id: string): string {
  const service = services.find(saved => saved.id === id);
  if (!service) throw new Error('Choose a service to export.');
  return JSON.stringify({ version: 1, services: [service] }, null, 2);
}
