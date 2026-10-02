import { searchGrid, type WalkGrid } from './navigation';
import type { Entity } from './protocol';
import type { Settings } from './settings';

/** Bind a new request to an explicit field identity without replacing targets. */
export function settingsWithFieldMap(input:Settings):Settings {
  return {...input,map:input.automation?.mapPolicy?.lockArea?.map??input.map};
}
interface FieldStartState {
  native:boolean;fresh:boolean;busy:boolean;stopping:boolean;loginBusy:boolean;runActive:boolean;
  connected:boolean;compatible:boolean;map:string;player:Pick<Entity,'kind'|'x'|'y'|'dead'>|null;settings:Settings|null;
}
/** UI admission uses physical ground, not the previous run's field mask.
 * The controller still owns final action receipts, HP, map return and area entry.
 */
export function canStartField(s:FieldStartState,gridFor:(map:string)=>WalkGrid|null=searchGrid):boolean {
  if(!s.native||!s.fresh||s.busy||s.stopping||s.loginBusy||s.runActive||!s.connected||!s.compatible||!s.settings||!s.player||s.player.kind!==0)return false;
  if(!Number.isFinite(s.player.x)||!Number.isFinite(s.player.y))return false;
  const physical=gridFor(s.map);if(!physical)return false;
  if(s.player.dead)return s.settings.automation?.respawn.enabled===true;
  return physical.walkable({x:Math.floor(s.player.x),y:Math.floor(s.player.y)});
}
