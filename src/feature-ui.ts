import { DEFAULT_AUTOMATION, validateAutomation, type AutomationSettings, type Settings } from './settings';
import { MAX_PROFILES, ProfileStore } from './profiles';
import { ITEM_CATALOG, SKILL_CATALOG, itemName, skillName } from './game-catalog';
import { validateExpandedAction } from './protocol-feature';
import { validateWorldAction } from './world-protocol';
import { validateWorkflowSpec } from './workflows';
import { dryRunRoutine, validateRoutineSpec, type RoutineObservation } from './routines';
import { DEFAULT_DISPOSITION, dispositionPreviewIsCurrent, planDisposition, type DispositionPlan } from './disposition';
import { dispositionContextFromStatus, dispositionPreviewText, dispositionStockFloors } from './disposition-ui';

type Section = 'combat' | 'recovery' | 'travel' | 'inventory' | 'workflows' | 'profiles';
interface Hooks {
  settings(): Settings; apply(settings: Settings): void; map(): string; character(): string;
  command(action: Record<string, unknown>): Promise<unknown>;
  workflow(spec: unknown): Promise<unknown>; routine(spec: unknown): Promise<unknown>;
  notify(text: string, error?: boolean): void; changed(): void;
}
type Field = { path: string; label: string; kind?: 'text' | 'checkbox'; min?: number; max?: number; options?: Array<[string,string]> };
type Column = { key: string; label: string; kind?: 'text'; min?: number; max?: number; options?: Array<[string,string]> };
type Row = Record<string, string | number>;
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const text = (v: unknown): string => typeof v === 'string' ? v : '';
const number = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;
function checkedAction(input: unknown): Record<string, unknown> {
  if (['sit','useItem','skill','equip','respawn','allocateSkill','allocateStats'].includes(text(object(input).type))) {
    return validateExpandedAction(input) as unknown as Record<string,unknown>;
  }
  return validateWorldAction(input) as unknown as Record<string,unknown>;
}
function isAction(input: unknown): input is Record<string,unknown> { try { checkedAction(input); return true; } catch { return false; } }
const fields: Record<Section, Field[]> = {
  combat: [
    { path:'combat.mode', label:'Combat mode', options:[['selected','Selected monsters'],['retaliate','Retaliate only'],['both','Selected + retaliation'],['off','Combat off']] },
    { path:'combat.levelDifference', label:'Maximum levels above you', min:-100, max:100 },
  ],
  recovery: [
    { path:'recovery.enabled', label:'Sit to recover HP and SP', kind:'checkbox' },
    { path:'recovery.hpStart', label:'Rest below HP %', min:1,max:95 }, { path:'recovery.hpEnd',label:'Resume above HP %',min:2,max:100 },
    { path:'recovery.spStart',label:'Rest below SP %',min:0,max:95 }, { path:'recovery.spEnd',label:'Resume above SP %',min:1,max:100 },
    { path:'recovery.timeoutSeconds',label:'Maximum rest seconds',min:1,max:3600 },
    { path:'escape.enabled',label:'Emergency escape at low HP',kind:'checkbox' },
    { path:'escape.hpBelowPercent',label:'Escape at or below HP %',min:1,max:95 },
    { path:'escape.mode',label:'Escape destination',options:[['random','Random location on current map'],['save','Return to save point']] },
    { path:'escape.method',label:'Escape action',options:[['item','Fly Wing / Butterfly Wing'],['skill','Teleport / Return skill']] },
    { path:'escape.minStock',label:'Wings to keep in reserve',min:0,max:9999 },
    { path:'escape.cooldownSeconds',label:'Minimum escape interval, seconds',min:1,max:3600 },
    { path:'respawn.enabled',label:'Respawn after death',kind:'checkbox' }, { path:'respawn.maxDeaths',label:'Wait after deaths',min:1,max:100 },
  ],
  travel: [
    { path:'travel.destinationMap',label:'Destination map code',kind:'text' }, { path:'travel.returnToLockMap',label:'Return to start map after respawn or escape',kind:'checkbox' },
    { path:'travel.loop',label:'Repeat waypoint route',kind:'checkbox' },
    { path:'follow.name',label:'Follow player name',kind:'text' }, { path:'follow.distance',label:'Follow distance, cells',min:1,max:20 },
    { path:'follow.lostSeconds',label:'Wait when player lost, seconds',min:1,max:120 },
  ],
  inventory: [
    { path:'loot.ownership',label:'Pickup ownership',options:[['own','Drops from your kills'],['all','All available drops']] },
    { path:'loot.defaultAction',label:'Unlisted item rule',options:[['pickup','Pick up'],['ignore','Ignore']] },
  ],
  workflows: [
    { path:'limits.minutes',label:'Session minutes · 0 unlimited',min:0,max:1440 }, { path:'limits.kills',label:'Kills · 0 unlimited',min:0,max:1000000 },
    { path:'limits.pickups',label:'Pickups · 0 unlimited',min:0,max:1000000 }, { path:'limits.weightPercent',label:'Wait at weight % · 0 off',min:0,max:100 },
    { path:'schedule.enabled',label:'Restrict running hours',kind:'checkbox' }, { path:'schedule.startHour',label:'Start hour · local time',min:0,max:23 },
    { path:'schedule.endHour',label:'End hour · local time',min:0,max:23 },
  ], profiles: [],
};
function fieldElement(field: Field): HTMLLabelElement {
  const label = document.createElement('label'); label.className = field.kind === 'checkbox' ? 'toggle-row' : 'form-field';
  const title = document.createElement('span'); title.textContent = field.label; label.append(title);
  let input: HTMLInputElement | HTMLSelectElement;
  if (field.options) {
    input = document.createElement('select');
    for (const [value, title] of field.options) { const option = document.createElement('option'); option.value = value; option.textContent = title; input.append(option); }
  } else {
    input = document.createElement('input'); input.type = field.kind ?? 'number';
    if (field.min !== undefined) input.min = String(field.min); if (field.max !== undefined) input.max = String(field.max);
    if (field.kind === 'text') input.maxLength = field.path === 'follow.name' ? 48 : 64;
  }
  input.dataset.setting = field.path; label.append(input); return label;
}
function getPath(value: unknown, path: string): unknown { return path.split('.').reduce<unknown>((v, key) => object(v)[key],value); }
function setPath(value: Record<string, unknown>, path: string, input: unknown): void {
  const keys = path.split('.'); const key = keys.pop()!;
  const owner = keys.reduce((v, name) => object(v[name]),value); owner[key] = input;
}
class RuleEditor {
  readonly root = document.createElement('details'); private readonly rows = document.createElement('div');
  private readonly add = document.createElement('button'); private locked = false;
  constructor(title: string, private readonly columns: Column[], private readonly initial: Row, private readonly maximum: number, changed: () => void) {
    this.root.className = 'rule-editor';
    const summary = document.createElement('summary'); summary.textContent = title; this.root.append(summary,this.rows);
    this.add.type = 'button'; this.add.className = 'secondary compact'; this.add.textContent = '＋ Add rule';
    this.add.addEventListener('click', () => { const rows = this.read(); if (rows.length < maximum) this.write([...rows,{...initial}]); changed(); });
    this.root.addEventListener('input',changed); this.root.append(this.add); this.write([]);
  }
  read(): Row[] {
    return [...this.rows.children].map(row => Object.fromEntries(this.columns.map(column => {
      const input = row.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-column="${column.key}"]`)!;
      return [column.key,column.kind === 'text' || column.options ? input.value : Number(input.value)];
    })));
  }
  write(values: Row[]): void {
    this.rows.replaceChildren();
    for (const value of values) {
      const row = document.createElement('div'); row.className = 'rule-row';
      for (const column of this.columns) {
        const label = fieldElement({ path:column.key,label:column.label,kind:column.kind,min:column.min,max:column.max,options:column.options });
        const input = label.querySelector<HTMLInputElement | HTMLSelectElement>('input,select')!; delete input.dataset.setting;
        input.dataset.column = column.key; input.value = String(value[column.key] ?? this.initial[column.key] ?? '');
        if (input instanceof HTMLInputElement && ['itemId','skillId','classId'].includes(column.key)) input.setAttribute('list',`${column.key}-catalog`);
        row.append(label);
      }
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'text-button rule-remove'; remove.textContent = 'Remove';
      remove.addEventListener('click', () => { row.remove(); this.add.disabled = this.locked || this.rows.childElementCount >= this.maximum; this.root.dispatchEvent(new Event('input',{bubbles:true})); });
      row.append(remove); this.rows.append(row);
    }
    this.lock(this.locked);
  }
  lock(locked: boolean): void { this.locked = locked; for (const input of this.root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button')) input.disabled = locked; this.add.disabled = locked || this.rows.childElementCount >= this.maximum; }
}
const idColumn = (key: string, label: string, max = 2147483647): Column => ({key,label,min:1,max});
const priority: Column = {key:'priority',label:'Priority',min:-100,max:100};
const countColumn: Column = {key:'count',label:'Quantity',min:1,max:9999};

// Bounded telemetry is treated as data. A new packet field cannot inject HTML or
// make a native status event grow an unbounded tree in the controller.
export function validFeatureStatus(value: Record<string, unknown>): boolean {
  let remaining = 100_000;
  function bounded(v: unknown, depth: number): boolean {
    if (--remaining < 0 || depth > 10) return false;
    if (v === null || typeof v === 'boolean') return true;
    if (typeof v === 'number') return Number.isFinite(v);
    if (typeof v === 'string') return v.length <= 8192;
    if (Array.isArray(v)) return v.length <= 2048 && v.every(entry => bounded(entry,depth+1));
    if (v && typeof v === 'object') return Object.keys(v).length <= 256 && Object.values(v).every(entry => bounded(entry,depth+1));
    return false;
  }
  if (!['character','world','workflow','routine','task','actionResult','travel','escape','elapsedSeconds','deaths','lootStats','actors'].every(key => value[key] === undefined || bounded(value[key],0))) return false;
  const barter = object(value.world).barter;
  return barter === undefined || Array.isArray(barter) && barter.every(entry => {
    const row = object(entry);
    return Number.isInteger(object(row.item).itemId) && Array.isArray(row.required)
      && row.required.every(required => Number.isInteger(object(required).itemId) && Number.isInteger(object(required).count));
  });
}

export class FeatureUi {
  private readonly panels = new Map<Section, HTMLElement>(); private readonly editors = new Map<string,RuleEditor>();
  private readonly profiles: ProfileStore; private locked = false; private manualLocked = true;
  private status: Record<string, unknown> = {};
  private dispositionEditor!: RuleEditor;
  private dispositionPlan: DispositionPlan | null = null;
  constructor(private readonly host: HTMLElement, private readonly hooks: Hooks) {
    let storage: Pick<Storage,'getItem'|'setItem'>;
    try { storage = localStorage; } catch { storage = {getItem:()=>null,setItem:()=>{throw new Error('Profile storage is unavailable.');}}; }
    this.profiles = new ProfileStore(storage);
    const combat = host.querySelector<HTMLElement>('.settings')!; combat.dataset.section = 'combat'; this.panels.set('combat',combat);
    for (const [id,title] of [['recovery','Recovery'],['travel','Travel & follow'],['inventory','Inventory & skills'],['workflows','Workflows & social'],['profiles','Profiles & features']] as Array<[Section,string]>) {
      const panel = document.createElement('section'); panel.className = 'panel settings feature-panel'; panel.dataset.section = id; panel.hidden = true;
      const heading = document.createElement('div'); heading.className = 'panel-title'; const h2 = document.createElement('h2'); h2.textContent = title; heading.append(h2); panel.append(heading);
      combat.parentElement!.insertBefore(panel,host.querySelector('.activity')); this.panels.set(id,panel);
    }
    for (const [section, definitions] of Object.entries(fields) as Array<[Section,Field[]]>) {
      const grid = document.createElement('div'); grid.className = 'form-grid'; for (const field of definitions) grid.append(fieldElement(field)); this.panels.get(section)!.append(grid);
    }
    const travel = this.panels.get('travel')!;
    travel.prepend(combat.querySelector('.routing-field')!,combat.querySelector('.routing-settings')!);
    const recovery = this.panels.get('recovery')!; recovery.append(combat.querySelector('#min-hp')!.previousElementSibling!,combat.querySelector('#min-hp')!);
    this.panels.get('inventory')!.prepend(combat.querySelector('label[for="loot"]')!);
    const actions = combat.querySelector('.actions')!; actions.classList.add('run-controls'); host.insertBefore(actions,host.querySelector('footer'));
    const sessionDetails=document.createElement('p');sessionDetails.id='session-details';sessionDetails.className='session-details';sessionDetails.textContent='Session time, experience and task state appear after connection.';host.querySelector('.session-card')!.append(sessionDetails);
    const footnote = combat.querySelector('.footnote')!; footnote.textContent = 'Game input yields briefly. Temporary interruptions wait and resume; Stop cancels the run. Profiles never start automation.'; actions.append(footnote);
    combat.querySelector('.routing-settings .hint')?.remove();
    this.rules(); this.workflows(); this.profilePanel(); this.navigation();
    this.dispositionPanel();
    for (const [id,catalog] of [['itemId',ITEM_CATALOG],['skillId',SKILL_CATALOG]] as const) {
      const list=document.createElement('datalist');list.id=`${id}-catalog`;
      for(const [value,entry]of Object.entries(catalog)){const option=document.createElement('option');option.value=value;option.label=entry.name;list.append(option);}this.host.append(list);
    }
    this.host.addEventListener('input',event => { if ((event.target as HTMLElement).dataset.setting) this.hooks.changed(); });
    this.write(DEFAULT_AUTOMATION);
  }
  private panel(section: Section): HTMLElement { return this.panels.get(section)!; }
  private dispositionPanel(): void {
    const panel = this.panel('inventory');
    const binary: Array<[string,string]> = [['0','Preserve'],['1','Allow']];
    this.dispositionEditor = new RuleEditor('Protected stock & disposition preview', [idColumn('itemId','Item ID'),
      ...['keep','minimum','desired','maximum'].map(key => ({key,label:key[0]!.toUpperCase()+key.slice(1),min:0,max:32767})),
      {key:'store',label:'Store excess',options:binary},{key:'cart',label:'Cart excess',options:binary},{key:'sell',label:'Sell excess',options:binary},
      {key:'restock',label:'Restock source',options:[['off','Off'],['storage','Storage'],['cart','Cart'],['buy','Open shop']]},
      {key:'allowUnique',label:'Unique items',options:[['0','Protect'],['1','Allow if fully observed']]}],
      {itemId:501,keep:1,minimum:1,desired:1,maximum:1,store:'0',cart:'0',sell:'0',restock:'off',allowUnique:'0'},128,()=>{this.dispositionPlan=null;this.hooks.changed();this.dispositionOutput().textContent='Rules changed. Generate a new preview.';});
    panel.append(this.dispositionEditor.root);
    const grid=document.createElement('div');grid.className='form-grid';
    const label=fieldElement({path:'disposition.maxSpend',label:'Preview maximum spending · zeny',min:0,max:2000000000});label.addEventListener('input',()=>{this.dispositionPlan=null;this.dispositionOutput().textContent='Spending changed. Generate a new preview.';});grid.append(label);panel.append(grid);
    this.note('inventory','Keep ≤ minimum ≤ desired ≤ maximum. Below minimum, restock toward desired from the selected source. Above maximum, permitted excess goes to storage, then cart, then sale. Unlisted, equipped, selected ammo, refined and carded items stay protected. Preview sends no commands; rules are saved with profiles.');
    const button=document.createElement('button');button.type='button';button.className='secondary compact';button.textContent='Preview item disposition';
    button.addEventListener('click',()=>{try{const settings=this.read();const policy=settings.disposition??DEFAULT_DISPOSITION;this.dispositionPlan=planDisposition(policy,{...dispositionContextFromStatus(this.status),minimumStock:dispositionStockFloors(settings)});this.dispositionOutput().textContent=dispositionPreviewText(this.dispositionPlan);}catch(error){this.dispositionPlan=null;this.dispositionOutput().textContent=error instanceof Error?error.message:'Invalid disposition rules.';}});
    panel.append(button);const output=document.createElement('div');output.id='disposition-preview';output.className='telemetry-summary';output.setAttribute('role','status');output.textContent='No preview generated. No items will be moved or sold.';panel.append(output);
  }
  private dispositionOutput(): HTMLElement { return this.host.querySelector<HTMLElement>('#disposition-preview')!; }
  private note(section: Section, message: string): void { const p = document.createElement('p'); p.className = 'hint'; p.textContent = message; this.panel(section).append(p); }
  private editor(section: Section, path: string, title: string, columns: Column[], initial: Row, max: number): RuleEditor {
    const editor = new RuleEditor(title,columns,initial,max,this.hooks.changed); this.editors.set(path,editor); this.panel(section).append(editor.root); return editor;
  }
  private rules(): void {
    this.editor('combat','combat.rules','Monster policies & priority',[idColumn('classId','Monster class ID'),{key:'action',label:'Action',options:[['attack','Attack'],['ignore','Ignore']]},priority],{classId:1002,action:'attack',priority:0},64);
    this.note('combat','Ignore rules take precedence. Higher priority wins among eligible targets. Use monster class IDs from the map list.');
    this.note('recovery','Rest starts above the emergency HP threshold. Resume needs both configured HP and SP targets. Recovery timeouts keep the run waiting.');
    this.note('recovery','Emergency escape is opt-in: random uses Fly Wing or Teleport; save point uses Butterfly Wing or Return. It waits for your refreshed character, then for HP recovery. Stock reserve applies to wings. A rejected or uncertain attempt never falls back to another action.');
    this.editor('travel','travel.waypoints','Waypoints',[{key:'map',label:'Map code',kind:'text'},{key:'x',label:'X',min:0,max:511},{key:'y',label:'Y',min:0,max:511}],{map:'prt_fild08',x:150,y:150},64);
    this.note('travel','Travel uses verified portal routes. NPC or conditional portals may require a manual action. A blank player name disables follow.');
    this.editor('inventory','loot.rules','Pickup filters & priority',[idColumn('itemId','Item ID'),{key:'action',label:'Action',options:[['pickup','Pick up'],['ignore','Ignore']]},priority],{itemId:501,action:'pickup',priority:0},128);
    this.editor('inventory','items','Recovery items',[idColumn('itemId','Item ID'),{key:'resource',label:'Resource',options:[['hp','HP'],['sp','SP']]},{key:'belowPercent',label:'Below %',min:1,max:100},{key:'minStock',label:'Keep quantity',min:0,max:9999},{key:'cooldownSeconds',label:'Cooldown seconds',min:1,max:3600}],{itemId:501,resource:'hp',belowPercent:60,minStock:0,cooldownSeconds:5},32);
    this.editor('inventory','skills','Skill rules',[idColumn('skillId','Skill ID',255),{key:'level',label:'Level',min:1,max:10},{key:'target',label:'Target',options:[['self','Your character'],['enemy','Current enemy']]},{key:'hpBelowPercent',label:'HP below %',min:1,max:100},{key:'spAbovePercent',label:'SP above %',min:0,max:100},{key:'cooldownSeconds',label:'Cooldown seconds',min:1,max:3600}],{skillId:1,level:1,target:'self',hpBelowPercent:100,spAbovePercent:0,cooldownSeconds:10},32);
    this.editor('inventory','equipment','Equipment conditions',[idColumn('itemId','Item ID'),{key:'hpBelowPercent',label:'HP below %',min:1,max:100},{key:'monsterClassId',label:'Monster ID · 0 any',min:0,max:2147483647}],{itemId:1,hpBelowPercent:100,monsterClassId:0},32);
    this.editor('inventory','allocation.stats','Stat allocation targets',[{key:'stat',label:'Stat',options:[['0','STR'],['1','AGI'],['2','VIT'],['3','INT'],['4','DEX'],['5','LUK']]},{key:'target',label:'Target value',min:1,max:99}],{stat:0,target:10},6);
    this.editor('inventory','allocation.skills','Skill allocation targets',[idColumn('skillId','Skill ID',255),{key:'target',label:'Target level',min:1,max:10}],{skillId:1,target:1},64);
    this.note('inventory','Rules use server item and skill IDs. Spending stat or skill points changes the character; configure only the targets you intend.');
    const manual=document.createElement('details');manual.className='manual-group';const title=document.createElement('summary');title.textContent='Manual character actions';manual.append(title);this.panel('inventory').append(manual);
    const grid=document.createElement('div');grid.className='form-grid';manual.append(grid);
    const item=this.input(grid,'manual-item','Usable item ID','number','501',1);item.setAttribute('list','itemId-catalog');
    const bag=this.input(grid,'manual-equip','Equipment bag ID','number','1',1);
    const skill=this.input(grid,'manual-skill','Learned skill ID','number','1',1,255);skill.setAttribute('list','skillId-catalog');
    const level=this.input(grid,'manual-skill-level','Skill level','number','1',1,10);
    const target=this.input(grid,'manual-target','Target entity ID','number','0',0);
    const x=this.input(grid,'manual-ground-x','Ground X','number','0',0,511);const y=this.input(grid,'manual-ground-y','Ground Y','number','0',0,511);
    const buttons=document.createElement('div');buttons.className='button-row';manual.append(buttons);
    this.manualButton('Sit',()=>({type:'sit',sitting:true}),buttons);this.manualButton('Stand',()=>({type:'sit',sitting:false}),buttons);this.manualButton('Respawn',()=>({type:'respawn'}),buttons);
    this.manualButton('Use item',()=>({type:'useItem',itemId:Number(item.value),...(Number(target.value)>0?{target:Number(target.value)}:{})}),buttons);
    this.manualButton('Equip',()=>({type:'equip',bagId:Number(bag.value),equipped:true}),buttons);this.manualButton('Unequip',()=>({type:'equip',bagId:Number(bag.value),equipped:false}),buttons);
    this.manualButton('Self skill',()=>({type:'skill',mode:'self',skillId:Number(skill.value),level:Number(level.value)}),buttons);
    this.manualButton('Target skill',()=>({type:'skill',mode:'target',skillId:Number(skill.value),level:Number(level.value),target:Number(target.value)}),buttons);
    this.manualButton('Ground skill',()=>({type:'skill',mode:'ground',skillId:Number(skill.value),level:Number(level.value),position:{x:Number(x.value),y:Number(y.value)}}),buttons);
    this.manualButton('Spend 1 skill point',()=>({type:'allocateSkill',skillId:Number(skill.value)}),buttons);
    const allocation=document.createElement('div');allocation.className='form-grid';manual.append(allocation);const attributes=['STR','AGI','VIT','INT','DEX','LUK'].map((stat,index)=>this.input(allocation,`manual-stat-${index}`,`${stat} increments`,'number','0',0,99));
    this.manualButton('Spend stat points',()=>({type:'allocateStats',attributes:attributes.map(input=>Number(input.value))}),manual);
    const summary = document.createElement('div'); summary.id = 'character-data'; summary.className = 'telemetry-summary'; summary.textContent = 'Connect a character to inspect SP, inventory and learned skills.'; this.panel('inventory').append(summary);
    this.note('workflows','Limits and hours are checked while automation runs. These controls never launch the app or start a stopped session.');
  }
  private navigation(): void {
    const sidebar = document.querySelector('.sidebar')!; const existing = sidebar.querySelector('.nav-item')!; existing.remove();
    const nav = document.createElement('nav'); nav.className = 'feature-nav'; nav.setAttribute('aria-label','Bot settings');
    const titles: Array<[Section,string,string]> = [['combat','◈','Combat'],['recovery','♡','Recovery'],['travel','⌁','Travel & follow'],['inventory','▣','Inventory & skills'],['workflows','◇','Workflows & social'],['profiles','☷','Profiles & features']];
    for (const [section,icon,title] of titles) {
      const button = document.createElement('button'); button.className = 'nav-item'; button.type = 'button'; button.dataset.sectionTab = section;
      const symbol = document.createElement('span'); symbol.textContent = icon; button.append(symbol,document.createTextNode(title));
      button.addEventListener('click',()=>this.show(section)); nav.append(button);
    }
    sidebar.insertBefore(nav,sidebar.querySelector('.sidebar-bottom')); const mobile = nav.cloneNode(true) as HTMLElement; mobile.classList.add('mobile-nav');
    for (const button of mobile.querySelectorAll<HTMLButtonElement>('button')) button.addEventListener('click',()=>this.show(button.dataset.sectionTab as Section));
    this.host.insertBefore(mobile,this.host.querySelector('.columns')); this.show('combat');
  }
  private show(section: Section): void {
    for (const [key,panel] of this.panels) panel.hidden = key !== section;
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-section-tab]')) { const active = button.dataset.sectionTab === section; button.classList.toggle('selected',active); button.setAttribute('aria-current',active ? 'page' : 'false'); }
  }
  read(): AutomationSettings {
    const automation = structuredClone(DEFAULT_AUTOMATION) as unknown as Record<string,unknown>;
    automation.disposition=structuredClone(DEFAULT_DISPOSITION);
    object(automation.disposition).maxSpend=Number(this.host.querySelector<HTMLInputElement>('[data-setting="disposition.maxSpend"]')!.value);
    for (const definitions of Object.values(fields)) for (const field of definitions) {
      const input = this.host.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-setting="${field.path}"]`)!;
      setPath(automation,field.path,field.kind === 'checkbox' ? (input as HTMLInputElement).checked : field.kind === 'text' || field.options ? input.value : Number(input.value));
    }
    for (const [path,editor] of this.editors) {
      const rows = editor.read();
      if (path === 'allocation.stats') for (const row of rows) row.stat = Number(row.stat);
      setPath(automation,path,rows);
    }
    object(automation.disposition).rules=this.dispositionEditor.read().map(row=>({...row,store:row.store==='1',cart:row.cart==='1',sell:row.sell==='1',allowUnique:row.allowUnique==='1'}));
    return validateAutomation(automation as unknown as AutomationSettings);
  }
  write(automation: AutomationSettings): void {
    automation = validateAutomation(automation);
    for (const definitions of Object.values(fields)) for (const field of definitions) {
      const input = this.host.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-setting="${field.path}"]`)!;
      const value = getPath(automation,field.path);
      if (field.kind === 'checkbox') (input as HTMLInputElement).checked = value === true; else input.value = String(value ?? '');
    }
    for (const [path,editor] of this.editors) editor.write(getPath(automation,path) as Row[]);
    const policy=automation.disposition??DEFAULT_DISPOSITION;
    this.host.querySelector<HTMLInputElement>('[data-setting="disposition.maxSpend"]')!.value=String(policy.maxSpend);
    this.dispositionEditor.write(policy.rules.map(row=>({...row,store:row.store?'1':'0',cart:row.cart?'1':'0',sell:row.sell?'1':'0',allowUnique:row.allowUnique?'1':'0'})));
    this.dispositionPlan=null;this.dispositionOutput().textContent='No preview generated. No items will be moved or sold.';
  }
  levelDifference(): number { return Number(this.host.querySelector<HTMLInputElement>('[data-setting="combat.levelDifference"]')!.value); }
  private async operation(action: () => Promise<unknown>): Promise<void> {
    if (this.manualLocked) return;
    try { const result = await action(); this.hooks.notify(typeof result === 'string' ? result : 'Request sent. Waiting for the game to confirm.'); }
    catch (error) { this.hooks.notify(error instanceof Error ? error.message : typeof error === 'string' ? error : 'The game could not accept this request.',true); }
  }
  private manualButton(label: string, action: () => Record<string, unknown>, parent: HTMLElement): void {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary compact'; button.dataset.manual = 'true'; button.textContent = label;
    button.addEventListener('click',()=>void this.operation(()=>this.hooks.command(checkedAction(action())))); parent.append(button);
  }
  private input(parent: HTMLElement, id: string, label: string, kind: 'text' | 'number', value: string, min = 0, max = 2147483647): HTMLInputElement {
    const field = fieldElement({path:id,label,kind:kind==='text'?'text':undefined,min,max}); const input = field.querySelector<HTMLInputElement>('input')!;
    delete input.dataset.setting; input.id = id; input.value = value; parent.append(field); return input;
  }
  private detail(title: string): HTMLDetailsElement { const details = document.createElement('details'); details.className = 'manual-group'; const summary = document.createElement('summary'); summary.textContent = title; details.append(summary); this.panel('workflows').append(details); return details; }
  private workflows(): void {
    const npc = this.detail('NPC dialogue'); const npcGrid = document.createElement('div'); npcGrid.className = 'form-grid'; npc.append(npcGrid);
    const npcId = this.input(npcGrid,'npc-id','Visible NPC ID','number','0',1); const option = this.input(npcGrid,'npc-option','Option index','number','0',0,31);
    const npcChoiceLabel=document.createElement('label');npcChoiceLabel.className='form-field';npcChoiceLabel.textContent='NPCs in view';const npcChoice=document.createElement('select');npcChoice.id='visible-npcs';const emptyNpc=document.createElement('option');emptyNpc.value='';emptyNpc.textContent='Choose a visible NPC';npcChoice.append(emptyNpc);npcChoiceLabel.append(npcChoice);npcGrid.append(npcChoiceLabel);npcChoice.addEventListener('change',()=>{if(npcChoice.value)npcId.value=npcChoice.value;});
    const npcButtons = document.createElement('div'); npcButtons.className = 'button-row'; npc.append(npcButtons);
    this.manualButton('Talk',()=>({type:'npcTalk',id:Number(npcId.value)}),npcButtons); this.manualButton('Continue',()=>({type:'npcAdvance'}),npcButtons); this.manualButton('Choose option',()=>({type:'npcOption',index:Number(option.value)}),npcButtons);
    const dialogue = document.createElement('p'); dialogue.id = 'npc-dialogue'; dialogue.className = 'telemetry-summary'; dialogue.textContent = 'No NPC dialogue open.'; npc.append(dialogue);
    const shop = this.detail('NPC shop · buy & sell');
    const shopRows = new RuleEditor('Transaction rows',[idColumn('id','Shop item / bag ID'),countColumn],{id:1,count:1},64,()=>{}); shop.append(shopRows.root); shopRows.root.open = true;
    const shopButtons = document.createElement('div'); shopButtons.className = 'button-row'; shop.append(shopButtons);
    this.manualButton('Buy rows',()=>({type:'shop',mode:'buy',rows:shopRows.read()}),shopButtons); this.manualButton('Sell rows',()=>({type:'shop',mode:'sell',rows:shopRows.read()}),shopButtons);
    this.manualButton('Close shop',()=>({type:'shop',mode:object(object(this.status.world).shop).mode??'buy',rows:[]}),shopButtons);
    const shopState = document.createElement('p'); shopState.id = 'shop-state'; shopState.className = 'telemetry-summary'; shopState.textContent = 'Open a shop through an NPC first. Purchase prices and stock are confirmed by the server.'; shop.append(shopState);
    const storage = this.detail('Storage & cart'); const storageGrid = document.createElement('div'); storageGrid.className = 'form-grid'; storage.append(storageGrid);
    const bag = this.input(storageGrid,'transfer-bag','Bag ID','number','1',1); const quantity = this.input(storageGrid,'transfer-count','Quantity','number','1',1,9999);
    const transferButtons = document.createElement('div'); transferButtons.className = 'button-row'; storage.append(transferButtons);
    for (const operation of ['deposit','withdraw'] as const) this.manualButton(operation==='deposit'?'Deposit':'Withdraw',()=>({type:'storage',operation,bagId:Number(bag.value),count:Number(quantity.value)}),transferButtons);
    this.manualButton('Close storage',()=>({type:'storage',operation:'close'}),transferButtons);
    this.manualButton('Bag → cart',()=>({type:'cart',direction:1,bagId:Number(bag.value),count:Number(quantity.value)}),transferButtons); this.manualButton('Cart → bag',()=>({type:'cart',direction:2,bagId:Number(bag.value),count:Number(quantity.value)}),transferButtons);
    const storageState = document.createElement('p'); storageState.id = 'storage-state'; storageState.className = 'telemetry-summary'; storage.append(storageState);
    const barter=this.detail('NPC item exchanges');const barterGrid=document.createElement('div');barterGrid.className='form-grid';barter.append(barterGrid);
    const choice=this.input(barterGrid,'barter-choice','Offer index','number','0',0,63);const barterCount=this.input(barterGrid,'barter-count','Quantity','number','1',1,99);const barterBags=this.input(barterGrid,'barter-bags','Equipment bag IDs · comma separated','text','');barterBags.maxLength=256;
    const barterButtons=document.createElement('div');barterButtons.className='button-row';barter.append(barterButtons);
    this.manualButton('Exchange items',()=>({type:'npcBarter',choice:Number(choice.value),count:Number(barterCount.value),bagIds:barterBags.value.trim()?barterBags.value.split(',').map(value=>Number(value.trim())):[]}),barterButtons);this.manualButton('Cancel exchange',()=>({type:'npcBarterCancel'}),barterButtons);
    const barterState=document.createElement('p');barterState.id='barter-state';barterState.className='telemetry-summary';barter.append(barterState);
    const party = this.detail('Party controls'); const partyGrid = document.createElement('div'); partyGrid.className = 'form-grid'; party.append(partyGrid);
    const partyName = this.input(partyGrid,'party-name','Party name','text',''); const playerName = this.input(partyGrid,'party-player','Invite player name','text','');
    const member = this.input(partyGrid,'party-member','Party member ID','number','0',1); const partyId = this.input(partyGrid,'party-id','Incoming party ID','number','0',1);
    const partyButtons = document.createElement('div'); partyButtons.className = 'button-row'; party.append(partyButtons);
    this.manualButton('Create party',()=>({type:'partyCreate',name:partyName.value}),partyButtons); this.manualButton('Invite named player',()=>({type:'partyInviteName',name:playerName.value}),partyButtons); this.manualButton('Accept invite',()=>({type:'partyAccept',partyId:Number(partyId.value)}),partyButtons);
    this.manualButton('Make leader',()=>({type:'partyLeader',memberId:Number(member.value)}),partyButtons); this.manualButton('Remove member',()=>({type:'partyRemove',memberId:Number(member.value)}),partyButtons); this.manualButton('Leave party',()=>({type:'partyLeave'}),partyButtons); this.manualButton('Disband party',()=>({type:'partyDisband'}),partyButtons);
    const partyState = document.createElement('p'); partyState.id = 'party-state'; partyState.className = 'telemetry-summary'; party.append(partyState);
    const vending = this.detail('Player vending'); const vendingName = this.input(vending,'vending-name','Shop name','text',''); const seller = this.input(vending,'vending-seller','Visible seller ID','number','0',1);
    const vendingRows = new RuleEditor('Vending rows',[idColumn('id','Bag / sale ID'),countColumn,{key:'price',label:'Price',min:0,max:9999999}],{id:1,count:1,price:1},32,()=>{}); vending.append(vendingRows.root);
    const vendingButtons = document.createElement('div'); vendingButtons.className = 'button-row'; vending.append(vendingButtons);
    this.manualButton('Open your shop',()=>({type:'vendingStart',name:vendingName.value,rows:vendingRows.read()}),vendingButtons); this.manualButton('Close your shop',()=>({type:'vendingStop'}),vendingButtons); this.manualButton('View seller',()=>({type:'vendingView',id:Number(seller.value)}),vendingButtons); this.manualButton('Buy sale rows',()=>({type:'vendingPurchase',rows:vendingRows.read().map(({id,count})=>({id,count}))}),vendingButtons);
    const workflow = this.detail('NPC workflow builder'); const workflowGrid = document.createElement('div'); workflowGrid.className = 'form-grid'; workflow.append(workflowGrid);
    const workflowName = this.input(workflowGrid,'workflow-name','Workflow name','text','Town visit'); const workflowMap = this.input(workflowGrid,'workflow-map','Map code','text','');
    const workflowNpc = this.input(workflowGrid,'workflow-npc','NPC entity ID','number','0',1); const budget = this.input(workflowGrid,'workflow-budget','Maximum spend','number','0',0);
    const workflowStock = new RuleEditor('Minimum stock guards',[idColumn('itemId','Item ID'),{key:'count',label:'Keep quantity',min:0,max:9999}],{itemId:501,count:1},64,()=>{}); workflow.append(workflowStock.root);
    const steps: Array<Record<string,unknown>> = []; const stepsList = document.createElement('ol'); stepsList.className = 'workflow-steps'; workflow.append(stepsList);
    const builder = document.createElement('div'); builder.className = 'form-grid'; workflow.append(builder);
    const kindLabel = fieldElement({path:'workflow-kind',label:'Step',options:[['talk','Talk'],['advance','Continue'],['option','Choose option'],['buy','Buy'],['sell','Sell'],['deposit','Deposit'],['withdraw','Withdraw'],['closeShop','Close shop'],['closeStorage','Close storage'],['cancelBarter','Cancel exchange']]}); builder.append(kindLabel); const kind = kindLabel.querySelector<HTMLSelectElement>('select')!; delete kind.dataset.setting;
    const stepIndex = this.input(builder,'workflow-step-index','Option index / item / bag ID','number','0',0); const stepCount = this.input(builder,'workflow-step-count','Quantity','number','1',1,9999); const expected = this.input(builder,'workflow-step-label','Expected option / dialogue text','text',''); expected.maxLength = 1024;
    const expectedCost=this.input(builder,'workflow-step-fee','Expected NPC fee · zeny','number','0',0,2_000_000_000);
    const workflowButtons = document.createElement('div'); workflowButtons.className = 'button-row'; workflow.append(workflowButtons);
    const addStep = document.createElement('button'); addStep.type = 'button'; addStep.className = 'secondary compact'; addStep.textContent = '＋ Add step'; addStep.dataset.config = 'true'; workflowButtons.append(addStep);
    const renderSteps = () => { stepsList.replaceChildren(); steps.forEach((step,index)=> { const li = document.createElement('li'); const description = document.createElement('span'); description.textContent = JSON.stringify(step); const remove = document.createElement('button'); remove.type='button'; remove.className='text-button'; remove.textContent='Remove'; remove.dataset.config='true'; remove.addEventListener('click',()=>{steps.splice(index,1);renderSteps();}); li.append(description,remove); stepsList.append(li); }); addStep.disabled = this.locked || steps.length>=32; };
    addStep.addEventListener('click',()=> { if (steps.length>=32) return; const type=kind.value; let step:Record<string,unknown>={type}; if(['talk','advance','option'].includes(type))step.expectedCost=Number(expectedCost.value); if(type==='advance'&&expected.value)step.expectedText=expected.value; if(type==='option'){step.index=Number(stepIndex.value);step.expectedLabel=expected.value;} if(type==='buy'||type==='sell')step.rows=[{id:Number(stepIndex.value),count:Number(stepCount.value)}]; if(type==='deposit'||type==='withdraw'){step.bagId=Number(stepIndex.value);step.count=Number(stepCount.value);} steps.push(step);renderSteps(); });
    const spec = () => ({name:workflowName.value,map:workflowMap.value || this.hooks.map(),npcId:Number(workflowNpc.value),maxSpend:Number(budget.value),minStock:workflowStock.read(),steps});
    const run = document.createElement('button'); run.type='button'; run.className='primary compact'; run.textContent='Start workflow'; run.dataset.manual='true'; run.addEventListener('click',()=>void this.operation(()=>this.hooks.workflow(validateWorkflowSpec(spec())))); workflowButtons.append(run);
    const workflowPreview=document.createElement('p');workflowPreview.className='telemetry-summary';workflowPreview.hidden=true;workflow.append(workflowPreview);
    const preview=document.createElement('button');preview.type='button';preview.className='secondary compact';preview.textContent='Validate / preview';preview.dataset.config='true';preview.addEventListener('click',()=>{try{const checked=validateWorkflowSpec(spec());const expectedFees=checked.steps.reduce((total,step)=>total+('expectedCost' in step?Number(step.expectedCost??0):0),0);workflowPreview.hidden=false;workflowPreview.textContent=`${checked.steps.length} validated steps · budget ${checked.maxSpend} · expected NPC fees ${expectedFees} · ${checked.minStock.length} stock guards.\nNPC fees count toward the spending cap. Live map, NPC, shop prices and stock are checked on Start.\n${checked.steps.map((step,index)=>`${index+1}. ${JSON.stringify(step)}`).join('\n')}`;}catch(error){this.hooks.notify(error instanceof Error?error.message:'Invalid workflow.',true);}});workflowButtons.append(preview);
    const workflowDocument=document.createElement('details');workflowDocument.className='manual-group';const workflowDocumentTitle=document.createElement('summary');workflowDocumentTitle.textContent='Advanced workflow document';workflowDocument.append(workflowDocumentTitle);workflow.append(workflowDocument);
    const workflowText=document.createElement('textarea');workflowText.className='document-editor';workflowText.rows=8;workflowText.maxLength=65000;workflowText.spellcheck=false;workflowText.placeholder='Export the builder, or paste a typed workflow for multi-item transactions and exchanges.';workflowDocument.append(workflowText);
    const exportWorkflow=document.createElement('button');exportWorkflow.type='button';exportWorkflow.className='secondary compact';exportWorkflow.textContent='Export builder';exportWorkflow.dataset.config='true';exportWorkflow.addEventListener('click',()=>{workflowText.value=JSON.stringify(spec(),null,2);});workflowDocument.append(exportWorkflow);
    const startDocument=document.createElement('button');startDocument.type='button';startDocument.className='secondary compact';startDocument.textContent='Start document';startDocument.dataset.manual='true';startDocument.addEventListener('click',()=>void this.operation(()=>this.hooks.workflow(validateWorkflowSpec(JSON.parse(workflowText.value)))));workflowDocument.append(startDocument);
    const workflowHelp = document.createElement('p'); workflowHelp.className='hint'; workflowHelp.textContent='Choose exact option labels, observed NPC fees and a spending cap. Talk, continue and option fees count toward that cap. The workflow checks the map, NPC, stock and server acknowledgements before each step.'; workflow.append(workflowHelp);
    const workflowState=document.createElement('p');workflowState.id='workflow-state';workflowState.className='telemetry-summary';workflow.append(workflowState);
    const routine=this.detail('Advanced condition routines'); const routineHelp=document.createElement('p');routineHelp.className='hint';routineHelp.textContent='Bounded rules use HP %, SP %, zeny, elapsed seconds, map or inventory quantity. An unknown observation never matches. Actions use the typed command names; raw packets, scripts and arbitrary code are unavailable.';routine.append(routineHelp);
    const routineText=document.createElement('textarea');routineText.id='routine-document';routineText.className='document-editor';routineText.spellcheck=false;routineText.maxLength=65000;routineText.rows=12;routineText.value=JSON.stringify({name:'Rest when hurt',durationSeconds:300,maxActions:1,rules:[{name:'Sit below 60% HP',priority:1,cooldownSeconds:30,maxRuns:1,conditions:[{field:'hpPercent',operator:'lt',value:60}],action:{type:'sit',sitting:true}}]},null,2);routine.append(routineText);
    const routineButtons=document.createElement('div');routineButtons.className='button-row';routine.append(routineButtons);
    const routineStart=document.createElement('button');routineStart.type='button';routineStart.className='primary compact';routineStart.textContent='Start routine';routineStart.dataset.manual='true';routineStart.addEventListener('click',()=>void this.operation(()=>this.hooks.routine(validateRoutineSpec(JSON.parse(routineText.value),isAction))));routineButtons.append(routineStart);
    const routinePreview=document.createElement('p');routinePreview.className='telemetry-summary';routinePreview.hidden=true;routine.append(routinePreview);
    const dryRun=document.createElement('button');dryRun.type='button';dryRun.className='secondary compact';dryRun.textContent='Validate / dry run';dryRun.dataset.config='true';dryRun.addEventListener('click',()=>{try{const checked=validateRoutineSpec(JSON.parse(routineText.value),isAction);const trace=dryRunRoutine(checked,this.observation(),isAction);routinePreview.hidden=false;routinePreview.textContent=trace.rules.map(rule=>`${rule.name}: ${rule.state} · ${rule.reason}`).join('\n');this.hooks.notify('Routine validated. Dry run sends no commands.');}catch(error){this.hooks.notify(error instanceof Error?error.message:'Invalid routine.',true);}});routineButtons.append(dryRun);
    const routineState=document.createElement('p');routineState.id='routine-state';routineState.className='telemetry-summary';routine.append(routineState);
  }
  private profilePanel(): void {
    const panel=this.panel('profiles');const controls=document.createElement('div');controls.className='form-grid';panel.append(controls);
    const name=this.input(controls,'profile-name','Profile name','text','');name.maxLength=48;
    const selectLabel=document.createElement('label');selectLabel.className='form-field';selectLabel.textContent='Saved profiles';const select=document.createElement('select');select.id='profile-select';selectLabel.append(select);controls.append(selectLabel);
    const summary=document.createElement('p');summary.id='profile-summary';summary.className='hint';panel.append(summary);
    const buttons=document.createElement('div');buttons.className='button-row';panel.append(buttons);
    const documentEditor=document.createElement('textarea');documentEditor.id='profile-document';documentEditor.className='document-editor';documentEditor.spellcheck=false;documentEditor.maxLength=256000;documentEditor.rows=8;documentEditor.placeholder='Exported profile JSON appears here. Paste a version 1 profile document to import.';
    const documents=document.createElement('details');documents.className='manual-group';const documentsTitle=document.createElement('summary');documentsTitle.textContent='Import & export settings';documents.append(documentsTitle,documentEditor);panel.append(documents);
    const refresh=(selected='')=>{const values=this.profiles.list();select.replaceChildren();const empty=document.createElement('option');empty.value='';empty.textContent='Choose a profile';select.append(empty);for(const profile of values){const option=document.createElement('option');option.value=profile.id;option.textContent=`${profile.name} · ${profile.settings.map}`;select.append(option);}select.value=selected;summary.textContent=`${values.length} / ${MAX_PROFILES} profiles · Saved on this Mac. No passwords, login preferences or running state.`;};
    const action=(title:string,fn:()=>void,container:HTMLElement=buttons)=>{const button=document.createElement('button');button.type='button';button.className='secondary compact';button.textContent=title;button.dataset.config='true';button.addEventListener('click',()=>{if(this.locked)return;try{fn();}catch(error){this.hooks.notify(error instanceof Error?error.message:'Could not update profiles.',true);}});container.append(button);};
    action('Save new',()=>{const profile=this.profiles.save(name.value,this.hooks.character(),this.hooks.settings());refresh(profile.id);this.hooks.notify('Settings saved. The profile will never start automation automatically.');});
    action('Update selected',()=>{if(!select.value)throw new Error('Choose a profile to update.');const profile=this.profiles.save(name.value,this.hooks.character(),this.hooks.settings(),select.value);refresh(profile.id);this.hooks.notify('Profile updated.');});
    action('Apply',()=>{const profile=this.profiles.forMap(select.value,this.hooks.map(),this.hooks.character());this.hooks.apply(profile.settings);this.hooks.notify(`Applied ${profile.name}. Automation remains stopped.`);});
    action('Delete',()=>{if(!select.value)throw new Error('Choose a profile to delete.');this.profiles.remove(select.value);refresh();this.hooks.notify('Profile deleted.');});
    action('Export',()=>{documentEditor.value=this.profiles.export(select.value);documents.open=true;});
    action('Import document',()=>{const imported=this.profiles.import(documentEditor.value);refresh(imported[0]?.id);this.hooks.notify('Profile imported. Apply it on its saved map when ready.');},documents);
    select.addEventListener('change',()=>{const selected=this.profiles.list().find(profile=>profile.id===select.value);if(selected){name.value=selected.name;summary.textContent=`${selected.character||'Any character'} · ${selected.settings.map} · ${new Date(selected.savedAt).toLocaleString()} · Apply only changes settings.`;}});refresh();
    const coverage=document.createElement('details');coverage.className='manual-group feature-coverage';coverage.open=true;const title=document.createElement('summary');title.textContent='OpenKore feature coverage';coverage.append(title);panel.append(coverage);
    const help=document.createElement('p');help.className='hint';help.textContent='Reference inventory covers 39 feature families. Local implementation, source-only capability and unavailable systems are distinct; this checklist does not claim full OpenKore parity.';coverage.append(help);
    const table=document.createElement('div');table.className='coverage-list';coverage.append(table);
    const ready=new Set(['login','profiles','combat','monsterRules','navigation','follow','recovery','death','conditionRules','loot','shops','progression','scheduler','reconnect','commands','macros']);
    const partial=new Set(['antiKs','combatMovement','travel','teleport','skills','equipment','inventory','storage','npc','crafting','party','trade','avoidance','observability']);
    const unverified=new Set(['companions','quests','mailBank','repair']);
    const excluded=new Set(['roTransport','xkorePoseidon','gmDebug']);
    const rows:Array<[string,string]>=[['login','Login & character selection'],['profiles','Profiles & import/export'],['combat','Combat & retaliation'],['monsterRules','Monster policies & priority'],['antiKs','Engagement ownership'],['combatMovement','Ranged combat, LOS & kiting'],['navigation','Map navigation & unstuck'],['travel','Travel & lock map'],['teleport','Teleport & escape'],['follow','Follow player'],['recovery','HP/SP & item recovery'],['death','Death & respawn'],['skills','Skills & support'],['conditionRules','Conditional rules'],['equipment','Equipment conditions'],['loot','Pickup filters & priority'],['inventory','Inventory & weight'],['storage','Storage & cart'],['shops','NPC shops'],['npc','NPC workflows'],['repair','Equipment repair'],['crafting','Crafting & exchanges'],['progression','Stat & skill allocation'],['party','Party controls'],['social','Guild, friends & chat'],['trade','Trade & vending'],['quests','Quests & achievements'],['mailBank','Mail, bank & auction'],['companions','Pets & companions'],['scheduler','Hours & session limits'],['reconnect','Reconnect backoff'],['avoidance','Map & actor avoidance'],['observability','Logs & session statistics'],['commands','Typed manual commands'],['macros','Condition routines & macros'],['plugins','Extensions & hooks'],['roTransport','RO server transport adapters'],['xkorePoseidon','XKore & Poseidon'],['gmDebug','GM, raw packets & eval']];
    for(const[id,label]of rows){const row=document.createElement('div');const name=document.createElement('span');name.textContent=label;const state=document.createElement('span');state.className='coverage-state';state.textContent=ready.has(id)?'Local implementation':partial.has(id)?'Partial implementation':unverified.has(id)?'No verified game adapter':excluded.has(id)?'Not applicable':'Not implemented';row.append(name,state);table.append(row);}
  }
  lock(config: boolean, manual: boolean): void {
    this.locked=config;this.manualLocked=manual;
    for(const input of this.host.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLButtonElement|HTMLTextAreaElement>('[data-setting], [data-config], .feature-panel input, .feature-panel select, .feature-panel textarea, .rule-editor button')) input.disabled=config;
    for(const editor of this.editors.values())editor.lock(config);
    this.dispositionEditor.lock(config);
    for(const button of this.host.querySelectorAll<HTMLButtonElement>('[data-manual]'))button.disabled=manual;
  }
  active(): boolean { return object(this.status.workflow).running===true || ['running','waiting'].includes(text(object(this.status.routine).state)) || object(this.status.actionResult).status==='pending' || object(this.status.task).pending===true; }
  private observation(): RoutineObservation {
    const stats=object(object(this.status.character).stats);const player=object(this.status.player);const hp=number(stats.hp)??number(player.hp);const maxHp=number(stats.maxHp)??number(player.maxHp);const sp=number(stats.sp);const maxSp=number(stats.maxSp);const zeny=number(stats.zeny);const result:RoutineObservation={map:this.hooks.map(),elapsedSeconds:0};
    if(hp!==null&&maxHp!==null&&maxHp>0)result.hpPercent=hp/maxHp*100;if(sp!==null&&maxSp!==null&&maxSp>0)result.spPercent=sp/maxSp*100;if(zeny!==null)result.zeny=zeny;
    const character=object(this.status.character);if(character.inventoryKnown===true&&Array.isArray(character.inventory)){const counts:Record<number,number>={};for(const entry of character.inventory){const row=object(entry);const id=number(row.itemId);const count=number(row.count);if(id!==null&&count!==null)counts[id]=(counts[id]??0)+count;}result.inventory=counts;}return result;
  }
  render(value: unknown): void {
    this.status=object(value);const s=this.status;const character=object(s.character);const player=object(s.player);const stats=object(character.stats);
    if(this.dispositionPlan){try{const settings=this.read();if(!dispositionPreviewIsCurrent(this.dispositionPlan,settings.disposition??DEFAULT_DISPOSITION,{...dispositionContextFromStatus(this.status),minimumStock:dispositionStockFloors(settings)})){this.dispositionOutput().textContent='Preview is stale. Generate it again from current state.';this.dispositionPlan=null;}}catch{this.dispositionPlan=null;this.dispositionOutput().textContent='Preview is stale. Validate rules and generate it again.';}}
    const experience=object(character.experience);const task=object(s.task);const escape=object(s.escape);this.host.querySelector<HTMLElement>('#session-details')!.textContent=`${Math.floor((number(s.elapsedSeconds)??0)/60)}m ${(number(s.elapsedSeconds)??0)%60}s · ${number(s.deaths)??0} deaths · Base EXP +${number(experience.baseGained)??'—'} · Job EXP +${number(experience.jobGained)??'—'}${task.label?' · '+text(task.label):''}${escape.state&&escape.state!=='idle'?' · '+text(escape.reason):''}`;
    const npcChoice=this.host.querySelector<HTMLSelectElement>('#visible-npcs')!;const actors=Array.isArray(s.actors)?s.actors.map(object).filter(actor=>actor.kind===2||actor.kind===4):[];const actorKey=actors.map(actor=>`${actor.id}:${text(actor.name)}`).join('|');
    if(npcChoice.dataset.actors!==actorKey){const selected=npcChoice.value;npcChoice.dataset.actors=actorKey;npcChoice.replaceChildren();const empty=document.createElement('option');empty.value='';empty.textContent='Choose a visible NPC';npcChoice.append(empty);for(const actor of actors){const option=document.createElement('option');option.value=String(actor.id);option.textContent=`${text(actor.name)||'NPC'} · #${actor.id}`;npcChoice.append(option);}npcChoice.value=actors.some(actor=>String(actor.id)===selected)?selected:'';}
    const inventory=Array.isArray(character.inventory)?character.inventory:[];const skills=Array.isArray(character.learned)?character.learned:[];
    const inventoryText=inventory.slice(0,30).map(item=>{const row=object(item);return `Bag ${number(row.bagId)??'?'} · ${itemName(number(row.itemId)??0)} × ${number(row.count)??'?'}`;}).join('\n');
    const skillText=skills.slice(0,40).map(skill=>{const row=object(skill);return `${skillName(number(row.skillId)??0)} · Lv ${number(row.level)??'?'}`;}).join(', ');
    const summary=this.host.querySelector<HTMLElement>('#character-data')!;summary.textContent=`SP ${number(stats.sp)??number(player.sp)??'—'} / ${number(stats.maxSp)??number(player.maxSp)??'—'} · Zeny ${number(stats.zeny)??'—'} · Weight ${number(stats.weight)??'—'} / ${number(stats.maxWeight)??'—'}\n${character.inventoryKnown===true?`${inventory.length} inventory entries`:'Inventory not observed'}${inventoryText?'\n'+inventoryText:''}\n${character.skillsKnown===true?`${skills.length} learned skills`:'Skills not observed'}${skillText?'\n'+skillText:''}`;
    const world=object(s.world);const npc=object(world.npc);const dialog=object(npc.dialog);this.host.querySelector<HTMLElement>('#npc-dialogue')!.textContent=`${text(dialog.name)}${dialog.name?' · ':''}${text(dialog.text)||'No NPC dialogue open.'}${Array.isArray(npc.options)&&npc.options.length?'\n'+npc.options.map((label,index)=>`${index}: ${text(label)}`).join('\n'):''}`;
    const shop=object(world.shop);this.host.querySelector<HTMLElement>('#shop-state')!.textContent=Array.isArray(shop.entries)?`${text(shop.mode)} shop · ${shop.entries.length} entries\n${shop.entries.slice(0,30).map(entry=>{const row=object(entry);return `${itemName(number(row.itemId)??number(row.id)??0)} · #${number(row.id)??number(row.itemId)??'?'} · ${number(row.price)??'?'} zeny`;}).join('\n')}`:'Open a shop through an NPC first.';
    this.host.querySelector<HTMLElement>('#storage-state')!.textContent=`Storage: ${world.storageReady===true&&Array.isArray(world.storage)?world.storage.length:'not open'} entries · Cart: ${world.cartReady===true&&Array.isArray(world.cart)?world.cart.length:'unknown'} entries`;
    const party=object(world.party);const invite=object(world.invite);this.host.querySelector<HTMLElement>('#party-state')!.textContent=`${party.name?`${text(party.name)} · ${Array.isArray(party.members)?party.members.map(member=>text(object(member).name)).join(', '):''}`:'No party state observed.'}${invite.partyId?'\nInvite '+text(invite.name)+' · party #'+invite.partyId+' · from '+text(invite.sender):''}`;
    this.host.querySelector<HTMLElement>('#barter-state')!.textContent=Array.isArray(world.barter)&&world.barter.length?world.barter.slice(0,30).map((entry,index)=>{const row=object(entry);return `${index}: ${itemName(number(object(row.item).itemId)??0)} · ${JSON.stringify(row.required ?? []).slice(0,300)}`;}).join('\n'):'No NPC exchange open.';
    const workflow=object(s.workflow);this.host.querySelector<HTMLElement>('#workflow-state')!.textContent=workflow.running===true?`${text(workflow.name)} · step ${number(workflow.step)??0} / ${number(workflow.total)??0} · ${text(workflow.reason)}`:text(workflow.reason)||'No workflow running.';
    const routine=object(s.routine);this.host.querySelector<HTMLElement>('#routine-state')!.textContent=text(routine.reason)||'No routine running.';
  }
}
