import { DirectRuntime } from '../modules/runtime/direct-runtime';
import { loadNativeMapCatalog, MapCatalogLoader } from '../modules/navigation/map-data';
interface RuntimeWindow extends Window {
  __TAURI_INTERNALS__?: { invoke: (name: string, args: unknown) => Promise<unknown> };
  __RAYRAG__?: unknown;
}
const page = window as RuntimeWindow;
if (page.__TAURI_INTERNALS__ && !page.__RAYRAG__) {
  void page.__TAURI_INTERNALS__
    .invoke('warp_guard_initialize', {
      legacyHeld: localStorage.getItem('rayrag.warp.uncertain.v1') !== null,
    })
    .then((value) => {
      if (value !== null && typeof value !== 'string') throw new Error('Warp guard unavailable');
      if (value !== null) localStorage.setItem('rayrag.warp.uncertain.v1', 'held');
      const runtime = new DirectRuntime({
        invoke: (name, args) => page.__TAURI_INTERNALS__!.invoke(name, args),
        guardNonce: value ?? undefined,
        store: {
          read: () => localStorage.getItem('rayrag.warp.uncertain.v1') !== null,
          write: (held) => {
            if (held) localStorage.setItem('rayrag.warp.uncertain.v1', 'held');
            else localStorage.removeItem('rayrag.warp.uncertain.v1');
          },
        },
      });
      page.__RAYRAG__ = {
        control: runtime.control.bind(runtime),
        perform: runtime.perform.bind(runtime),
        maintenance: runtime.maintenance.bind(runtime),
        prepareUpdate: runtime.prepareUpdate.bind(runtime),
        cancelUpdate: runtime.cancelUpdate.bind(runtime),
        restoreUpdate: runtime.restoreUpdate.bind(runtime),
        snapshot: runtime.snapshot.bind(runtime),
      };
      void runtime.connect().then(() => {
        setInterval(() => {
          void runtime.cycle();
        }, 100);
      });
      const catalogue = new MapCatalogLoader(
        () => loadNativeMapCatalog((name, args) => page.__TAURI_INTERNALS__!.invoke(name, args)),
        () => {
          runtime.catalog = catalogue.catalog;
          runtime.catalogLoading = catalogue.loading;
          void runtime.publish();
        },
      );
      page.addEventListener('pagehide', () => catalogue.dispose(), { once: true });
      void catalogue.start();
    })
    .catch(() => {});
}
