import { validateServiceDefinition, type NpcServiceDefinition } from './npc-services';
import { parseServiceDocument, encodeServiceDocument, serviceSaveAllowed, savedServices, serviceImportAllowed, importedServices, exportService } from './npc-service-store-logic';
import { readStoredText, writeStoredText, type TextStorage } from './storage-effects';
export { MAX_SERVICES } from './npc-service-store-logic';
export const SERVICE_STORAGE_KEY = 'rayrag.companion.services.v1';

/** Local persistence never serializes actor binding, pending receipts or conversation state. */
export class NpcServiceStore {
  private services: NpcServiceDefinition[] = [];
  constructor(private readonly storage: TextStorage, private readonly id: () => string = () => crypto.randomUUID()) {
    try {
      const saved = readStoredText(storage, SERVICE_STORAGE_KEY);
      if (saved) this.services = parseServiceDocument(saved);
    } catch { /* Incompatible saved data cannot become executable. */ }
  }
  list(): NpcServiceDefinition[] { return this.services.map(validateServiceDefinition); }
  private persist(services: NpcServiceDefinition[]): void {
    writeStoredText(this.storage, SERVICE_STORAGE_KEY, encodeServiceDocument(services));
    this.services = services;
  }
  save(input: unknown, existingId?: string): NpcServiceDefinition {
    serviceSaveAllowed(this.services, existingId);
    const valid = validateServiceDefinition(input);
    const proposal = savedServices(this.services, valid, existingId ?? this.id(), existingId);
    this.persist(proposal.services);
    return validateServiceDefinition(proposal.saved);
  }
  remove(id: string): void { this.persist(this.services.filter(service => service.id !== id)); }
  export(id: string): string { return exportService(this.services, id); }
  import(text: string): NpcServiceDefinition[] {
    const imported = parseServiceDocument(text);
    serviceImportAllowed(this.services, imported);
    const copies = importedServices(this.services, imported, imported.map(() => this.id()));
    this.persist([...this.services, ...copies]);
    return copies.map(validateServiceDefinition);
  }
}
