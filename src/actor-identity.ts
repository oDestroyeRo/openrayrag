/** Actor IDs are allocated signed-int32 values including zero. Local absence
 * is null; wire sentinels belong to their individual fields. */
export function actorId(value: unknown, label = 'actor ID'): number {
  if(typeof value!=='number'||!Number.isInteger(value)||value<0||value>0x7fffffff)throw new Error(`Invalid ${label}`);
  return value;
}
export function optionalWireActorId(value: number): number {return value===-1?-1:actorId(value);}
export interface ActionIdentity {world:string;selfId:number;selfIncarnation:number;targetId?:number;targetIncarnation?:number}
export function sameActionIdentity(a:ActionIdentity|null|undefined,b:ActionIdentity|null|undefined):boolean {
  return !!a&&!!b&&a.world===b.world&&a.selfId===b.selfId&&a.selfIncarnation===b.selfIncarnation&&a.targetId===b.targetId&&a.targetIncarnation===b.targetIncarnation;
}
