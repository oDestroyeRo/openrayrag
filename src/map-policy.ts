import type { ReadonlyData } from './settings';
import { GridNavigator } from './navigation';
import type { WalkGrid } from './navigation-logic';
import type { Position } from './protocol';

import { type MapPolicy, mapAllowed, insideLockArea } from './map-policy-logic';

export { type LockArea, type MapPolicy, DEFAULT_MAP_POLICY, PORTAL_COST, MAX_MAP_PENALTY, validateMapPolicy, mapPolicy, mapAllowed, insideLockArea, policyIdentity, policySummary, fieldGrid } from './map-policy-logic';

/** Collision-safe entry into any reachable safe cell, rather than a possibly blocked centre.
 * BFS is bounded by the physical grid; first entry is deterministic and uses no portal cells.
 */
export function lockEntry(map: string, origin: Position, grid: WalkGrid, policy: ReadonlyData<MapPolicy>): Position | null {
  if (!mapAllowed(policy,map) || policy.lockArea?.map !== map) return null;
  const nav = new GridNavigator(grid), from={x:Math.floor(origin.x),y:Math.floor(origin.y)};
  if (!nav.safe(from)) return null;
  const count=grid.width*grid.height, seen=new Uint8Array(count),queue=new Int32Array(count);
  const index=(p:Position)=>p.x+p.y*grid.width, point=(i:number)=>({x:i%grid.width,y:Math.floor(i/grid.width)});
  let tail=1;queue[0]=index(from);seen[queue[0]!]=1;
  const directions=[[0,1],[1,1],[1,0],[1,-1],[0,-1],[-1,-1],[-1,0],[-1,1]];
  for(let head=0;head<tail;head++){
    const p=point(queue[head]!);if(insideLockArea(policy,map,p))return p;
    for(const [dx,dy] of directions){const q={x:p.x+dx!,y:p.y+dy!};if(!nav.safe(q)||!nav.validRoute([p,q]))continue;const i=index(q);if(!seen[i]){seen[i]=1;queue[tail++]=i;}}
  }
  return null;
}
