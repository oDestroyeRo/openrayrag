import { allPass } from 'remeda';
import type { WalkGrid } from './navigation-logic';
import type { Entity } from './protocol';
import type { Settings } from './settings';
/** Bind a new request to an explicit field identity without replacing targets. */
export function settingsWithFieldMap(input:Settings):Settings {
  return {...input,map:input.automation?.mapPolicy?.lockArea?.map??input.map};
}

export interface FieldStartState {
  native:boolean;fresh:boolean;busy:boolean;stopping:boolean;loginBusy:boolean;runActive:boolean;
  connected:boolean;compatible:boolean;map:string;player:Pick<Entity,'kind'|'x'|'y'|'dead'>|null;settings:Settings|null;
}
const fieldReady = allPass<FieldStartState>([
  s => s.native, s => s.fresh, s => !s.busy, s => !s.stopping, s => !s.loginBusy,
  s => !s.runActive, s => s.connected, s => s.compatible,
]);

/** UI admission uses physical ground, not the previous run's field mask.
 * The controller still owns final action receipts, HP, map return and area entry.
 */
export function canStartField(s:FieldStartState,gridFor:(map:string)=>WalkGrid|null):boolean {
  if(!fieldReady(s)||!s.settings||!s.player||s.player.kind!==0)return false;
  if(!Number.isFinite(s.player.x)||!Number.isFinite(s.player.y))return false;
  const physical=gridFor(s.map);if(!physical)return false;
  if(s.player.dead)return s.settings.automation?.respawn.enabled===true;
  return physical.walkable({x:Math.floor(s.player.x),y:Math.floor(s.player.y)});
}
