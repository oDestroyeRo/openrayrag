import { describe, expect, it } from 'vitest';
import {
  actorId, itemId, bagId, skillId, speciesId, dropId, partyId, partyMemberId,
  quantity, percentage, seconds, minutes, milliseconds, revision, revisionFor, incarnation, worldId, mapCode, regularItemBagId,
  addQuantities, subtractQuantities, incrementRevision, secondsToMilliseconds,
  millisecondsToSeconds, minutesToMilliseconds, addMilliseconds, DomainValueError,
  type ActorId, type ItemId, type BagId, type SkillId, type Quantity,
  type Percentage, type Seconds, type Milliseconds, type Revision,
} from './domain-values';

// Compiled by the ordinary project tsc gate; this function is deliberately not run.
function incompatibleDomains(actor: ActorId, item: ItemId, bag: BagId, skill: SkillId, count: Quantity, percent: Percentage, duration: Seconds, elapsed: Milliseconds, version: Revision): void {
  const acceptsActor = (_: ActorId) => undefined;
  const acceptsItem = (_: ItemId) => undefined;
  const acceptsQuantity = (_: Quantity) => undefined;
  acceptsActor(actor); acceptsItem(item); acceptsQuantity(count);
  // @ts-expect-error Plain numbers have not crossed validation.
  acceptsActor(1);
  // @ts-expect-error Catalog identity is not actor identity.
  acceptsActor(item);
  // @ts-expect-error Bag identity is not catalog identity.
  acceptsItem(bag);
  // @ts-expect-error Skill identity is not item identity.
  acceptsItem(skill);
  // @ts-expect-error Percentages and counts have different meanings.
  acceptsQuantity(percent);
  // @ts-expect-error Unit conversions require seconds, not milliseconds.
  secondsToMilliseconds(elapsed);
  // @ts-expect-error Minute budgets must use their own explicit conversion.
  minutesToMilliseconds(duration);
  // @ts-expect-error A revision is not a clock duration.
  addMilliseconds(elapsed, version);
  // @ts-expect-error Raw arithmetic loses the validation proof.
  acceptsQuantity(count + count);
  // @ts-expect-error Raw unit arithmetic must be revalidated.
  addMilliseconds(elapsed, duration * 1000);
  const acceptsInventoryRevision = (_: Revision<'inventory'>) => undefined;
  acceptsInventoryRevision(incrementRevision(revisionFor('inventory', 0)));
  // @ts-expect-error Resource revision channels must not be interchangeable.
  acceptsInventoryRevision(revisionFor('equipment', 0));
  // @ts-expect-error An unscoped revision is not evidence for any resource channel.
  acceptsInventoryRevision(version);
}
void incompatibleDomains;

describe('validated domain values', () => {
  it('preserves primitive wire values and keeps field-specific sentinels outside IDs', () => {
    expect(actorId(0)).toBe(0);
    for (const construct of [itemId, bagId, speciesId, dropId, partyId, partyMemberId]) {
      expect(construct(1)).toBe(1);
      expect(construct(0x7fffffff)).toBe(0x7fffffff);
      for (const value of [-1, 0, 1.5, 0x80000000, '1', null, NaN, Infinity]) expect(() => construct(value)).toThrow(DomainValueError);
    }
    expect(skillId(32767)).toBe(32767);
    expect(() => skillId(32768)).toThrow(DomainValueError);
    expect(regularItemBagId(itemId(501))).toBe(501);
    expect(JSON.stringify({ actor: actorId(0), item: itemId(501), count: quantity(3), percent: percentage(12.5) }))
      .toBe('{"actor":0,"item":501,"count":3,"percent":12.5}');
  });

  it('validates aggregate quantities, percentages and revision boundaries', () => {
    for (const construct of [quantity, revision]) {
      expect(construct(0)).toBe(0);
      expect(construct(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
      for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity]) expect(() => construct(value)).toThrow(DomainValueError);
    }
    expect(percentage(0)).toBe(0); expect(percentage(100)).toBe(100); expect(percentage(0.5)).toBe(0.5);
    for (const value of [-0.1, 100.1, NaN, Infinity]) expect(() => percentage(value)).toThrow(DomainValueError);
  });

  it('preserves world spelling and separates map absence from validated identity', () => {
    const mixed = 'ABCDEF00-0123-4567-89ab-0123456789ab';
    expect(worldId(mixed)).toBe(mixed);
    expect(mapCode('prt_fild08')).toBe('prt_fild08');
    expect(incarnation(1)).toBe(1);
    expect(() => incarnation(0)).toThrow(DomainValueError);
    for (const invalid of ['', 'prt/fild08', 'x'.repeat(65), null]) expect(() => mapCode(invalid)).toThrow(DomainValueError);
    for (const invalid of ['', 'not-a-world', mixed + ' ', null]) expect(() => worldId(invalid)).toThrow(DomainValueError);
    expect(incrementRevision(revisionFor('inventory', 1))).toBe(2);
  });

  it('revalidates arithmetic instead of retaining an invalid brand', () => {
    expect(addQuantities(quantity(2), quantity(3))).toBe(5);
    expect(subtractQuantities(quantity(5), quantity(3))).toBe(2);
    expect(incrementRevision(revision(0))).toBe(1);
    expect(() => subtractQuantities(quantity(0), quantity(1))).toThrow(DomainValueError);
    expect(() => addQuantities(quantity(Number.MAX_SAFE_INTEGER), quantity(1))).toThrow(DomainValueError);
    expect(() => incrementRevision(revision(Number.MAX_SAFE_INTEGER))).toThrow(DomainValueError);
  });

  it('retains signed fractional wire timing and checks conversion overflow', () => {
    expect(secondsToMilliseconds(seconds(-0.125))).toBe(-125);
    expect(millisecondsToSeconds(milliseconds(125))).toBe(0.125);
    expect(minutesToMilliseconds(minutes(1.5))).toBe(90000);
    expect(addMilliseconds(milliseconds(1.5), milliseconds(0.5))).toBe(2);
    for (const construct of [seconds, minutes, milliseconds]) for (const value of [NaN, Infinity, -Infinity, '1']) expect(() => construct(value)).toThrow(DomainValueError);
    expect(() => secondsToMilliseconds(seconds(Number.MAX_VALUE))).toThrow(DomainValueError);
    expect(() => minutesToMilliseconds(minutes(Number.MAX_VALUE))).toThrow(DomainValueError);
    expect(() => addMilliseconds(milliseconds(Number.MAX_VALUE), milliseconds(Number.MAX_VALUE))).toThrow(DomainValueError);
  });

  it('returns typed payload-free causes with compatible boundary labels', () => {
    try { actorId('sensitive-input', 'target ID'); throw new Error('Expected validation failure'); }
    catch (error) {
      expect(error).toBeInstanceOf(DomainValueError);
      expect(error).toMatchObject({ domain: 'ActorId', issue: 'type', message: 'Invalid target ID' });
      expect(JSON.stringify(error)).not.toContain('sensitive-input');
    }
  });
});
