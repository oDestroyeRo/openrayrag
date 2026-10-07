/** Validated scalar domains. Raw wire/JSON DTOs remain at their boundary owners. */
import { fail, flatMap, map, match, succeed, type Result } from 'effect/Result';

declare const domainValue: unique symbol;
declare const revisionChannel: unique symbol;
type Value<Name extends string> = number & { readonly [domainValue]: Name };
type TextValue<Name extends string> = string & { readonly [domainValue]: Name };

export type ActorId = Value<'ActorId'>;
export type ItemId = Value<'ItemId'>;
export type BagId = Value<'BagId'>;
export type SkillId = Value<'SkillId'>;
export type SpeciesId = Value<'SpeciesId'>;
export type DropId = Value<'DropId'>;
export type PartyId = Value<'PartyId'>;
export type PartyMemberId = Value<'PartyMemberId'>;
export type Incarnation = Value<'Incarnation'>;
export type WorldId = TextValue<'WorldId'>;
export type MapCode = TextValue<'MapCode'>;
export type Quantity = Value<'Quantity'>;
export type Percentage = Value<'Percentage'>;
/** Signed finite dimensions: wire deltas can be negative; duration policies add bounds. */
export type Seconds = Value<'Seconds'>;
export type Minutes = Value<'Minutes'>;
export type Milliseconds = Value<'Milliseconds'>;
export type Revision<Channel extends string = 'unscoped'> = Value<'Revision'> & {
  readonly [revisionChannel]: Channel;
};

export type DomainValueIssue = 'type' | 'non-finite' | 'integer' | 'range';
export class DomainValueError extends Error {
  constructor(
    readonly domain: string,
    readonly issue: DomainValueIssue,
    label: string,
  ) {
    super(`Invalid ${label}`);
    this.name = 'DomainValueError';
  }
}

function finite(value: unknown, domain: string, label: string): Result<number, DomainValueError> {
  if (typeof value !== 'number') return fail(new DomainValueError(domain, 'type', label));
  return Number.isFinite(value)
    ? succeed(value)
    : fail(new DomainValueError(domain, 'non-finite', label));
}

function bounded<Name extends string>(
  value: unknown,
  domain: Name,
  label: string,
  minimum: number,
  maximum: number,
  integer = true,
): Value<Name> {
  const admitted = flatMap(finite(value, domain, label), (result) => {
    if (integer && !Number.isInteger(result))
      return fail(new DomainValueError(domain, 'integer', label));
    return result < minimum || result > maximum
      ? fail(new DomainValueError(domain, 'range', label))
      : succeed(result);
  });
  return match(
    map(admitted, (result) => {
      // Numeric construction seam: every caller supplies its domain's bounds.
      return result as Value<Name>;
    }),
    {
      onFailure: (error) => {
        throw error;
      },
      onSuccess: (result) => result,
    },
  );
}

export const actorId = (value: unknown, label = 'actor ID'): ActorId =>
  bounded(value, 'ActorId', label, 0, 0x7fffffff);
export const itemId = (value: unknown, label = 'item ID'): ItemId =>
  bounded(value, 'ItemId', label, 1, 0x7fffffff);
export const bagId = (value: unknown, label = 'bag ID'): BagId =>
  bounded(value, 'BagId', label, 1, 0x7fffffff);
/** Learned and self-action IDs; byte-sized actions retain their narrower boundary check. */
export const skillId = (value: unknown, label = 'skill ID'): SkillId =>
  bounded(value, 'SkillId', label, 1, 32767);
export const speciesId = (value: unknown, label = 'species ID'): SpeciesId =>
  bounded(value, 'SpeciesId', label, 1, 0x7fffffff);
export const dropId = (value: unknown, label = 'drop ID'): DropId =>
  bounded(value, 'DropId', label, 1, 0x7fffffff);
export const partyId = (value: unknown, label = 'party ID'): PartyId =>
  bounded(value, 'PartyId', label, 1, 0x7fffffff);
export const partyMemberId = (value: unknown, label = 'party member ID'): PartyMemberId =>
  bounded(value, 'PartyMemberId', label, 1, 0x7fffffff);
export const incarnation = (value: unknown, label = 'incarnation'): Incarnation =>
  bounded(value, 'Incarnation', label, 1, 0x7fffffff);

function textValue<Name extends string>(
  value: unknown,
  domain: Name,
  label: string,
  pattern: RegExp,
): TextValue<Name> {
  const text =
    typeof value === 'string' ? succeed(value) : fail(new DomainValueError(domain, 'type', label));
  const admitted = flatMap(text, (result) =>
    pattern.test(result) ? succeed(result) : fail(new DomainValueError(domain, 'range', label)),
  );
  return match(
    map(admitted, (result) => result as TextValue<Name>),
    {
      onFailure: (error) => {
        throw error;
      },
      onSuccess: (result) => result,
    },
  );
}
/** Preserve spelling; owners requiring lowercase keep that narrower admission policy. */
export const worldId = (value: unknown, label = 'world ID'): WorldId =>
  textValue(
    value,
    'WorldId',
    label,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  );
/** Configured absence is the separate empty-string state, not a map code. */
export const mapCode = (value: unknown, label = 'map code'): MapCode =>
  textValue(value, 'MapCode', label, /^[a-zA-Z0-9_-]{1,64}$/);
/** Aggregate quantities; stack, transfer and configured stock bounds belong to their schemas. */
export const quantity = (value: unknown, label = 'quantity'): Quantity =>
  bounded(value, 'Quantity', label, 0, Number.MAX_SAFE_INTEGER);
export const percentage = (value: unknown, label = 'percentage'): Percentage =>
  bounded(value, 'Percentage', label, 0, 100, false);
export const seconds = (value: unknown, label = 'seconds'): Seconds =>
  bounded(value, 'Seconds', label, -Number.MAX_VALUE, Number.MAX_VALUE, false);
export const minutes = (value: unknown, label = 'minutes'): Minutes =>
  bounded(value, 'Minutes', label, -Number.MAX_VALUE, Number.MAX_VALUE, false);
export const milliseconds = (value: unknown, label = 'milliseconds'): Milliseconds =>
  bounded(value, 'Milliseconds', label, -Number.MAX_VALUE, Number.MAX_VALUE, false);
export function revisionFor<const Channel extends string>(
  _channel: Channel,
  value: unknown,
  label = 'revision',
): Revision<Channel> {
  return bounded(value, 'Revision', label, 0, Number.MAX_SAFE_INTEGER) as Revision<Channel>;
}
export const revision = (value: unknown, label = 'revision'): Revision =>
  revisionFor('unscoped', value, label);

/** Regular inventory uses the item's catalog ID as its bag key by protocol contract. */
export const regularItemBagId = (value: ItemId): BagId => bagId(value);
export const addQuantities = (left: Quantity, right: Quantity): Quantity => quantity(left + right);
export const subtractQuantities = (left: Quantity, right: Quantity): Quantity =>
  quantity(left - right);
export function incrementRevision<Channel extends string>(
  value: Revision<Channel>,
): Revision<Channel> {
  return bounded(
    value + 1,
    'Revision',
    'revision',
    0,
    Number.MAX_SAFE_INTEGER,
  ) as Revision<Channel>;
}
export const secondsToMilliseconds = (value: Seconds): Milliseconds => milliseconds(value * 1000);
export const minutesToMilliseconds = (value: Minutes): Milliseconds => milliseconds(value * 60000);
export const millisecondsToSeconds = (value: Milliseconds): Seconds => seconds(value / 1000);
export const addMilliseconds = (left: Milliseconds, right: Milliseconds): Milliseconds =>
  milliseconds(left + right);
