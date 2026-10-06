import { validateServiceDefinition, type NpcServiceDefinition } from './npc-services';
export const MAX_SERVICES = 20;
export function parseServiceDocument(text: string): NpcServiceDefinition[] {
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
  const services = d.services.map(validateServiceDefinition);
  if (new Set(services.map((s) => s.id)).size !== services.length) throw new Error('Service IDs must be unique.');
  return services;
}
export function encodeServiceDocument(services: readonly NpcServiceDefinition[]): string {
  const text = JSON.stringify({ version: 1, services });
  parseServiceDocument(text);
  return text;
}
export function serviceSaveAllowed(services: readonly NpcServiceDefinition[], existingId?: string): void {
  if (existingId && !services.some(service => service.id === existingId)) throw new Error('Choose an existing service to update.');
  if (!existingId && services.length >= MAX_SERVICES) throw new Error(`Keep at most ${MAX_SERVICES} services.`);
}
export function savedServices(services: readonly NpcServiceDefinition[], input: unknown, id: string, existingId?: string): { services: NpcServiceDefinition[]; saved: NpcServiceDefinition } {
  const saved = validateServiceDefinition({ ...validateServiceDefinition(input), id });
  if (!existingId && services.some(service => service.id === saved.id)) throw new Error('Could not create a unique service ID.');
  return { services: [...services.filter(service => service.id !== saved.id), saved].map(validateServiceDefinition), saved };
}
export function serviceImportAllowed(services: readonly NpcServiceDefinition[], imported: readonly NpcServiceDefinition[]): void {
  if (!imported.length) throw new Error('Service document is empty.');
  if (services.length + imported.length > MAX_SERVICES) throw new Error(`Keep at most ${MAX_SERVICES} services.`);
}
export function importedServices(services: readonly NpcServiceDefinition[], imported: readonly NpcServiceDefinition[], ids: readonly string[]): NpcServiceDefinition[] {
  if (ids.length !== imported.length) throw new Error('Could not create unique service IDs.');
  const copies = imported.map((service, index) => validateServiceDefinition({ ...service, id: ids[index] }));
  if (new Set([...services, ...copies].map(service => service.id)).size !== services.length + copies.length) throw new Error('Could not create unique service IDs.');
  return copies;
}
export function exportService(services: readonly NpcServiceDefinition[], id: string): string {
  const service = services.find(saved => saved.id === id);
  if (!service) throw new Error('Choose a service to export.');
  return JSON.stringify({ version: 1, services: [service] }, null, 2);
}
