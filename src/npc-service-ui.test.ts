import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeatureUi } from './feature-ui';
import { NpcServiceStore } from './npc-service-store';

// This small DOM fixture exercises the real panel callbacks without loading the
// account-bearing app entrypoint or adding a browser dependency to Node tests.
class Element {
  children: Element[] = [];
  textContent = '';
  value = '';
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  listeners = new Map<string, Array<() => unknown>>();
  constructor(readonly tag: string) {}
  append(...children: Element[]): void {
    this.children.push(...children);
    if (this.tag === 'select' && !this.value) this.value = this.children[0]?.value ?? '';
  }
  replaceChildren(...children: Element[]): void {
    this.children = [];
    this.value = '';
    this.append(...children);
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  addEventListener(name: string, callback: () => unknown): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), callback]);
  }
  querySelectorAll(): Element[] {
    return [];
  }
  all(): Element[] {
    return [this, ...this.children.flatMap((child) => child.all())];
  }
  async click(): Promise<void> {
    for (const callback of this.listeners.get('click') ?? []) callback();
    await Promise.resolve();
    await Promise.resolve();
  }
}
function setup() {
  vi.stubGlobal('document', { createElement: (tag: string) => new Element(tag) });
  const panel = new Element('section'),
    host = new Element('main');
  const values = new Map<string, string>();
  let nextId = 0;
  const store = new NpcServiceStore(
    {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value);
      },
    },
    () => `service-${++nextId}`,
  );
  const hooks = {
    notify: vi.fn(),
    service: vi.fn(async (_spec: unknown) => 'Service requested.'),
    map: () => 'prontera',
  };
  const view: object = Object.create(FeatureUi.prototype);
  Object.assign(view, {
    panels: new Map([['workflows', panel]]),
    editors: new Map(),
    dispositionEditor: { lock: () => {} },
    host,
    hooks,
    services: store,
    locked: false,
    manualLocked: true,
    serviceLocked: true,
    status: {},
  });
  Reflect.apply(Reflect.get(FeatureUi.prototype, 'servicePanel'), view, []);
  const button = (name: string) => panel.all().find((node) => node.tag === 'button' && node.textContent === name)!;
  const field = (name: string) => panel.all().find((node) => node.attributes.get('aria-label') === name)!;
  const lock = (config: boolean, manual: boolean, service: boolean) =>
    Reflect.apply(Reflect.get(FeatureUi.prototype, 'lock'), view, [config, manual, service]);
  return { panel, store, hooks, button, field, lock };
}
afterEach(() => vi.unstubAllGlobals());
describe('NPC service UI ownership gates', () => {
  it('previews and saves, exports, imports and deletes configuration while offline', async () => {
    const s = setup();
    s.lock(false, true, true);
    await s.button('Preview').click();
    expect(s.panel.all().some((node) => node.textContent.startsWith('Verified contract'))).toBe(true);
    await s.button('Save / update').click();
    expect(s.store.list()).toHaveLength(1);
    expect(s.hooks.notify).toHaveBeenLastCalledWith('NPC service saved on this Mac.');
    await s.button('Export saved').click();
    expect(JSON.parse(s.field('Import or export service document').value).services).toHaveLength(1);
    await s.button('Import document').click();
    expect(s.store.list()).toHaveLength(2);
    expect(s.store.list()[0]!.id).not.toBe(s.store.list()[1]!.id);
    await s.button('Delete saved').click();
    expect(s.store.list()).toHaveLength(1);
    await s.button('Run service').click();
    expect(s.hooks.service).not.toHaveBeenCalled();
    expect(s.hooks.notify.mock.calls.flat().join(' ')).not.toContain('Waiting for the game');
  });
  it('runs a verified service during field automation while keeping configuration locked', async () => {
    const s = setup();
    s.lock(true, true, false);
    await s.button('Save / update').click();
    expect(s.store.list()).toHaveLength(0);
    await s.button('Run service').click();
    expect(s.hooks.service).toHaveBeenCalledOnce();
    expect(s.hooks.service.mock.calls[0]?.[0]).not.toHaveProperty('npcId');
    s.lock(true, true, true);
    await s.button('Run service').click();
    expect(s.hooks.service).toHaveBeenCalledOnce();
  });
});
