import { afterEach, describe, expect, it, vi } from 'vitest';
import { BotEngine } from './engine';

const ipc = vi.hoisted(() => ({ featureSettled: true, macroDirty: false, clearMacro: vi.fn(), invoke: vi.fn(), listen: vi.fn(async (_name:string,_callback:(event:{payload:unknown})=>void) => () => {}) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: ipc.invoke, isTauri: () => true }));
vi.mock('@tauri-apps/api/event', () => ({ listen: ipc.listen }));
vi.mock('./feature-ui', async () => {
  const { DEFAULT_AUTOMATION } = await import('./settings');
  return { FeatureUi: class {
    private profile:string|null=null;
    private held=false;
    constructor(_host: HTMLElement, _hooks: unknown, mounts: { manualTools: HTMLElement }) {
      const group=document.createElement('details');group.className='manual-group';group.id='synthetic-manual-group';
      const title=document.createElement('summary');title.textContent='Synthetic manual tool';
      const action=document.createElement('button');action.id='synthetic-manual-action';group.append(title,action);mounts.manualTools.append(group);
    }

    selectedProfileId(){return this.profile;}
    restoreProfileSelection(id:string|null){this.profile=id;}
    write():void{}
    levelDifference(){return 1;}
    render(status:{refine?:{blocked?:boolean}}):void{this.held=status.refine?.blocked===true;}
    active(): boolean { return this.held; }
    serviceBlocked(): boolean { return false; }
    warpActivationReady(): boolean { return false; }
    settledForMaintenance(): boolean { return ipc.featureSettled; }
    hasUnsavedMacro(): boolean { return ipc.macroDirty; }
    clearMacro():void{ipc.clearMacro();}
    clearSocial():void{}
    clearMemo():void{}
    read() { return structuredClone(DEFAULT_AUTOMATION); }
    lock(): void {}
  }, validFeatureStatus: () => true };
});

