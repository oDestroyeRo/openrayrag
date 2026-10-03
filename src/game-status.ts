import type { Snapshot } from './engine';
import type { EscapeSnapshot } from './escape';
import type { LoginStatus } from './login';
import { validMapInfo, type MapInfo } from './map-data';
import { validNavigationStatus } from './navigation-status';
import { validFeatureStatus } from './feature-ui';

export type GameStatus = Snapshot & { sessionId: string; login: LoginStatus; mapInfo: MapInfo; runRequested?: boolean; state?: 'running' | 'waiting' | 'idle'; reconnectAvailable: boolean; escape?: EscapeSnapshot; macro?:import('./macros').MacroSnapshot; supplyGuard?:import('./supply-trip').SupplyResumeGuard; deathRecoveryGuard?:import('./death-recovery').DeathRecoveryGuard };

export function validStatus(value: unknown): value is GameStatus {
  if (!value || typeof value !== 'object') return false;
  const s = value as Record<string, unknown>;
  if (typeof s.reconnectAvailable !== 'boolean') return false;
  if (typeof s.sessionId !== 'string' || !s.sessionId || s.sessionId.length > 64) return false;
  const login = s.login as Partial<LoginStatus> | undefined;
  if (!login || typeof login.message !== 'string' || login.message.length > 1024
    || !['idle','signingIn','selecting','entering','complete','failed','cancelled'].includes(login.phase ?? '')) return false;
  const finite = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  const entity = (v: unknown) => {
    if (!v || typeof v !== 'object') return false;
    const e = v as Record<string, unknown>;
    return Number.isInteger(e.id)&&Number(e.id)>=0&&Number(e.id)<=0x7fffffff&&['id','classId','kind','level','hp','maxHp','x','y'].every(k => finite(e[k])) && typeof e.name === 'string' && e.name.length <= 512;
  };
  if (!validNavigationStatus(s.navigation)) return false;
  if ((s.runRequested !== undefined && typeof s.runRequested !== 'boolean') || (s.state !== undefined && !['running','waiting','idle'].includes(s.state as string))) return false;
  return ['connected','compatible','running'].every(k => typeof s[k] === 'boolean')
    && ['reason','map','target'].every(k => typeof s[k] === 'string' && (s[k] as string).length <= 1024)
    && validMapInfo(s.mapInfo, s.map as string)
    && ['attacks','kills','looted'].every(k => finite(s[k]))
    && (s.player === null || entity(s.player) && (s.player as Record<string,unknown>).kind===0)
    && Array.isArray(s.monsters) && s.monsters.length <= 150 && s.monsters.every(entity)
    && Array.isArray(s.drops) && s.drops.length <= 150 && s.drops.every(v => v && ['id','x','y'].every(k => finite(v[k])))
    && Array.isArray(s.log) && s.log.length <= 50 && s.log.every(v => v && finite(v.at) && typeof v.text === 'string' && v.text.length < 1024)
    && validFeatureStatus(s);
}

/** Shared by the native heartbeat and its offline status-boundary proof. */
export function statusHeartbeatFresh(receivedAt: number, now: number): boolean {
  return receivedAt <= 0 || now - receivedAt <= 7000;
}
