import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { mountClientShell, type BotSection, type ClientPage } from './client-shell';
import { WarpUi } from './warp-ui';
import { DEFAULT_AUTOMATION } from './settings';
import type { WarpBinding, WarpRequest } from './warp-protocol';
import type { WarpSnapshot } from './warp';

const pages: ClientPage[] = ['session', 'bot', 'manual', 'settings'];
const sections: BotSection[] = ['combat', 'recovery', 'travel', 'inventory', 'workflows'];
type NavigationEvent = { key: string; preventDefault(): void };

// A narrow navigation adapter, not an HTML parser. The real mounted control
// inventory, browser focus behavior and responsive layout need browser proof.
class NavigationDocument {
  activeElement: NavigationNode | null = null;
  createElement(tag: string): NavigationNode { return new NavigationNode(this, tag); }
}
class NavigationNode {
  readonly children: NavigationNode[] = [];
  readonly attributes = new Map<string, string>();
  readonly selectors = new Map<string, NavigationNode>();
  readonly listeners = new Map<string, Array<(event: NavigationEvent) => void>>();
  readonly classes = new Set<string>();
  readonly styleProperties = new Map<string, string>();
  style = { setProperty: (name: string, value: string) => this.styleProperties.set(name, value) };
  classList = { toggle: (name: string, enabled: boolean) => enabled ? this.classes.add(name) : this.classes.delete(name) };
  parentElement: NavigationNode | null = null;
  id = ''; className = ''; innerHTML = ''; textContent = ''; value = ''; href = ''; type = '';
  hidden = false; disabled = false; checked = false; open = false; tabIndex = 0;
  height = 160;
  focusOptions: FocusOptions | undefined;
  scrollOptions: ScrollIntoViewOptions | undefined;
  constructor(readonly ownerDocument: NavigationDocument, readonly tag: string) {}
  get tagName(): string { return this.tag.toUpperCase(); }
  get childElementCount(): number { return this.children.length; }
  append(...nodes: NavigationNode[]): void { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
  replaceChildren(): void { this.children.splice(0); }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  querySelector(selector: string): NavigationNode | null {
    if (this.selectors.has(selector)) return this.selectors.get(selector)!;
    if (selector === 'summary') return this.children.find(node => node.tag === 'summary') ?? null;
    if (selector === 'h2, h3, h4') return this.children.find(node => ['h2', 'h3', 'h4'].includes(node.tag)) ?? null;
    return null;
  }
  querySelectorAll(selector: string): NavigationNode[] {
    if (selector !== 'details.manual-group, section.manual-refine, section.warp-panel, details.warp-panel') return [];
    return this.children.flatMap(node => {
      const classes = node.className.split(' ');
      const matches = node.tag === 'details' && (classes.includes('manual-group') || classes.includes('warp-panel'))
        || node.tag === 'section' && (classes.includes('manual-refine') || classes.includes('warp-panel'));
      return [...(matches ? [node] : []), ...node.querySelectorAll(selector)];
    });
  }
  addEventListener(name: string, callback: (event: NavigationEvent) => void): void { this.listeners.set(name, [...(this.listeners.get(name) ?? []), callback]); }
  getBoundingClientRect() { return { height: this.height }; }
  focus(options?: FocusOptions): void { this.focusOptions = options; this.ownerDocument.activeElement = this; }
  scrollIntoView(options: ScrollIntoViewOptions): void { this.scrollOptions = options; }
  emit(name: string, key = '') { const event = { key, preventDefault: vi.fn() }; for (const callback of this.listeners.get(name) ?? []) callback(event); return event; }
  visible(): boolean { return !this.hidden && (!this.parentElement || this.parentElement.visible()); }
}

function fixture() {
  const document = new NavigationDocument(), root = document.createElement('div');
  const register = (selector: string, tag = 'section') => {
    const node = document.createElement(tag); node.id = selector.startsWith('#') ? selector.slice(1) : '';
    root.selectors.set(selector, node); return node;
  };
  const main = register('main', 'main'), toolbar = register('.client-toolbar', 'header'); root.append(main); main.append(toolbar);
  const stop = register('#stop', 'button'), notice = register('#notice', 'div'); toolbar.append(stop, notice);
  const pagePanels = Object.fromEntries(pages.map(page => {
    const panel = register(`#client-page-${page}`); main.append(panel);
    panel.append(register(`#client-page-${page}-title`, 'h2'));
    main.append(register(`#client-tab-${page}`, 'button'));
    return [page, panel];
  })) as Record<ClientPage, NavigationNode>;
  for (const section of sections) {
    const panel = register(`#client-bot-${section}`); pagePanels.bot.append(panel);
    panel.append(register(`#client-bot-${section}-title`, 'h3'));
    pagePanels.bot.append(register(`#client-bot-tab-${section}`, 'button'));
  }
  pagePanels.settings.append(register('#client-profiles'));
  const manualTools = register('#client-manual-tools'); pagePanels.manual.append(manualTools);
  manualTools.append(register('#client-manual-index', 'nav'));
  pagePanels.session.append(register('#client-session-details', 'div'));
  pagePanels.session.append(register('#console-edit-setup', 'button'));
  for (const key of ['nearby', 'inventory']) {
    const panel = register(`#console-panel-${key}`); pagePanels.session.append(panel);
    panel.append(register(`#console-${key}-title`, 'h3'));
    pagePanels.session.append(register(`#console-tab-${key}`, 'button'));
  }
  main.append(register('.client-skip-link', 'a'));
  const shell = mountClientShell(root as unknown as HTMLElement);
  const get = (selector: string) => root.selectors.get(selector)!;
  return { document, root, shell, get, stop, notice, pagePanels };
}

afterEach(() => vi.unstubAllGlobals());

it('retains the actual Warp UI pending and staged preview across shell pages without cancellation or sends',async()=>{
  const f=fixture();vi.stubGlobal('document',f.document);
  const binding:WarpBinding={world:'00000000-0000-4000-8000-000000000001',actorId:0,incarnation:1,connectionEpoch:1,revision:1,map:'prt_fild08',x:10,y:10,generation:1,level:4,inventoryRevision:1,equipmentRevision:1,spRevision:1,skillsRevision:1};
  const request:WarpRequest={type:'warpGround',slot:0,target:{x:11,y:10},preview:binding};
  const snapshot:WarpSnapshot={generation:1,blocked:false,pending:false,state:'idle',reason:'Ready',ready:binding,activation:null,preview:null,slots:[{map:'prontera',x:100,y:100},null,null,null],cost:26,gems:3,reserve:1,selection:'unknown',resourceEvidence:'No request sent.',captured:null};
  const policy=structuredClone(DEFAULT_AUTOMATION),send=vi.fn(async()=>{}),cancel=vi.fn(async()=>{});
  let acknowledge!:()=>void;const prepare=vi.fn(()=>new Promise<void>(resolve=>{acknowledge=resolve;}));
  const ui=new WarpUi(send,vi.fn(),prepare,()=>policy,cancel),root=ui.root as unknown as NavigationNode;
  (f.shell.manualTools as unknown as NavigationNode).append(root);root.open=true;f.shell.refreshManualIndex();
  const status=()=>({sessionId:'synthetic-page',connectionId:'synthetic-connection',player:{id:0,name:'Synthetic'},warp:snapshot});
  ui.render(status());ui.lock(false);
  const field=(label:string)=>root.children.find(node=>node.attributes.get('aria-label')===label)!;
  const button=(label:string)=>root.children.find(node=>node.tag==='button'&&node.textContent===label)!;
  const x=field('Warp ground X'),y=field('Warp ground Y'),output=field('Warp request preview'),submit=button('Submit ground once');
  x.value='11';y.value='10';button('Preview ground request').emit('click');
  expect(prepare).toHaveBeenCalledOnce();expect(submit.disabled).toBe(true);
  for(const page of pages)f.shell.showPage(page);
  expect(root.open).toBe(true);expect(x.value).toBe('11');expect(y.value).toBe('10');expect(cancel).not.toHaveBeenCalled();
  acknowledge();await Promise.resolve();await Promise.resolve();snapshot.preview=request;ui.render(status());
  const preview=output.textContent;expect(preview).toContain('prontera (100, 100)');expect(submit.disabled).toBe(false);
  for(const page of pages)f.shell.showPage(page);
  const index=f.get('#client-manual-index');expect(index.children).toHaveLength(1);index.children[0]!.emit('click');
  expect(root.parentElement).toBe(f.shell.manualTools);expect(root.open).toBe(true);
  expect(field('Warp ground X')).toBe(x);expect(field('Warp request preview')).toBe(output);expect(output.textContent).toBe(preview);
  expect(submit.disabled).toBe(false);
  expect(prepare).toHaveBeenCalledOnce();expect(cancel).not.toHaveBeenCalled();expect(send).not.toHaveBeenCalled();
});

describe('client shell navigation', () => {
  it('retains inventory and coordinate drafts and locks through inspector tabs and pure Edit setup', () => {
    const f = fixture(), inventory = f.get('#console-panel-inventory');
    const item = f.document.createElement('select'); item.value = '501'; item.disabled = true;
    const coordinate = f.document.createElement('input'); coordinate.value = '123'; coordinate.disabled = true;
    inventory.append(item); f.pagePanels.session.append(coordinate);
    const changed = vi.fn(), command = vi.fn(); item.addEventListener('change', changed); coordinate.addEventListener('input', changed);
    inventory.append(f.document.createElement('button')); inventory.children.at(-1)!.addEventListener('click', command);
    f.get('#console-tab-inventory').emit('click');
    expect(inventory.hidden).toBe(false); expect(f.get('#console-panel-nearby').hidden).toBe(true);
    expect(f.document.activeElement).toBe(f.get('#console-inventory-title'));
    f.get('#console-tab-inventory').emit('keydown', 'ArrowRight');
    expect(f.get('#console-panel-nearby').hidden).toBe(false); expect(f.document.activeElement).toBe(f.get('#console-tab-nearby'));
    f.get('#console-edit-setup').emit('click'); expect(f.pagePanels.bot.hidden).toBe(false);
    f.shell.showPage('session'); f.shell.showInspector('inventory');
    expect(inventory.children).toContain(item); expect(item.value).toBe('501'); expect(item.disabled).toBe(true);
    expect(coordinate.value).toBe('123'); expect(coordinate.disabled).toBe(true);
    expect(changed).not.toHaveBeenCalled(); expect(command).not.toHaveBeenCalled();
  });
  it('retains mounted nodes, edited values and locks across all pages and Bot sections', () => {
    const f = fixture(), fields = sections.map(section => {
      const input = f.document.createElement('input'); input.value = `edited ${section}`; input.checked = true; input.disabled = true;
      (f.shell.sections[section] as unknown as NavigationNode).append(input); return input;
    });
    const profile = f.document.createElement('textarea'); profile.value = '{"draft":true}';
    (f.shell.sections.profiles as unknown as NavigationNode).append(profile);
    const identities = [f.shell.main, f.shell.manualTools, f.shell.sessionDetails, ...Object.values(f.shell.sections)];
    const markup = f.root.innerHTML;
    for (const page of [...pages, ...[...pages].reverse()]) {
      f.shell.showPage(page);
      expect(f.pagePanels[page].hidden).toBe(false);
      expect(Object.values(f.pagePanels).filter(panel => !panel.hidden)).toHaveLength(1);
      for (const section of sections) {
        f.shell.showBotSection(section);
        expect(f.shell.sections[section].hidden).toBe(false);
        expect(sections.filter(key => !f.shell.sections[key].hidden)).toEqual([section]);
      }
    }
    expect([f.shell.main, f.shell.manualTools, f.shell.sessionDetails, ...Object.values(f.shell.sections)]).toEqual(identities);
    for (const [index, input] of fields.entries()) {
      expect((f.shell.sections[sections[index]!] as unknown as NavigationNode).children).toContain(input);
      expect(input.value).toBe(`edited ${sections[index]}`); expect(input.checked).toBe(true); expect(input.disabled).toBe(true);
    }
    expect(profile.value).toBe('{"draft":true}'); expect(f.root.innerHTML).toBe(markup);
  });

  it('keeps Stop and the authoritative reason visible outside every hidden page', () => {
    const f = fixture(); f.notice.textContent = 'Waiting at the death cap.'; f.stop.disabled = false;
    for (const page of pages) for (const section of sections) {
      f.shell.showPage(page); f.shell.showBotSection(section);
      expect(f.stop.visible()).toBe(true); expect(f.stop.disabled).toBe(false);
      expect(f.notice.visible()).toBe(true); expect(f.notice.textContent).toBe('Waiting at the death cap.');
    }
    // Source placement is checked here; real browser placement is a separate proof.
    const toolbar = f.root.innerHTML.split('<header class="client-toolbar">')[1]!.split('</header>')[0]!;
    for (const id of ['start', 'stop', 'open', 'notice', 'status', 'character', 'location', 'config-help', 'hp-text', 'sp-text', 'console-levels', 'console-weight', 'console-zeny', 'console-experience', 'death-count', 'death-cap']) expect(toolbar).toContain(`id="${id}"`);
    expect(f.root.innerHTML).toContain('Bot console'); expect(f.root.innerHTML).toContain('Connect account');
    expect(f.root.innerHTML).not.toContain('Open game');
  });

  it('keeps profiles on Settings independently of the selected Bot subsection', () => {
    const f = fixture(); f.shell.showPage('settings');
    for (const section of sections) {
      f.shell.showBotSection(section);
      expect(f.shell.sections.profiles).toBe(f.get('#client-profiles'));
      expect((f.shell.sections.profiles as unknown as NavigationNode).visible()).toBe(true);
      expect(f.pagePanels.settings.hidden).toBe(false); expect(f.pagePanels.bot.hidden).toBe(true);
      expect(f.document.activeElement).toBe(f.get('#client-page-settings-title'));
    }
  });

  it('accepts only a mount root and leaves storage, edits and command owners untouched', () => {
    expectTypeOf<Parameters<typeof mountClientShell>>().toEqualTypeOf<[HTMLElement]>();
    const getItem = vi.fn(), setItem = vi.fn(), command = vi.fn(), changed = vi.fn(), fetch = vi.fn();
    vi.stubGlobal('localStorage', { getItem, setItem }); vi.stubGlobal('fetch', fetch);
    const f = fixture(), field = f.document.createElement('input'); field.value = 'keep draft';
    field.addEventListener('input', changed); field.addEventListener('change', changed);
    const send = f.document.createElement('button'); send.addEventListener('click', command);
    (f.shell.manualTools as unknown as NavigationNode).append(field, send);
    for (const page of pages) f.get(`#client-tab-${page}`).emit('click');
    for (const section of sections) f.get(`#client-bot-tab-${section}`).emit('click');
    expect(field.value).toBe('keep draft'); expect(changed).not.toHaveBeenCalled(); expect(command).not.toHaveBeenCalled();
    expect(getItem).not.toHaveBeenCalled(); expect(setItem).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it('uses roving tab selection, arrow wrapping, Home and End without moving focus into hidden content', () => {
    const f = fixture();
    expect(f.document.activeElement).toBeNull();
    const arrow = f.get('#client-tab-session').emit('keydown', 'ArrowRight'); expect(arrow.preventDefault).toHaveBeenCalledOnce();
    expect(f.pagePanels.bot.hidden).toBe(false); expect(f.document.activeElement).toBe(f.get('#client-tab-bot'));
    for (const page of pages) {
      expect(f.get(`#client-tab-${page}`).tabIndex).toBe(page === 'bot' ? 0 : -1);
      expect(f.get(`#client-tab-${page}`).attributes.get('aria-selected')).toBe(String(page === 'bot'));
    }
    f.get('#client-tab-bot').emit('keydown', 'End'); expect(f.document.activeElement).toBe(f.get('#client-tab-settings'));
    f.get('#client-tab-settings').emit('keydown', 'ArrowRight'); expect(f.document.activeElement).toBe(f.get('#client-tab-session'));
    f.get('#client-tab-session').emit('keydown', 'ArrowLeft'); expect(f.document.activeElement).toBe(f.get('#client-tab-settings'));
    f.get('#client-tab-settings').emit('keydown', 'Home'); expect(f.document.activeElement).toBe(f.get('#client-tab-session'));
    const ignored = f.get('#client-tab-session').emit('keydown', 'Escape'); expect(ignored.preventDefault).not.toHaveBeenCalled();
    f.get('#client-tab-bot').emit('click'); expect(f.document.activeElement).toBe(f.get('#client-page-bot-title'));
    expect(f.get('.client-skip-link').href).toBe('#client-page-bot-title');
    f.get('#client-bot-tab-combat').emit('keydown', 'End');
    expect(f.document.activeElement).toBe(f.get('#client-bot-tab-workflows')); expect(f.shell.sections.workflows.hidden).toBe(false);
    f.get('#client-bot-tab-workflows').emit('keydown', 'ArrowDown'); expect(f.document.activeElement).toBe(f.get('#client-bot-tab-combat'));
    f.get('#client-bot-tab-combat').emit('keydown', 'ArrowUp'); expect(f.document.activeElement).toBe(f.get('#client-bot-tab-workflows'));
    f.get('#client-bot-tab-recovery').emit('click'); expect(f.document.activeElement).toBe(f.get('#client-bot-recovery-title'));
    for (const section of sections) expect(f.get(`#client-bot-tab-${section}`).attributes.get('aria-selected')).toBe(String(section === 'recovery'));
  });

  it('updates focus clearance when the toolbar grows and scrolls content focus without animation', () => {
    const resized: Array<() => void> = [], observed: NavigationNode[] = [];
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resized.push(callback); }
      observe(node: NavigationNode) { observed.push(node); }
    });
    const f = fixture(), toolbar = f.get('.client-toolbar'), main = f.shell.main as unknown as NavigationNode;
    expect(observed).toEqual([toolbar]); expect(main.styleProperties.get('--client-toolbar-offset')).toBe('176px');
    toolbar.height = 283.5; resized[0]!(); expect(main.styleProperties.get('--client-toolbar-offset')).toBe('300px');
    f.shell.showPage('settings'); const title = f.get('#client-page-settings-title');
    expect(f.document.activeElement).toBe(title); expect(title.focusOptions).toEqual({ preventScroll: true });
    expect(title.scrollOptions).toEqual({ block: 'nearest', behavior: 'instant' });
    toolbar.height = 310; f.shell.showPage('bot'); f.shell.showBotSection('recovery');
    expect(main.styleProperties.get('--client-toolbar-offset')).toBe('326px');
    expect(f.get('#client-bot-recovery-title').scrollOptions).toEqual({ block: 'nearest', behavior: 'instant' });
  });

  it('indexes mounted manual groups using literal labels and opens/focuses without sending an action', () => {
    const f = fixture(), group = f.document.createElement('details'); group.className = 'manual-group'; group.id = 'synthetic-tool';
    const summary = f.document.createElement('summary'); summary.textContent = '<b>NPC dialogue</b>';
    const draft = f.document.createElement('input'); draft.value = 'edited';
    const send = f.document.createElement('button'), command = vi.fn(); send.addEventListener('click', command);
    group.append(summary, draft, send); (f.shell.manualTools as unknown as NavigationNode).append(group);
    f.shell.refreshManualIndex(); const index = f.get('#client-manual-index');
    expect(index.hidden).toBe(false); expect(index.children).toHaveLength(1);
    expect(index.children[0]!.textContent).toBe('<b>NPC dialogue</b>'); expect(index.children[0]!.innerHTML).toBe('');
    expect(index.children[0]!.attributes.get('aria-controls')).toBe('synthetic-tool');
    index.children[0]!.emit('click');
    expect(f.pagePanels.manual.hidden).toBe(false); expect(group.open).toBe(true); expect(f.document.activeElement).toBe(summary);
    expect(group.children).toEqual([summary, draft, send]); expect(draft.value).toBe('edited'); expect(command).not.toHaveBeenCalled();
    f.shell.refreshManualIndex(); expect(index.children).toHaveLength(1); expect(group.children).toContain(draft);
  });

  it('opens enclosing manual details so nested indexed tools receive visible focus', () => {
    const f = fixture(), parent = f.document.createElement('details'), group = f.document.createElement('details');
    parent.className = group.className = 'manual-group';
    const parentTitle = f.document.createElement('summary'); parentTitle.textContent = 'Workflow builder'; parent.append(parentTitle);
    const summary = f.document.createElement('summary'); summary.textContent = 'Advanced workflow document'; group.append(summary); parent.append(group);
    (f.shell.manualTools as unknown as NavigationNode).append(parent); f.shell.refreshManualIndex();
    const index = f.get('#client-manual-index'); expect(index.children).toHaveLength(2);
    index.children[1]!.emit('click');
    expect(parent.open).toBe(true); expect(group.open).toBe(true); expect(f.document.activeElement).toBe(summary);
  });

  it('indexes the actual Refine and Warp shapes once and focuses without changing drafts or dispatching', () => {
    const f = fixture(), command = vi.fn(), changed = vi.fn();
    const definitions = [
      ['section', 'manual-refine', 'h3', 'Refine one item'],
      ['details', 'manual-group warp-panel', 'summary', 'Warp Portal · manual request'],
      ['section', 'warp-panel', 'h3', 'Warp section'],
      ['details', 'warp-panel', 'summary', 'Warp details'],
    ] as const;
    const mounted = definitions.map(([tag, className, headingTag, title]) => {
      const group = f.document.createElement(tag); group.className = className;
      const heading = f.document.createElement(headingTag); heading.textContent = title;
      const draft = f.document.createElement('input'); draft.value = 'kept'; draft.disabled = true; draft.addEventListener('input', changed);
      const send = f.document.createElement('button'); send.addEventListener('click', command);
      group.append(heading, draft, send); (f.shell.manualTools as unknown as NavigationNode).append(group);
      return { group, heading, draft, send };
    });
    f.shell.refreshManualIndex(); const index = f.get('#client-manual-index'); expect(index.children).toHaveLength(4);
    for (const [position, { group, heading, draft, send }] of mounted.entries()) {
      expect(index.children[position]!.textContent).toBe(heading.textContent); index.children[position]!.emit('click');
      expect(f.document.activeElement).toBe(heading); expect(heading.tabIndex).toBe(group.tag === 'section' ? -1 : 0);
      expect(heading.focusOptions).toEqual({ preventScroll: true }); expect(heading.scrollOptions).toEqual({ block: 'nearest', behavior: 'instant' });
      expect(group.open).toBe(group.tag === 'details'); expect(group.children).toEqual([heading, draft, send]);
      expect(draft.value).toBe('kept'); expect(draft.disabled).toBe(true);
    }
    expect(command).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled();
  });

  it('has one source ID per control and preserves the account, update and option contracts', () => {
    const f = fixture(), html = f.root.innerHTML, ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]!);
    expect(new Set(ids).size).toBe(ids.length);
    // SettingsForm owns the only monster datalist; the shell must not duplicate it.
    expect(ids).not.toContain('classId-catalog');
    for (const id of ['client-version', 'open', 'notice', 'signin-panel', 'saved-account', 'signin-form', 'username', 'password', 'character-slot', 'remember-login', 'auto-login', 'auto-reconnect', 'forget-login', 'reconnect-help', 'login-help', 'signin', 'status', 'character', 'location', 'hp-text', 'hp-bar', 'sp-text', 'sp-bar', 'death-count', 'death-cap', 'attacks', 'kills', 'looted', 'nearby', 'target-map', 'target-count', 'select-targets', 'clear-targets', 'targets', 'target-source', 'radius', 'radius-value', 'min-hp', 'hp-value', 'random-walk', 'route-step', 'route-time', 'attack-distance', 'attack-time', 'avoid-walls', 'attack-range', 'loot', 'start', 'stop', 'map-label', 'radar', 'navigation-info', 'monster-list', 'target-label', 'log', 'update-status', 'update-download', 'config-help']) expect(ids.filter(value => value === id)).toHaveLength(1);
    expect(html).toContain('Saved credentials use a local file with user-only access. The app does not encrypt them.');
    expect(html).toContain('Passwords stay in memory unless you save locally');
    expect(html).toContain('id="password" type="password" maxlength="256" autocomplete="off" />');
    expect(html).toContain('<option value="0">Off · approach visible targets only</option><option value="2">2 · Search the current map</option>');
    expect(html).toContain('id="radius" type="range" min="1" max="20" value="12"');
    expect(html).toContain('id="min-hp" type="range" min="20" max="95" value="45"');
    expect(html).toContain('Signed updates install automatically when every game and login action is stopped.');
    expect(html).not.toContain('<iframe');
    expect(html).toContain('role="tablist" aria-label="Companion pages"');
    expect(html).toContain('class="panel settings feature-panel" data-section="profiles"');
  });
});
