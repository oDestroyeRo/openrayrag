import { afterEach, describe, expect, it, vi } from 'vitest';

const ipc = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(async () => () => {}) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: ipc.invoke, isTauri: () => true }));
vi.mock('@tauri-apps/api/event', () => ({ listen: ipc.listen }));
vi.mock('./feature-ui', async () => {
  const { DEFAULT_AUTOMATION } = await import('./settings');
  return { FeatureUi: class {
    private profile:string|null=null;
    selectedProfileId(){return this.profile;}
    restoreProfileSelection(id:string|null){this.profile=id;}
    write():void{}
    levelDifference(){return 1;}
    active(): boolean { return false; }
    serviceBlocked(): boolean { return false; }
    read() { return structuredClone(DEFAULT_AUTOMATION); }
    lock(): void {}
  }, validFeatureStatus: () => true };
});

// Exercise the actual main-window form callbacks with native IPC replaced.
// No browser, app data, real account or persistent frontend store is involved.
class Element {
  value = ''; checked = false; disabled = false; hidden = false; textContent = ''; placeholder = '';
  id = ''; className = ''; dataset:Record<string,string>={}; style: Record<string, string> = {}; width = 400; height = 400;
  classList = { toggle() {}, add() {}, remove() {} };
  listeners = new Map<string, Array<(event: { preventDefault(): void;target?:Element }) => unknown>>();
  markup = '';
  constructor(private readonly elements: Map<string, Element>) {}
  set innerHTML(html: string) {
    this.markup = html;
    for (const match of html.matchAll(/<(\w+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
      const node = new Element(this.elements); node.id = match[3]!;
      node.checked = /\bchecked\b/.test(match[2]!); node.disabled = /\bdisabled\b/.test(match[2]!); node.hidden = /\bhidden\b/.test(match[2]!);
      node.value = /\bvalue="([^"]*)"/.exec(match[2]!)?.[1] ?? (match[1] === 'select' ? '0' : '');
      this.elements.set(node.id, node);
    }
  }
  append(): void {}
  replaceChildren(): void {}
  getContext() { return { clearRect() {}, fillText() {} }; }
  addEventListener(type: string, callback: (event: { preventDefault(): void;target?:Element }) => unknown): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback]);
  }
  closest(selector:string):Element|null{return selector.includes('.settings')?this:null;}
  async emit(type: string,target?:Element): Promise<void> {
    for (const callback of this.listeners.get(type) ?? []) callback({ preventDefault() {},target });
    for (let i = 0; i < 12; i++) await Promise.resolve();
  }
}
async function fixture(saved: { username: string; characterSlot: number; autoLogin: boolean } | null = null, readFails = false, savedForm:unknown=null) {
  const elements = new Map<string, Element>(), root = new Element(elements), main = new Element(elements);
  vi.useFakeTimers(); vi.stubGlobal('document', {
    querySelector: (selector: string) => selector === '#app' ? root : main,
    querySelectorAll:()=>[],
    getElementById: (id: string) => elements.get(id), createElement: () => new Element(elements),
  });
  ipc.invoke.mockReset(); ipc.listen.mockClear();
  ipc.invoke.mockImplementation(async (command: string,args?:{document?:{revision:number}}) => {
    if(command==='current_form')return savedForm;
    if(command==='save_current_form')return args?.document?.revision;
    if(command==='update_status')return {version:'0.2.27',phase:'current',message:'Current'};
    if (command === 'saved_login') { if (readFails) throw 'synthetic store failure'; return saved; }
    return undefined;
  });
  vi.resetModules(); await import('./main');
  for (let i = 0; i < 40; i++) await Promise.resolve();
  return { root, main, get: (id: string) => elements.get(id)!, calls: (command: string) => ipc.invoke.mock.calls.filter(call => call[0] === command) };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('native local-login form and metadata', () => {
  it('starts session-only and discloses unencrypted local storage without accessing frontend persistence', async () => {
    const f = await fixture();
    expect(f.root.markup).toContain('Save login on this Mac');
    expect(f.root.markup).toContain('local file with user-only access');
    expect(f.root.markup).toContain('The app does not encrypt them.');
    expect(f.root.markup).not.toContain('Keychain');
    expect(f.get('remember-login').checked).toBe(false);
    expect(f.get('auto-login').checked).toBe(false); expect(f.get('auto-login').disabled).toBe(true);
    expect(f.calls('login_game')).toHaveLength(0);
    f.get('username').value = 'synthetic-user'; f.get('password').value = 'synthetic-only-password'; f.get('character-slot').value = '2';
    await f.get('signin-form').emit('submit');
    expect(f.calls('login_game')).toEqual([['login_game', { request: {
      credentials: { username: 'synthetic-user', password: 'synthetic-only-password', characterSlot: 2 },
      characterSlot: 2, remember: false, autoLogin: false,
    } }]]);
    expect(f.get('password').value).toBe(''); expect(f.get('saved-account').textContent).toBe('Session only');
  });
  it('requires explicit remember opt-in and clears automatic launch preference on uncheck', async () => {
    const f = await fixture();
    f.get('remember-login').checked = true; await f.get('remember-login').emit('change');
    expect(f.get('auto-login').disabled).toBe(false);
    f.get('auto-login').checked = true; f.get('remember-login').checked = false; await f.get('remember-login').emit('change');
    expect(f.get('auto-login').checked).toBe(false); expect(f.get('auto-login').disabled).toBe(true);
  });
  it('restores only metadata and saved slot, with password reused natively on explicit sign-in', async () => {
    const f = await fixture({ username: 'synthetic-user', characterSlot: 2, autoLogin: false });
    expect(f.get('username').value).toBe('synthetic-user'); expect(f.get('character-slot').value).toBe('2');
    expect(f.get('password').value).toBe(''); expect(f.calls('login_game')).toHaveLength(0);
    f.get('character-slot').value = '1'; await f.get('signin-form').emit('submit');
    expect(f.calls('login_game')).toEqual([['login_game', { request: { credentials: null, characterSlot: 1, remember: true, autoLogin: false } }]]);
  });
  it('auto-login uses native reuse and the saved slot without returning a password to the form', async () => {
    const f = await fixture({ username: 'synthetic-user', characterSlot: 2, autoLogin: true });
    expect(f.calls('login_game')).toEqual([['login_game', { request: { credentials: null, characterSlot: 2, remember: true, autoLogin: true } }]]);
    expect(f.get('password').value).toBe('');
  });
  it('Forget deletes the local profile and clears launch preference, including after unreadable metadata', async () => {
    for (const readFails of [false, true]) {
      const f = await fixture(readFails ? null : { username: 'synthetic-user', characterSlot: 1, autoLogin: false }, readFails);
      expect(f.get('forget-login').hidden).toBe(false);
      await f.get('forget-login').emit('click');
      expect(f.calls('forget_login')).toHaveLength(1); expect(f.get('forget-login').hidden).toBe(true);
      expect(f.get('remember-login').checked).toBe(false); expect(f.get('auto-login').checked).toBe(false);
      expect(f.get('notice').textContent).toBe('Local saved login and app-open sign-in preference removed.');
      expect(f.get('password').value).toBe('');
    }
  });
});

describe('current form before app-open login',()=>{
  it('restores native current settings and logical targets before optional sign-in without starting the bot',async()=>{
    const {DEFAULT_SETTINGS}=await import('./settings');
    const document={version:1,revision:12,selectedProfileId:'profile_one',settings:{...DEFAULT_SETTINGS,map:'prt_fild08',targets:[4000],radius:17}};
    const f=await fixture({username:'synthetic-user',characterSlot:2,autoLogin:true},false,document);
    expect(f.get('radius').value).toBe('17');expect(f.calls('control_bot')).toEqual([]);
    const save=f.calls('save_current_form')[0]![1] as {document:{settings:{map:string;targets:number[];radius:number};selectedProfileId:string}};
    expect(save.document.settings).toMatchObject({map:'prt_fild08',targets:[4000],radius:17});expect(save.document.selectedProfileId).toBe('profile_one');
    expect(ipc.invoke.mock.calls.findIndex(c=>c[0]==='save_current_form')).toBeLessThan(ipc.invoke.mock.calls.findIndex(c=>c[0]==='login_game'));
    expect(JSON.stringify(save)).not.toMatch(/password|username|running|runRequested/);
  });
});

it('recovers continuous saves when an edit during delayed restore is invalid then corrected',async()=>{
 const {DEFAULT_SETTINGS}=await import('./settings');let release:(v:unknown)=>void=()=>{};const delayed=new Promise(r=>{release=r;});const f=await fixture(null,false,delayed);
 f.get('radius').value='99';await f.main.emit('input',f.get('radius'));release({version:1,revision:12,selectedProfileId:null,settings:DEFAULT_SETTINGS});for(let i=0;i<40;i++)await Promise.resolve();expect(f.get('radius').value).toBe('99');expect(f.calls('save_current_form')).toEqual([]);
 f.get('radius').value='12';await f.main.emit('input',f.get('radius'));await vi.advanceTimersByTimeAsync(1000);expect(f.calls('save_current_form')).toHaveLength(1);
});

describe('unsent account draft update fence',()=>{
  it.each(['password','username','character-slot','remember-login','auto-login'])('defers installation for %s, then permits it after restoring the baseline',async(id)=>{
    const f=await fixture();
    const input=f.get(id),beforeValue=input.value,beforeChecked=input.checked;
    if(id.endsWith('-login'))input.checked=true;
    else input.value=id==='character-slot'?'1':'synthetic-unsent';
    ipc.invoke.mockImplementation(async(command:string,args?:{document:{revision:number}})=>{
      if(command==='update_status')return {version:'0.2.27',phase:'waiting',message:'Update ready'};
      if(command==='save_current_form')return args!.document.revision;
      if(command==='update_reserve')return 'a'.repeat(32);
      if(command==='update_install')return true;
    });
    await vi.advanceTimersByTimeAsync(15000);
    expect(f.calls('update_reserve')).toHaveLength(0);
    expect(f.get('update-status').textContent).toContain('account draft');
    input.value=beforeValue;input.checked=beforeChecked;
    await vi.advanceTimersByTimeAsync(15000);
    expect(f.calls('update_reserve')).toHaveLength(1);
    expect(f.calls('control_bot')).toEqual([]);
    expect(f.get('client-version').textContent).toBe('macOS · v0.2.27');
  });
});

it('opens the manual release through a fixed native command without gameplay commands',async()=>{
 const f=await fixture();await f.get('update-download').emit('click');expect(f.calls('update_open_release')).toEqual([['update_open_release']]);expect(f.calls('control_bot')).toEqual([]);
});
