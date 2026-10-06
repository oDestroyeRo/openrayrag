import type { AutomationSettingsInput } from '../settings/settings';

export type RunLimitCause = 'minutes' | 'kills' | 'pickups' | 'deaths';

/** Original run allowances are explicit inputs; a wait never renews them. */
export function reachedRunLimit(input: {
  limits: AutomationSettingsInput['limits']; elapsedMilliseconds: number; kills: number; pickups: number;
  respawn?: AutomationSettingsInput['respawn']; deaths?: number;
}): RunLimitCause | null {
  if(input.limits.minutes>0&&input.elapsedMilliseconds>=input.limits.minutes*60_000)return 'minutes';
  if(input.limits.kills>0&&input.kills>=input.limits.kills)return 'kills';
  if(input.limits.pickups>0&&input.pickups>=input.limits.pickups)return 'pickups';
  if(input.respawn?.enabled&&(input.deaths??0)>input.respawn.maxDeaths)return 'deaths';
  return null;
}

export function runLimitReason(cause:RunLimitCause):string {
  const labels={minutes:'session time',kills:'monster',pickups:'pickup',deaths:'death'};
  return `Configured session limit reached: ${labels[cause]} limit. Press Stop to end this run, then review settings and press Start for a new run.`;
}

/** Native and browser boundaries accept only a closed cause, solely for Stop. */
export function controlStopReason(action:string,cause:unknown):string {
  if(cause===undefined||cause===null)return 'Stopped by you.';
  if(action!=='stop'||typeof cause!=='string'||!['minutes','kills','pickups','deaths'].includes(cause))
    throw new Error('A valid run limit cause is only accepted by Stop.');
  return runLimitReason(cause as RunLimitCause);
}
