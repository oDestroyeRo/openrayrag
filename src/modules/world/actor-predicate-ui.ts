import { map } from 'effect/Array';
import { actorSnapshotAt as snapshotAt, observedActorChoices, bindObservedActor } from './actor-predicate-ui-logic';
import { evaluateActorPredicate, type ActorObservationSnapshot, type ActorPredicate, type ActorSelector } from './actor-observations';
import { RESOURCE_OPERATORS, type ResourceOperator } from './actor-resources';
import { STATUS_CATALOG } from './actor-status-catalog';

// Observed actors are bound only when the user chooses the displayed lifetime.
// Imported references are retained verbatim until explicitly rebound.
export class ActorPredicateEditor {
  readonly root=document.createElement('details');
  private readonly rows=document.createElement('div');
  private readonly add=document.createElement('button');
  private readonly entries=new Map<HTMLElement,()=>ActorPredicate>();
  private specified=false;
  constructor(private readonly snapshot:()=>ActorObservationSnapshot|undefined, private readonly changed:()=>void, private readonly allowCandidate=false) {
    this.root.className='rule-editor actor-conditions';const title=document.createElement('summary');title.textContent='Actor conditions';
    const hint=document.createElement('p');hint.className='hint';hint.textContent='All conditions must match. Unknown states never match. HP/SP need a fresh resource observation within 15 seconds; SP is available only for you or a verified visible party member. Observed actor references expire when the actor leaves or the world changes; choose it again to rebind.';
    this.add.type='button';this.add.className='secondary compact';this.add.textContent='＋ Add actor condition';
    this.add.addEventListener('click',()=>{if(this.entries.size>=16)return;this.specified=true;this.row({field:'actorCasting',actor:{scope:'self'},operator:'eq',value:true});this.changed();});
    this.root.append(title,hint,this.rows,this.add);
  }
  write(conditions:ActorPredicate[]|undefined):void {this.specified=conditions!==undefined;this.rows.replaceChildren();this.entries.clear();for(const condition of conditions??[])this.row(condition);}
  read():ActorPredicate[]|undefined {return this.specified?[...this.entries.values()].map(read=>read()):undefined;}
  private select(label:string,options:Array<[string,string]>,value:string):HTMLSelectElement {
    const field=document.createElement('label');field.className='form-field';const title=document.createElement('span');title.textContent=label;
    const select=document.createElement('select');for(const [id,name] of options){const option=document.createElement('option');option.value=id;option.textContent=name;select.append(option);}select.value=value;field.append(title,select);return select;
  }
  private row(condition:ActorPredicate):void {
    const row=document.createElement('div');row.className='form-grid';let actor:ActorSelector=structuredClone(condition.actor);
    const scope=this.select('Actor',[['self','Your character'],['target','Current server target'],...(this.allowCandidate?[["candidate","Candidate monster"] as [string,string]]:[]),['actor','Observed actor']],actor.scope);
    const actors=this.select('Choose / rebind actor',[['','Choose a currently observed actor']], '');
    const type=this.select('Evidence',[['actorStatus','Status'],['actorCasting','Casting'],['actorHpPercent','Observed HP %'],['actorSpPercent','Own / party SP %']],condition.field);
    const statusOptions=map(STATUS_CATALOG,status=>[String(status.id),`${status.name} · ${status.id}`] as [string,string]);
    if(condition.field==='actorStatus'&&!STATUS_CATALOG.some(status=>status.id===condition.statusId))statusOptions.push([String(condition.statusId),`Unsupported status ${condition.statusId}`]);
    const status=this.select('Status',statusOptions,condition.field==='actorStatus'?String(condition.statusId):statusOptions[0]?.[0]??'1');
    const desired=this.select('Required state',[['true','Present / casting'],['false','Absent / idle']],String(condition.operator==='eq'?condition.value:!condition.value));
    const skillLabel=document.createElement('label');skillLabel.className='form-field';skillLabel.textContent='Casting skill · blank means any';
    const skill=document.createElement('input');skill.type='number';skill.min='1';skill.max='255';skill.setAttribute('list','skillId-catalog');skill.value=condition.field==='actorCasting'&&condition.skillId!==undefined?String(condition.skillId):'';skillLabel.append(skill);
    const comparison=this.select('Comparison',map(RESOURCE_OPERATORS,operator=>[operator,({lt:'<',lte:'≤',eq:'=',gte:'≥',gt:'>'})[operator]]),condition.field==='actorHpPercent'||condition.field==='actorSpPercent'?condition.operator:'lte');
    const percentLabel=document.createElement('label');percentLabel.className='form-field';percentLabel.textContent='Threshold %';
    const percent=document.createElement('input');percent.type='number';percent.min='0';percent.max='100';percent.step='any';percent.value=typeof condition.value==='number'?String(condition.value):'50';percentLabel.append(percent);
    const trace=document.createElement('p');trace.className='hint';
    const read=():ActorPredicate=>type.value==='actorHpPercent'||type.value==='actorSpPercent'?{field:type.value,actor:structuredClone(actor),operator:comparison.value as ResourceOperator,value:percent.value.trim()?Number(percent.value):NaN}:type.value==='actorStatus'?{field:'actorStatus',actor:structuredClone(actor),statusId:Number(status.value),operator:'eq',value:desired.value==='true'}:{field:'actorCasting',actor:structuredClone(actor),...(skill.value?{skillId:Number(skill.value)}:{}),operator:'eq',value:desired.value==='true'};
    const refresh=()=>{
      const snap=this.snapshot();actors.parentElement!.hidden=scope.value!=='actor';status.parentElement!.hidden=type.value!=='actorStatus';skillLabel.hidden=type.value!=='actorCasting';
      const resource=type.value==='actorHpPercent'||type.value==='actorSpPercent';desired.parentElement!.hidden=resource;comparison.parentElement!.hidden=!resource;percentLabel.hidden=!resource;
      actors.replaceChildren();const empty=document.createElement('option');empty.value='';empty.textContent=actor.scope==='actor'?`Bound to #${actor.id}; choose again to rebind`:'Choose a currently observed actor';actors.append(empty);
      for(const observed of observedActorChoices(snap)){const option=document.createElement('option');option.value=observed.value;option.textContent=observed.label;actors.append(option);}actors.value='';
      const result=evaluateActorPredicate(read(),snap);trace.textContent=`${result.state} · ${result.reason}`;
    };
    scope.addEventListener('change',()=>{if(scope.value==='self'||scope.value==='target'||scope.value==='candidate')actor={scope:scope.value};else if(actor.scope!=='actor')actor={scope:'actor',id:1,incarnation:1,world:'00000000-0000-0000-0000-000000000000'};refresh();this.changed();});
    actors.addEventListener('change',()=>{const selected=bindObservedActor(this.snapshot(),actors.value);if(selected)actor=selected;refresh();this.changed();});
    for(const input of [type,status,desired,skill,comparison,percent])input.addEventListener('input',()=>{refresh();this.changed();});
    const remove=document.createElement('button');remove.type='button';remove.className='text-button';remove.textContent='Remove condition';remove.addEventListener('click',()=>{this.entries.delete(row);row.remove();this.add.disabled=this.entries.size>=16;this.changed();});
    row.append(scope.parentElement!,actors.parentElement!,type.parentElement!,status.parentElement!,desired.parentElement!,skillLabel,comparison.parentElement!,percentLabel,trace,remove);this.entries.set(row,read);this.rows.append(row);row.addEventListener('focusin',refresh);refresh();this.add.disabled=this.entries.size>=16;
  }
}
/** Compatibility facade supplies the browser clock; the projection receives it explicitly. */
export function actorSnapshotAt(value: unknown, at = Date.now()): ActorObservationSnapshot | undefined {
  return snapshotAt(value, at);
}
