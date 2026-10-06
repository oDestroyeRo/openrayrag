import { allPass, map } from 'remeda';
import { DomainValueError } from '../../shared/domain-values';
import type { Snapshot } from '../automation/engine';
import type { EscapeSnapshot } from '../recovery/escape-logic';
import type { LoginStatus } from '../session/login-logic';
import { validMapInfo, type MapInfo } from '../navigation/map-data-logic';
import { validNavigationStatus } from '../navigation/navigation-status';
import { validFeatureStatus } from './feature-ui-logic';

export type GameStatus = Snapshot & { sessionId: string; login: LoginStatus; mapInfo: MapInfo; connectionMode?: 'botOnly' | 'gameClient'; runRequested?: boolean; state?: 'running' | 'waiting' | 'idle'; reconnectAvailable: boolean; escape?: EscapeSnapshot; macro?:import('../automation/macros').MacroSnapshot; supplyGuard?:import('../services/supply-trip').SupplyResumeGuard; deathRecoveryGuard?:import('../recovery/death-recovery').DeathRecoveryGuard };
declare const gameSessionValue: unique symbol;
export type GameSessionId = string & { readonly [gameSessionValue]: 'GameSessionId' };
/** Client session IDs retain the existing permissive nonempty, bounded string policy. */
export function gameSessionId(value: unknown): GameSessionId {
  if (typeof value !== 'string' || !value || value.length > 64) throw new DomainValueError('GameSessionId', 'range', 'game session ID');
  return value as GameSessionId;
}
export type ValidatedGameStatus = GameStatus & { readonly sessionId: GameSessionId };
function validGameSessionId(value: unknown): value is GameSessionId {
  try { gameSessionId(value); return true; } catch { return false; }
}

const finite = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value);
const fieldsMatch = (fields: readonly string[], valid: (value: unknown) => boolean) =>
  allPass(map(fields, field => (value: Record<string, unknown>) => valid(value[field])));
const entityNumbers = fieldsMatch(['id','classId','kind','level','hp','maxHp','x','y'], finite);
const statusFlags = fieldsMatch(['connected','compatible','running'], value => typeof value === 'boolean');
const statusText = fieldsMatch(['reason','map','target'], value => typeof value === 'string' && value.length <= 1024);
const statusCounts = fieldsMatch(['attacks','kills','looted'], finite);
const dropNumbers = fieldsMatch(['id','x','y'], finite);

export function validStatus(value: unknown): value is ValidatedGameStatus {
  if (!value || typeof value !== 'object') return false;
  const s = value as Record<string, unknown>;
  if (typeof s.reconnectAvailable !== 'boolean') return false;
  if (s.connectionMode !== undefined && s.connectionMode !== 'botOnly' && s.connectionMode !== 'gameClient') return false;
  if (!validGameSessionId(s.sessionId)) return false;
  const login = s.login as Partial<LoginStatus> | undefined;
  if (!login || typeof login.message !== 'string' || login.message.length > 1024
    || !['idle','signingIn','selecting','entering','complete','failed','cancelled'].includes(login.phase ?? '')) return false;
  const entity = (v: unknown) => {
    if (!v || typeof v !== 'object') return false;
    const e = v as Record<string, unknown>;
    return Number.isInteger(e.id)&&Number(e.id)>=0&&Number(e.id)<=0x7fffffff&&entityNumbers(e) && typeof e.name === 'string' && e.name.length <= 512;
  };
  if (!validNavigationStatus(s.navigation)) return false;
  if ((s.runRequested !== undefined && typeof s.runRequested !== 'boolean') || (s.state !== undefined && !['running','waiting','idle'].includes(s.state as string))) return false;
  return statusFlags(s)
    && statusText(s)
    && validMapInfo(s.mapInfo, s.map as string)
    && statusCounts(s)
    && (s.player === null || entity(s.player) && (s.player as Record<string,unknown>).kind===0)
    && Array.isArray(s.monsters) && s.monsters.length <= 150 && s.monsters.every(entity)
    && Array.isArray(s.drops) && s.drops.length <= 150 && s.drops.every(v => v && dropNumbers(v))
    && Array.isArray(s.log) && s.log.length <= 50 && s.log.every(v => v && finite(v.at) && typeof v.text === 'string' && v.text.length < 1024)
    && validFeatureStatus(s);
}

/** Shared by the native heartbeat and its offline status-boundary proof. */
export function statusHeartbeatFresh(receivedAt: number, now: number): boolean {
  return receivedAt <= 0 || now - receivedAt <= 7000;
}
