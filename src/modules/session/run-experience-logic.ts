/** Confirmed wire deltas, independent of the character's current level totals. */
export interface ExperienceGains {
  readonly baseGained: number | null;
  readonly jobGained: number | null;
}

/** A runtime run and publication cursor; repeated snapshots are not rewards. */
export interface RunExperience extends ExperienceGains {
  readonly character: string;
  readonly run: number;
  readonly revision: number;
}

const signedInteger = (value: unknown): value is number => Number.isSafeInteger(value);
function gainsFields(value: unknown): value is ExperienceGains {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const gains = value as ExperienceGains;
  return (gains.baseGained === null || signedInteger(gains.baseGained))
    && (gains.jobGained === null || signedInteger(gains.jobGained));
}
export function validExperienceGains(value: unknown): value is ExperienceGains {
  return gainsFields(value) && Object.keys(value).length === 2;
}
export function validRunExperience(value: unknown): value is RunExperience {
  if (!gainsFields(value) || Object.keys(value).length !== 5) return false;
  const run = value as RunExperience;
  return typeof run.character === 'string' && run.character.length > 0 && run.character.length <= 64 && !/[\u0000-\u001f\u007f]/.test(run.character)
    && signedInteger(run.run) && run.run > 0 && signedInteger(run.revision) && run.revision >= 0;
}

function add(observed: number | null, delta: number | null): number | null {
  if (observed === null || delta === null) return null;
  const result = observed + delta;
  return signedInteger(result) ? result : null;
}
export function addExperience(gains: ExperienceGains, delta: ExperienceGains): ExperienceGains {
  return { baseGained: add(gains.baseGained, delta.baseGained), jobGained: add(gains.jobGained, delta.jobGained) };
}
export function experienceDifference(current: ExperienceGains, previous: ExperienceGains): ExperienceGains {
  return addExperience(current, { baseGained: previous.baseGained === null ? null : -previous.baseGained,
    jobGained: previous.jobGained === null ? null : -previous.jobGained });
}
export function signedExperience(value: unknown): string {
  return signedInteger(value) ? `${value >= 0 ? '+' : ''}${value.toLocaleString()}` : '—';
}
