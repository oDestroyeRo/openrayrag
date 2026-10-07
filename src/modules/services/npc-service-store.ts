import { filter, map } from 'effect/Array';
import { validateServiceDefinition } from './npc-services-logic';
import { parseServiceDocument, encodeServiceDocument, serviceSaveAllowed, savedServices, serviceImportAllowed, importedServices, exportService, checkedSavedService, type SavedServiceDefinition } from './npc-service-store-logic';
import { readStoredText, writeStoredText, type TextStorage } from '../../shared/storage-effects';
export { MAX_SERVICES, type SavedServiceDefinition, type SavedServiceId, type ServiceContractId } from './npc-service-store-logic';
export const SERVICE_STORAGE_KEY = 'rayrag.companion.services.v1';

/** Local persistence never serializes actor binding, pending receipts or conversation state. */
export class NpcServiceStore {
  private services: readonly SavedServiceDefinition[] = [];
  constructor(private readonly storage: TextStorage, private readonly id: () => string = () => crypto.randomUUID()) {
    try {
      const saved = readStoredText(storage, SERVICE_STORAGE_KEY);
      if (saved) this.services = parseServiceDocument(saved);
    } catch { /* Incompatible saved data cannot become executable. */ }
  }
  list(): readonly SavedServiceDefinition[] { return map(this.services, checkedSavedService); }
  private persist(services: readonly SavedServiceDefinition[]): void {
    writeStoredText(this.storage, SERVICE_STORAGE_KEY, encodeServiceDocument(services));
    this.services = services;
  }
  save(input: unknown, existingId?: string): SavedServiceDefinition {
    serviceSaveAllowed(this.services, existingId);
    const valid = validateServiceDefinition(input);
    const proposal = savedServices(this.services, valid, existingId ?? this.id(), existingId);
    this.persist(proposal.services);
    return checkedSavedService(proposal.saved);
  }
  remove(id: string): void { this.persist(filter(this.services, service => service.id !== id)); }
  export(id: string): string { return exportService(this.services, id); }
  import(text: string): readonly SavedServiceDefinition[] {
    const imported = parseServiceDocument(text);
    serviceImportAllowed(this.services, imported);
    const copies = importedServices(this.services, imported, imported.map(() => this.id()));
    this.persist([...this.services, ...copies]);
    return map(copies, checkedSavedService);
  }
}