// Exercise the actual main-window form callbacks with native IPC replaced.
// No browser, app data, real account or persistent frontend store is involved.
class Element {
  value = ''; checked = false; disabled = false; hidden = false; textContent = ''; placeholder = '';
  id = ''; className = ''; title = ''; dataset:Record<string,string>={}; style = { width: '', setProperty() {} }; width = 400; height = 400;
  attributes = new Map<string,string>(); children: Element[] = []; parentElement:Element|null=null;
  ownerDocument = { createElement: (tag:string) => new Element(this.elements,tag) };
  get tagName():string{return this.tag.toUpperCase();}
  classList = { toggle() {}, add() {}, remove() {} };
  listeners = new Map<string, Array<(event: { preventDefault(): void;target?:Element }) => unknown>>();
  markup = '';
  constructor(private readonly elements: Map<string, Element>, readonly tag='div') {}
  set innerHTML(html: string) {
    this.markup = html;
    for (const match of html.matchAll(/<(\w+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
      const node = new Element(this.elements,match[1]!); node.id = match[3]!;
      node.className=/\bclass="([^"]*)"/.exec(match[2]!)?.[1]??'';
      const pureNav=/data-client-navigation="([^"]*)"/.exec(match[2]!)?.[1];if(pureNav)node.dataset.clientNavigation=pureNav;
      for(const key of ['page','bot','inspector','navigation']){const value=new RegExp(`data-client-${key}-nav="([^"]*)"`).exec(match[2]!)?.[1];if(value)node.dataset[key==='page'?'clientPageNav':key==='bot'?'clientBotNav':key==='inspector'?'clientInspectorNav':'clientNavigation']=value;}
      node.checked = /\bchecked\b/.test(match[2]!); node.disabled = /\bdisabled\b/.test(match[2]!); node.hidden = /\bhidden\b/.test(match[2]!);
      node.value = /\bvalue="([^"]*)"/.exec(match[2]!)?.[1] ?? (node.id==='connection-mode'?'botOnly':match[1] === 'select' ? '0' : '');
      this.elements.set(node.id, node);
    }
  }
  append(...children:Element[]): void {for(const child of children){child.parentElement=this;this.children.push(child);if(child.id)this.elements.set(child.id,child);}}
  replaceChildren(...children:Element[]): void {this.children=[];this.append(...children);}
  get childElementCount():number{return this.children.length;}
  querySelector(selector:string):Element|null {
    if(selector==='main'||selector==='.client-toolbar'||selector==='.client-skip-link')return this.elements.get(selector)??null;
    if(selector==='summary')return this.children.find(node=>node.tag==='summary')??null;
    return selector.startsWith('#')?this.elements.get(selector.slice(1))??null:null;
  }
  querySelectorAll(selector:string):Element[] {
    if(selector.includes('button[data-client-page-nav]'))return [...this.elements.values()].filter(node=>node.dataset.clientPageNav||node.dataset.clientBotNav||node.dataset.clientInspectorNav||node.dataset.clientNavigation).concat(this.elements.get('client-manual-index')?.children??[]);
    if(selector.startsWith('details.manual-group'))return this.children.filter(node=>node.tag==='details'&&node.className.includes('manual-group'));
    if(selector==='input,select,button,textarea')return [...new Set(this.elements.values())].filter(node=>['input','select','button','textarea'].includes(node.tag)).concat(this.elements.get('client-manual-index')?.children??[]);
    return [];
  }
  setAttribute(name:string,value:string):void{this.attributes.set(name,value);}
  getBoundingClientRect(){return{height:160};}
  focus():void{} scrollIntoView():void{}

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
async function fixture(saved: { username: string; characterSlot: number; autoLogin: boolean;mode?:'botOnly'|'gameClient' } | null = null, readFails = false, savedForm:unknown=null) {
  const elements = new Map<string, Element>(), root = new Element(elements), main = new Element(elements,'main');
  elements.set('main',main);elements.set('.client-toolbar',new Element(elements,'header'));elements.set('.client-skip-link',new Element(elements,'a'));
  vi.useFakeTimers(); vi.stubGlobal('document', {
    querySelector: (selector: string) => selector === '#app' ? root : main,
    querySelectorAll:(selector:string)=>main.querySelectorAll(selector),
    getElementById: (id: string) => elements.get(id), createElement: (tag:string) => new Element(elements,tag),
  });
  ipc.featureSettled=true;ipc.macroDirty=false;ipc.clearMacro.mockClear();ipc.invoke.mockReset(); ipc.listen.mockClear();
  ipc.invoke.mockImplementation(async (command: string,args?:{document?:{revision:number}}) => {
    if(command==='current_form')return savedForm;
    if(command==='save_current_form')return args?.document?.revision;
    if(command==='update_status')return {version:'0.2.27',platform:'macos',phase:'current',message:'Current'};
    if (command === 'saved_login') { if (readFails) throw 'synthetic store failure'; return saved; }
    return undefined;
  });
  vi.resetModules(); await import('./main');
  for (let i = 0; i < 40; i++) await Promise.resolve();
  return { root, main, index:()=>elements.get('client-manual-index')!.children, get: (id: string) => elements.get(id)!, calls: (command: string) => ipc.invoke.mock.calls.filter(call => call[0] === command) };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const closeToken='11111111-1111-4111-8111-111111111111';
async function requestClose(token=closeToken):Promise<void> {
  const listener=ipc.listen.mock.calls.find(call=>call[0]==='settings-close-request');
  expect(listener).toBeDefined();
  listener![1]({payload:{token}});
  for(let i=0;i<50;i++)await Promise.resolve();
}
it('saves an immediate settings edit before acknowledging native Close, then restores it on reopen',async()=>{
  const f=await fixture();
  f.get('radius').value='17';await f.main.emit('input',f.get('radius'));
  expect(f.calls('save_current_form')).toHaveLength(1);
  await requestClose();
  const saved=(f.calls('save_current_form').at(-1)![1] as {document:unknown}).document;
  expect(saved).toMatchObject({settings:{radius:17}});
  expect(f.calls('settings_close_complete')).toEqual([['settings_close_complete',{token:closeToken,revision:2}]]);
  await requestClose();expect(f.calls('settings_close_complete')).toHaveLength(1);
  const commandOrder=ipc.invoke.mock.calls.map(c=>c[0]);
  expect(commandOrder.indexOf('settings_close_complete')).toBeGreaterThan(commandOrder.lastIndexOf('save_current_form'));
  const reopened=await fixture(null,false,saved);
  expect(reopened.get('radius').value).toBe('17');expect(reopened.calls('control_bot')).toEqual([]);
});

it('waits for an in-flight save, reflushes a late edit, and deduplicates Close while fencing the updater',async()=>{
  const f=await fixture();let release:()=>void=()=>{};
  const writing=new Promise<void>(resolve=>{release=resolve;});let first=true;
  ipc.invoke.mockImplementation(async(command:string,args?:{document:{revision:number}})=>{
    if(command==='save_current_form'){if(first){first=false;await writing;}return args!.document.revision;}
    if(command==='update_status')return {version:'0.2.27',platform:'macos',phase:'waiting',message:'Update ready'};
  });
  f.get('radius').value='17';await f.main.emit('input',f.get('radius'));await vi.advanceTimersByTimeAsync(300);
  await requestClose();await requestClose();
  expect(f.root).toHaveProperty('inert',true);expect(f.get('radius').disabled).toBe(true);
  expect(f.calls('settings_close_complete')).toEqual([]);
  // An edit already dispatched at the locking boundary must still be retained.
  f.get('radius').value='18';await f.main.emit('input',f.get('radius'));
  await vi.advanceTimersByTimeAsync(15_000);expect(f.calls('update_reserve')).toEqual([]);
  release();for(let i=0;i<80;i++)await Promise.resolve();
  expect(f.calls('save_current_form').at(-1)![1]).toMatchObject({document:{settings:{radius:18}}});
  expect(f.calls('settings_close_complete')).toEqual([['settings_close_complete',{token:closeToken,revision:3}]]);
  expect(f.root).toHaveProperty('inert',true);
});

it('registers before startup restoration and keeps its settings, profile and targets through Close/reopen',async()=>{
  const {DEFAULT_SETTINGS}=await import('./settings');let release:(value:unknown)=>void=()=>{};
  const saved={version:1,revision:12,selectedProfileId:'profile_one',settings:{...DEFAULT_SETTINGS,map:'prt_fild08',targets:[4000],radius:17,minHpPercent:60,loot:false,route_randomWalk:2,route_step:7,route_avoidWalls:false,route_randomWalk_maxRouteTime:120,attackRouteMaxPathDistance:25,attackMaxRouteTime:5}};
  const f=await fixture(null,false,new Promise(resolve=>{release=resolve;}));
  expect(ipc.invoke.mock.calls.findIndex(c=>c[0]==='settings_close_ready')).toBeLessThan(ipc.invoke.mock.calls.findIndex(c=>c[0]==='current_form'));
  await requestClose();expect(f.calls('save_current_form')).toEqual([]);expect(f.calls('settings_close_complete')).toEqual([]);
  release(saved);for(let i=0;i<80;i++)await Promise.resolve();
  const document=(f.calls('save_current_form').at(-1)![1] as {document:unknown}).document;
  expect(document).toMatchObject({selectedProfileId:saved.selectedProfileId,settings:saved.settings});
  expect(f.calls('settings_close_complete')).toHaveLength(1);
  const reopened=await fixture(null,false,document);
  for(const [id,value] of Object.entries({'radius':'17','min-hp':'60','random-walk':'2','route-step':'7','route-time':'120','attack-distance':'25','attack-time':'5'}))expect(reopened.get(id).value).toBe(value);
  expect(reopened.get('loot').checked).toBe(false);expect(reopened.get('avoid-walls').checked).toBe(false);
  expect(reopened.calls('save_current_form')[0]![1]).toMatchObject({document:{selectedProfileId:saved.selectedProfileId,settings:saved.settings}});
  expect(reopened.calls('control_bot')).toEqual([]);
});

it('lets Close wait for updater preflight and stops it before reserving an install lease',async()=>{
  const f=await fixture();let release:()=>void=()=>{};let first=true;
  const saving=new Promise<void>(resolve=>{release=resolve;});
  ipc.invoke.mockImplementation(async(command:string,args?:{document:{revision:number}})=>{
    if(command==='update_status')return {version:'0.2.27',platform:'macos',phase:'waiting',message:'Update ready'};
    if(command==='save_current_form'){if(first){first=false;await saving;}return args!.document.revision;}
  });
  await vi.advanceTimersByTimeAsync(15_000);await requestClose();
  expect(f.calls('settings_close_complete')).toEqual([]);
  release();for(let i=0;i<80;i++)await Promise.resolve();
  expect(f.calls('update_reserve')).toEqual([]);expect(f.calls('update_install')).toEqual([]);
  expect(f.calls('settings_close_cancel')).toEqual([]);expect(f.calls('settings_close_complete')).toHaveLength(1);
});

it('retries failed startup restoration on Close after storage recovers while retaining subsequent edits',async()=>{
  const {DEFAULT_SETTINGS}=await import('./settings');let fail:(reason:unknown)=>void=()=>{};
  const f=await fixture(null,false,new Promise((_resolve,reject)=>{fail=reject;}));
  fail(new Error('Synthetic read failure'));for(let i=0;i<40;i++)await Promise.resolve();
  expect(f.calls('save_current_form')).toEqual([]);
  f.get('radius').value='18';await f.main.emit('input',f.get('radius'));
  ipc.invoke.mockImplementation(async(command:string,args?:{document:{revision:number}})=>{
    if(command==='current_form')return {version:1,revision:12,selectedProfileId:null,settings:{...DEFAULT_SETTINGS,radius:13}};
    if(command==='save_current_form')return args!.document.revision;
  });
  await requestClose();
  expect(f.get('radius').value).toBe('18');expect(f.calls('current_form')).toHaveLength(2);
  expect(f.calls('save_current_form').at(-1)![1]).toMatchObject({document:{settings:{radius:18}}});
  expect(f.calls('settings_close_complete')).toEqual([['settings_close_complete',{token:closeToken,revision:13}]]);
});

it('cancels Close after an invalid draft or failed save, unlocks editing, and permits a corrected retry',async()=>{
  const f=await fixture();f.get('radius').value='99';await f.main.emit('input',f.get('radius'));
  await requestClose();expect(f.calls('save_current_form')).toHaveLength(1);
  expect(f.calls('settings_close_complete')).toEqual([]);expect(f.calls('settings_close_cancel')).toHaveLength(1);
  expect(f.root).toHaveProperty('inert',false);expect(f.get('radius').disabled).toBe(false);
  expect(f.get('update-status').textContent).toContain('Close cancelled');
  expect(f.get('notice').textContent).toContain('Close cancelled');
  const publish=ipc.listen.mock.calls.find(call=>call[0]==='game-status')![1];
  publish({payload:new BotEngine(()=>{}).snapshot()});
  expect(f.get('notice').textContent).toContain('Close cancelled');
  f.get('radius').value='18';await f.main.emit('input',f.get('radius'));
  ipc.invoke.mockImplementation(async(command:string,args?:{document:{revision:number}})=>{
    if(command==='save_current_form')throw new Error('Synthetic write failure');
    return args?.document?.revision;
  });
  await requestClose();expect(f.calls('settings_close_complete')).toEqual([]);expect(f.calls('settings_close_cancel')).toHaveLength(2);
  ipc.invoke.mockImplementation(async(command:string,args?:{document:{revision:number}})=>command==='save_current_form'?args!.document.revision:undefined);
  const retryToken='22222222-2222-4222-8222-222222222222';await requestClose(retryToken);
  expect(f.calls('settings_close_complete')).toEqual([['settings_close_complete',{token:retryToken,revision:2}]]);
});

describe('native local-login form and metadata', () => {
  it('starts session-only and discloses unencrypted local storage without accessing frontend persistence', async () => {
    const f = await fixture();
    expect(f.root.markup).toContain('Save login on this computer');
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
      characterSlot: 2, remember: false, autoLogin: false, mode:'botOnly',
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
    expect(f.calls('login_game')).toEqual([['login_game', { request: { credentials: null, characterSlot: 1, remember: true, autoLogin: false, mode:'gameClient' } }]]);
  });
  it('auto-login uses native reuse and the saved slot without returning a password to the form', async () => {
    const f = await fixture({ username: 'synthetic-user', characterSlot: 2, autoLogin: true });
    expect(f.calls('login_game')).toEqual([['login_game', { request: { credentials: null, characterSlot: 2, remember: true, autoLogin: true, mode:'gameClient' } }]]);
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
  it.each(['password','username','character-slot','connection-mode','remember-login','auto-login'])('defers installation for %s, then permits it after restoring the baseline',async(id)=>{
    const f=await fixture();
    const input=f.get(id),beforeValue=input.value,beforeChecked=input.checked;
    if(id.endsWith('-login'))input.checked=true;
    else input.value=id==='character-slot'?'1':'synthetic-unsent';
    ipc.invoke.mockImplementation(async(command:string,args?:{document:{revision:number}})=>{
      if(command==='update_status')return {version:'0.2.27',platform:'macos',phase:'waiting',message:'Update ready'};
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

it('defers the actual main updater while a refine preview or retained economic owner is unsettled',async()=>{
 const f=await fixture();ipc.featureSettled=false;
 ipc.invoke.mockImplementation(async(command:string,args?:{document:{revision:number}})=>{
  if(command==='update_status')return {version:'0.2.27',platform:'macos',phase:'waiting',message:'Update ready'};
  if(command==='save_current_form')return args!.document.revision;
  if(command==='update_reserve')return 'b'.repeat(32);
  if(command==='update_install')return true;
 });
 await vi.advanceTimersByTimeAsync(15000);expect(f.calls('update_reserve')).toEqual([]);expect(f.calls('update_install')).toEqual([]);
 expect(f.get('update-status').textContent).toBe('Update waits for pending game actions or previews to finish.');
 ipc.featureSettled=true;await vi.advanceTimersByTimeAsync(15000);expect(f.calls('update_reserve')).toHaveLength(1);expect(f.calls('control_bot')).toEqual([]);
});

it('defers the actual main updater for an unsaved macro and permits installation once the document is saved',async()=>{
 const f=await fixture();ipc.macroDirty=true;
 ipc.invoke.mockImplementation(async(command:string,args?:{document:{revision:number}})=>{
  if(command==='update_status')return {version:'0.2.27',platform:'macos',phase:'waiting',message:'Update ready'};
  if(command==='save_current_form')return args!.document.revision;
  if(command==='update_reserve')return 'd'.repeat(32);
  if(command==='update_install')return true;
 });
 await vi.advanceTimersByTimeAsync(15000);
 expect(f.calls('update_reserve')).toEqual([]);expect(f.calls('update_install')).toEqual([]);
 expect(f.get('update-status').textContent).toBe('Update waits for your macro draft. Save or clear it first.');
 ipc.macroDirty=false;await vi.advanceTimersByTimeAsync(15000);
 expect(f.calls('update_reserve')).toHaveLength(1);expect(f.calls('update_install')).toEqual([['update_install',{nonce:'d'.repeat(32)}]]);
 expect(f.calls('control_bot')).toEqual([]);
});

describe('updater waiting diagnostics',()=>{
 it('explains a running bot without reserving an update or sending Stop',async()=>{
  const f=await fixture(),base=new BotEngine(()=>{}).snapshot();
  const publish=ipc.listen.mock.calls.find(call=>call[0]==='game-status')![1];
  publish({payload:{...base,sessionId:'synthetic-running',running:true,connected:true,compatible:true,
   login:{phase:'idle',message:''},reconnectAvailable:false,
   player:{id:0,classId:4,kind:0,name:'Synthetic',level:30,hp:100,maxHp:100,x:1,y:1,dead:false,statuses:[]},
   mapInfo:{code:'',name:'',source:'observed',monsters:[]}}});
  ipc.invoke.mockImplementation(async(command:string)=>{
   if(command==='update_status')return {version:'0.2.27',platform:'macos',phase:'waiting',message:'Update ready'};
  });
  await vi.advanceTimersByTimeAsync(15000);
  expect(f.get('update-status').textContent).toBe('Update waits for automation to stop.');
  expect(f.calls('update_reserve')).toEqual([]);expect(f.calls('update_install')).toEqual([]);
  expect(f.calls('control_bot').every(call=>(call[1] as {action:string}).action==='heartbeat')).toBe(true);
 });
 it('shows save, connection preparation and missing game confirmation without changing retries or release',async()=>{
  const f=await fixture();let saved!:()=>void,prepared!:(nonce:string)=>void;
  const saving=new Promise<void>(resolve=>{saved=resolve;}),preparing=new Promise<string>(resolve=>{prepared=resolve;});
  ipc.invoke.mockImplementation(async(command:string,args?:{document:{revision:number}})=>{
   if(command==='update_status')return {version:'0.2.27',platform:'macos',phase:'waiting',message:'Update ready'};
   if(command==='save_current_form'){await saving;return args!.document.revision;}
   if(command==='update_reserve')return preparing;
   if(command==='update_install')return false;
  });
  await vi.advanceTimersByTimeAsync(15000);
  expect(f.get('update-status').textContent).toBe('Saving current settings before updating.');
  expect(f.calls('update_reserve')).toEqual([]);
  saved();for(let i=0;i<40;i++)await Promise.resolve();
  expect(f.get('update-status').textContent).toBe('Preparing the connection for update confirmation.');
  expect(f.calls('update_install')).toEqual([]);
  const nonce='e'.repeat(32);prepared(nonce);for(let i=0;i<40;i++)await Promise.resolve();
  expect(f.get('update-status').textContent).toContain('game confirmation');
  await vi.advanceTimersByTimeAsync(2100);
  expect(f.calls('update_install')).toHaveLength(20);
  expect(f.calls('update_release')).toEqual([['update_release',{nonce}]]);
  expect(f.get('update-status').textContent).toBe('Update waits for game confirmation that all actions have stopped. It will retry automatically.');
  expect(f.get('update-status').textContent).not.toContain(nonce);
  expect(f.calls('control_bot')).toEqual([]);
  expect(f.get('radius').disabled).toBe(false);
 });
 it.each([
  ['Waiting for a fresh stopped client before updating.','The connection has not confirmed a fresh stopped state.'],
  ['Waiting for login to settle.','Sign-in has not finished.'],
  ['synthetic-private-account-path','The connection could not be prepared for update confirmation.'],
  [new Error('synthetic-private-account-path'),'The connection could not be prepared for update confirmation.'],
  ['toString','The connection could not be prepared for update confirmation.'],
 ])('reports bounded reserve diagnostics for %s',async(error,reason)=>{
  const f=await fixture();
  ipc.invoke.mockImplementation(async(command:string,args?:{document:{revision:number}})=>{
   if(command==='update_status')return {version:'0.2.27',platform:'macos',phase:'waiting',message:'Update ready'};
   if(command==='save_current_form')return args!.document.revision;
   if(command==='update_reserve')throw error;
  });
  await vi.advanceTimersByTimeAsync(15000);
  expect(f.calls('update_reserve')).toHaveLength(1);expect(f.calls('update_install')).toEqual([]);
  expect(f.get('update-status').textContent).toBe(`Update deferred. ${reason} It will retry automatically.`);
  expect(f.get('update-status').textContent).not.toContain('synthetic-private-account-path');
  expect(f.calls('control_bot')).toEqual([]);
 });
 it('identifies an invalid settings form before connection preparation',async()=>{
  const f=await fixture();f.get('radius').value='99';await f.main.emit('input',f.get('radius'));
  ipc.invoke.mockImplementation(async(command:string)=>{
   if(command==='update_status')return {version:'0.2.27',platform:'macos',phase:'waiting',message:'Update ready'};
  });
  await vi.advanceTimersByTimeAsync(15000);
  expect(f.get('update-status').textContent).toBe('Update deferred. Current settings could not be saved. Check the settings form. It will retry automatically.');
  expect(f.calls('update_reserve')).toEqual([]);expect(f.calls('update_install')).toEqual([]);
 });
 it('reports changed game confirmation and releases its reservation',async()=>{
  const f=await fixture(),nonce='f'.repeat(32);
  ipc.invoke.mockImplementation(async(command:string,args?:{document:{revision:number}})=>{
   if(command==='update_status')return {version:'0.2.27',platform:'macos',phase:'waiting',message:'Update ready'};
   if(command==='save_current_form')return args!.document.revision;
   if(command==='update_reserve')return nonce;
   if(command==='update_install')throw 'Update settlement changed.';
  });
  await vi.advanceTimersByTimeAsync(15000);
  expect(f.get('update-status').textContent).toBe('Update deferred. Game activity changed during update confirmation. It will retry automatically.');
  expect(f.calls('update_release')).toEqual([['update_release',{nonce}]]);
  expect(f.calls('control_bot')).toEqual([]);
 });
});

it('keeps shell navigation usable through a deferred installation without unlocking actions',async()=>{
 const f=await fixture();let rejectInstall:((error:Error)=>void)|undefined;
 ipc.invoke.mockImplementation(async(command:string,args?:{document:{revision:number}})=>{
  if(command==='update_status')return {version:'0.2.27',platform:'macos',phase:'waiting',message:'Update ready'};
  if(command==='save_current_form')return args!.document.revision;
  if(command==='update_reserve')return 'c'.repeat(32);
  if(command==='update_install')return new Promise((_resolve,reject)=>{rejectInstall=reject;});
 });
 await vi.advanceTimersByTimeAsync(15000);
 expect(f.calls('update_install')).toHaveLength(1);
 const tabs=['session','bot','manual','settings'].map(page=>f.get(`client-tab-${page}`));
 const botTabs=['combat','recovery','travel','inventory','workflows'].map(section=>f.get(`client-bot-tab-${section}`));
 const consoleNavigation=['console-tab-nearby','console-tab-inventory','console-edit-setup','console-loot-settings','console-item-tools','open'].map(id=>f.get(id));
 expect([...tabs,...botTabs,...consoleNavigation,...f.index()].every(button=>!button.disabled)).toBe(true);
 expect(f.get('start').disabled).toBe(true);expect(f.get('open').disabled).toBe(false);expect(f.get('synthetic-manual-action').disabled).toBe(true);
 expect(f.get('console-walk').disabled).toBe(true);expect(f.get('console-use-item').disabled).toBe(true);expect(f.get('disconnect').disabled).toBe(true);
 const saves=f.calls('save_current_form').length;
 f.get('console-item').value='501';f.get('console-walk-x').value='123';
 await f.get('console-tab-inventory').emit('click');expect(f.get('console-panel-inventory').hidden).toBe(false);
 await f.get('console-tab-nearby').emit('click');await f.get('console-edit-setup').emit('click');expect(f.get('client-page-bot').hidden).toBe(false);
 await f.get('open').emit('click');expect(f.get('client-page-settings').hidden).toBe(false);
 expect(f.get('console-item').value).toBe('501');expect(f.get('console-walk-x').value).toBe('123');
 await f.get('client-tab-settings').emit('click');expect(f.get('client-page-settings').hidden).toBe(false);
 await f.index()[0]!.emit('click');expect(f.get('client-page-manual').hidden).toBe(false);
 expect(f.calls('control_bot')).toEqual([]);expect(f.calls('save_current_form')).toHaveLength(saves);
 rejectInstall!(new Error('Synthetic install interruption'));for(let i=0;i<20;i++)await Promise.resolve();
 expect(f.calls('update_release')).toHaveLength(1);
 expect([...tabs,...botTabs,...f.index()].every(button=>!button.disabled)).toBe(true);
 expect(f.get('start').disabled).toBe(true);expect(f.get('synthetic-manual-action').disabled).toBe(true);
});

it('renders the fresh held owner before toolbar status and binds observed session readouts',async()=>{
 const f=await fixture();const publish=ipc.listen.mock.calls.find(call=>call[0]==='game-status')![1];
 const base=new BotEngine(()=>{}).snapshot();
 const status={...base,sessionId:'synthetic-session',login:{phase:'idle',message:''},reconnectAvailable:false,connected:true,compatible:true,
  player:{id:0,classId:4,kind:0,name:'Synthetic',level:30,hp:100,maxHp:100,x:1,y:1,dead:false,statuses:[]},
  character:{...base.character,stats:{sp:75,maxSp:200}},deaths:2,reason:'Stopped by you.',
  mapInfo:{code:'',name:'',source:'observed',monsters:[]},refine:{blocked:true,reason:'Waiting for the exact refine transaction.'}};
 const saves=f.calls('save_current_form').length;
 publish({payload:status});
 expect(f.get('status').textContent).toBe('WAITING');expect(f.get('notice').textContent).toBe(status.refine.reason);
 expect(f.get('client-run-title').textContent).toBe('Waiting to continue');
 expect(f.get('sp-text').textContent).toBe('75 / 200');expect(f.get('sp-bar').style.width).toBe('37.5%');expect(f.get('death-count').textContent).toBe('2');
 await f.get('client-tab-settings').emit('click');expect(f.get('notice').textContent).toBe(status.refine.reason);
 expect(f.calls('save_current_form')).toHaveLength(saves);expect(f.calls('control_bot')).toEqual([]);
 publish({payload:{...status,character:{...base.character,stats:null},refine:{blocked:false}}});
 expect(f.get('status').textContent).toBe('READY');expect(f.get('sp-text').textContent).toBe('— / —');expect(f.get('sp-bar').style.width).toBe('0%');
});

it('Connect account opens the retained account form without creating or showing a game window',async()=>{
 const f=await fixture();await f.get('open').emit('click');
 expect(f.get('client-page-settings').hidden).toBe(false);
 expect(f.calls('open_game')).toEqual([]);expect(f.calls('login_game')).toEqual([]);expect(f.calls('control_bot')).toEqual([]);
});

it('requires settled, fresh stopped state for explicit Disconnect and clears telemetry for a new login',async()=>{
 const f=await fixture(),publish=ipc.listen.mock.calls.find(call=>call[0]==='game-status')![1];
 const base=new BotEngine(()=>{}).snapshot();
 const status={...base,sessionId:'synthetic-session',login:{phase:'idle',message:''},reconnectAvailable:false,connected:true,compatible:true,
  player:{id:0,classId:4,kind:0,name:'Synthetic',level:30,hp:100,maxHp:100,x:1,y:1,dead:false,statuses:[]},
  character:{...base.character,stats:{sp:75,maxSp:200}},mapInfo:{code:'',name:'',source:'observed',monsters:[]}};
 publish({payload:{...status,runRequested:true}});expect(f.get('connection-mode').disabled).toBe(true);expect(f.get('disconnect').disabled).toBe(true);await f.get('disconnect').emit('click');expect(f.calls('close_game')).toEqual([]);
 publish({payload:{...status,refine:{blocked:true,reason:'Pending receipt'}}});expect(f.get('disconnect').disabled).toBe(true);await f.get('disconnect').emit('click');expect(f.calls('close_game')).toEqual([]);
 publish({payload:status});ipc.featureSettled=false;await vi.advanceTimersByTimeAsync(1000);expect(f.get('disconnect').disabled).toBe(true);
 ipc.featureSettled=true;publish({payload:status});expect(f.get('disconnect').disabled).toBe(false);
 let finish!:()=>void;ipc.invoke.mockImplementation((command:string)=>command==='close_game'?new Promise<void>(resolve=>{finish=resolve;}):Promise.resolve(undefined));
 await f.get('disconnect').emit('click');expect(f.calls('close_game')).toEqual([['close_game']]);expect(f.get('disconnect').disabled).toBe(true);expect(f.get('console-walk').disabled).toBe(true);finish();
 const closed=ipc.listen.mock.calls.find(call=>call[0]==='game-closed')![1];closed({payload:undefined});
 expect(ipc.clearMacro).toHaveBeenCalledOnce();
 for(let i=0;i<20;i++)await Promise.resolve();
 expect(f.get('connection-mode').disabled).toBe(false);expect(f.get('character').textContent).toBe('No character connected');expect(f.get('hp-text').textContent).toBe('— / —');expect(f.get('console-weight').textContent).toBe('— / —');expect(f.get('signin').disabled).toBe(false);expect(f.calls('login_game')).toEqual([]);
 expect(f.get('character').title).toBe('No character connected');expect(f.get('location').title).toBe('Connect an account to load your character.');
});

it('refreshes console locks for stale status and unsettled owners',async()=>{
 const f=await fixture(),publish=ipc.listen.mock.calls.find(call=>call[0]==='game-status')![1],base=new BotEngine(()=>{}).snapshot();
 const status={...base,sessionId:'synthetic-session',login:{phase:'idle',message:''},reconnectAvailable:false,connected:true,compatible:true,
  player:{id:0,classId:4,kind:0,name:'Synthetic',level:30,hp:100,maxHp:100,x:1,y:1,dead:false,statuses:[]},
  character:{...base.character,inventoryKnown:true,inventory:[{itemId:501,bagId:501,type:1,count:3}]},mapInfo:{code:'',name:'',source:'observed',monsters:[]}};
 publish({payload:status});f.get('console-item').value='501';await f.get('console-item').emit('change');expect(f.get('console-use-item').disabled).toBe(false);
 await vi.advanceTimersByTimeAsync(8000);expect(f.get('console-use-item').disabled).toBe(true);expect(f.get('disconnect').disabled).toBe(true);
 expect(f.get('client-run-title').textContent).toBe('Waiting for fresh game status');expect(f.get('start').disabled).toBe(true);
 publish({payload:status});expect(f.get('console-use-item').disabled).toBe(false);
 ipc.featureSettled=false;publish({payload:status});expect(f.get('console-use-item').disabled).toBe(true);
 ipc.featureSettled=true;publish({payload:status});expect(f.get('console-use-item').disabled).toBe(false);
});

it('restores explicit Bot only mode before automatic native saved-profile reuse',async()=>{
 const f=await fixture({username:'synthetic-user',characterSlot:1,autoLogin:true,mode:'botOnly'});
 expect(f.get('connection-mode').value).toBe('botOnly');expect(f.calls('login_game')).toEqual([['login_game',{request:{credentials:null,characterSlot:1,remember:true,autoLogin:true,mode:'botOnly'}}]]);
 expect(f.get('connection-mode').disabled).toBe(true);expect(f.get('password').value).toBe('');
});
it('a mode draft emits no login or settings save and legacy saved profiles retain game client mode',async()=>{
 const f=await fixture({username:'synthetic-user',characterSlot:0,autoLogin:false});expect(f.get('connection-mode').value).toBe('gameClient');
 const before=f.calls('save_current_form').length;f.get('connection-mode').value='botOnly';await f.get('connection-mode').emit('change');
 expect(f.calls('login_game')).toEqual([]);expect(f.calls('save_current_form')).toHaveLength(before);
 await f.get('signin-form').emit('submit');expect(f.calls('login_game')[0]?.[1]).toMatchObject({request:{mode:'botOnly'}});expect(f.get('connection-mode').disabled).toBe(true);
});
