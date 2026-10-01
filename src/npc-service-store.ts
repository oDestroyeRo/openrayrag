import { validateServiceDefinition, type NpcServiceDefinition } from './npc-services';
export const SERVICE_STORAGE_KEY = 'rayrag.companion.services.v1';
export const MAX_SERVICES = 20;
interface StoragePort {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
function document(text: string): NpcServiceDefinition[] {
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
/** Local persistence never serializes actor binding, pending receipts or conversation state. */
export class NpcServiceStore {
  private services: NpcServiceDefinition[] = [];
  constructor(
    private readonly storage: StoragePort,
    private readonly id: () => string = () => crypto.randomUUID(),
  ) {
    try {
      const saved = storage.getItem(SERVICE_STORAGE_KEY);
      if (saved) this.services = document(saved);
    } catch {
      /* Incompatible saved data cannot become executable. */
    }
  }
  list(): NpcServiceDefinition[] {
    return this.services.map(validateServiceDefinition);
  }
  private persist(services: NpcServiceDefinition[]): void {
    const text = JSON.stringify({ version: 1, services });
    document(text);
    this.storage.setItem(SERVICE_STORAGE_KEY, text);
    this.services = services;
  }
  save(input: unknown, existingId?: string): NpcServiceDefinition {
    if (existingId && !this.services.some((s) => s.id === existingId))
      throw new Error('Choose an existing service to update.');
    if (!existingId && this.services.length >= MAX_SERVICES) throw new Error(`Keep at most ${MAX_SERVICES} services.`);
    const s = validateServiceDefinition(input),
      copy = validateServiceDefinition({ ...s, id: existingId ?? this.id() });
    if (!existingId && this.services.some((s) => s.id === copy.id))
      throw new Error('Could not create a unique service ID.');
    this.persist([...this.services.filter((s) => s.id !== copy.id), copy]);
    return validateServiceDefinition(copy);
  }
  remove(id: string): void {
    this.persist(this.services.filter((s) => s.id !== id));
  }
  export(id: string): string {
    const s = this.services.find((s) => s.id === id);
    if (!s) throw new Error('Choose a service to export.');
    return JSON.stringify({ version: 1, services: [s] }, null, 2);
  }
  import(text: string): NpcServiceDefinition[] {
    const imported = document(text);
    if (!imported.length) throw new Error('Service document is empty.');
    if (this.services.length + imported.length > MAX_SERVICES)
      throw new Error(`Keep at most ${MAX_SERVICES} services.`);
    const copies = imported.map((s) => validateServiceDefinition({ ...s, id: this.id() }));
    if (new Set([...this.services, ...copies].map((s) => s.id)).size !== this.services.length + copies.length)
      throw new Error('Could not create unique service IDs.');
    this.persist([...this.services, ...copies]);
    return copies.map(validateServiceDefinition);
  }
}
