/** Actor IDs are allocated signed-int32 values including zero. Local absence
 * is null; wire sentinels belong to their individual fields. */
import {
  actorId,
  worldId,
  incarnation,
  type ActorId,
  type WorldId,
  type Incarnation,
} from '../../shared/domain-values';
export { actorId } from '../../shared/domain-values';
export function optionalWireActorId(value: number): ActorId | -1 {
  return value === -1 ? -1 : actorId(value);
}
export type ActionIdentityInput = Readonly<
  { world: string; selfId: number; selfIncarnation: number } & (
    | { targetId?: never; targetIncarnation?: never }
    | { targetId: number; targetIncarnation: number }
  )
>;
/** Zero self incarnation preserves the existing dead-self respawn fence. */
export type ActionIdentity = Readonly<
  { world: WorldId; selfId: ActorId; selfIncarnation: Incarnation | 0 } & (
    | { targetId?: never; targetIncarnation?: never }
    | { targetId: ActorId; targetIncarnation: Incarnation }
  )
>;
export function actionIdentity(
  value: Readonly<{
    world: string;
    selfId: number;
    selfIncarnation: number;
    targetId: number;
    targetIncarnation: number;
  }>,
): Extract<ActionIdentity, { targetId: ActorId }>;
export function actionIdentity(
  value: Readonly<{
    world: string;
    selfId: number;
    selfIncarnation: number;
    targetId?: never;
    targetIncarnation?: never;
  }>,
): Extract<ActionIdentity, { targetId?: never }>;
export function actionIdentity(value: ActionIdentityInput): ActionIdentity;
export function actionIdentity(value: ActionIdentityInput): ActionIdentity {
  const own = {
    world: worldId(value.world),
    selfId: actorId(value.selfId),
    selfIncarnation:
      value.selfIncarnation === 0 ? (0 as const) : incarnation(value.selfIncarnation),
  };
  return value.targetId === undefined
    ? own
    : {
        ...own,
        targetId: actorId(value.targetId),
        targetIncarnation: incarnation(value.targetIncarnation),
      };
}
export function sameActionIdentity(
  a: ActionIdentity | null | undefined,
  b: ActionIdentity | null | undefined,
): boolean {
  return (
    !!a &&
    !!b &&
    a.world === b.world &&
    a.selfId === b.selfId &&
    a.selfIncarnation === b.selfIncarnation &&
    a.targetId === b.targetId &&
    a.targetIncarnation === b.targetIncarnation
  );
}
