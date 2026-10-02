import type {ActionIdentity} from './actor-identity';
import {attackDistance} from './combat';
import {minimumRouteCost, type GridNavigator} from './navigation';
import type {Position} from './protocol';
import type {RetreatSettings} from './settings';

export interface RetreatEntry {identity:ActionIdentity;since:number;progress:number;accepted:boolean;attempts:number}
const key=(identity:ActionIdentity)=>`${identity.world}:${identity.targetId}:${identity.targetIncarnation}`;
/** No live entry is evicted: Stop/Start and switching targets cannot refill budgets. */
export class RetreatLedger {
  private readonly entries=new Map<string,RetreatEntry>();
  dispatch(identity:ActionIdentity,now:number):RetreatEntry|null {
    const id=key(identity);let entry=this.entries.get(id);
    if(!entry){if(this.entries.size>=300)return null;entry={identity:{...identity},since:now,progress:now,accepted:false,attempts:0};this.entries.set(id,entry);}
    entry.identity={...identity};entry.accepted=false;return entry;
  }
  get(identity:ActionIdentity):RetreatEntry|null {return this.entries.get(key(identity))??null;}
  remove(id:number):void {for(const [key,entry]of this.entries)if(entry.identity.targetId===id)this.entries.delete(key);}
  clear():void {this.entries.clear();}
}
export interface RetreatPlan {destination:Position;cells:Position[];cost:number}
/** Enumerate at most 841 cheap coordinates, inspect the first 128 candidates
 * for safe ground/sight, and plan at most 32 valid firing candidates.
 * Candidate ties: movement lower bound, greater separation, y then x. Final
 * selection uses verified 10/14 movement cost, greater separation, y then x.
 * This is a bounded local policy, not an exhaustive global escape optimizer. */
export function planRetreat(nav:GridNavigator,from:Position,target:Position,range:number,policy:RetreatSettings,remaining=policy.maxPathSteps):RetreatPlan|null {
  const candidates:Array<{position:Position;separation:number;bound:number}>=[];
  const separation=attackDistance(from,target);
  // The verified range is capped at 14: at most 841 cheap integer coordinates.
  for(let y=target.y-range;y<=target.y+range;y++)for(let x=target.x-range;x<=target.x+range;x++){
    const position={x,y},away=attackDistance(position,target);
    if(away<=separation||away<policy.desiredDistance||away>range||Math.max(Math.abs(x-from.x),Math.abs(y-from.y))>remaining)continue;
    candidates.push({position,separation:away,bound:minimumRouteCost(from,position,0)});
  }
  candidates.sort((a,b)=>a.bound-b.bound||b.separation-a.separation||a.position.y-b.position.y||a.position.x-b.position.x);
  const checked=candidates.slice(0,128).filter(candidate=>nav.safe(candidate.position)&&nav.canAttack(candidate.position,target,range));
  let best:(RetreatPlan&{separation:number})|null=null;
  for(const candidate of checked.slice(0,32)){
    const cells=nav.plan(from,candidate.position,{range:0,maxDistance:remaining,avoidWalls:true});
    if(!cells||cells.length<2||!nav.validRoute(cells))continue;
    const cost=cells.reduce((sum,p,i)=>sum+(i?(p.x!==cells[i-1]!.x&&p.y!==cells[i-1]!.y?14:10):0),0);
    if(!best||cost<best.cost||cost===best.cost&&(candidate.separation>best.separation||candidate.separation===best.separation&&(candidate.position.y<best.destination.y||candidate.position.y===best.destination.y&&candidate.position.x<best.destination.x)))best={destination:candidate.position,cells,cost,separation:candidate.separation};
  }
  return best?{destination:best.destination,cells:best.cells,cost:best.cost}:null;
}
export interface RetreatSnapshot {state:'off'|'watching'|'stopping'|'walking'|'waiting'|'resumed'|'skipped';reason:string;targetId:number|null;attempts:number;destination:Position|null;settling:boolean}
export const IDLE_RETREAT:RetreatSnapshot={state:'off',reason:'Normal attack retreat is off.',targetId:null,attempts:0,destination:null,settling:false};
export interface RetreatTask {identity:ActionIdentity;entry:RetreatEntry;targetPosition:Position;destination:Position;cells:Position[];phase:'stopping'|'walking'|'cancelled';cleared:boolean;walkPending:boolean;walkSent:boolean;stopRetried:boolean;steps:number;since:number;movementSince:number|null;reason:string;unsentRemoval?:{id:number;name:string;map:string;world:string;incarnation:number;reason:0|1};unsentArrival?:{id:number;name:string;map:string;entry:1|2}}
