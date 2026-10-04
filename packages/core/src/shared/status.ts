import type { LiveStatus } from './types.ts';

/**
 * AoE 1.17.2 status enum (src/session/instance/status.rs):
 * Running, Waiting, Idle, Unknown, Stopped, Error, Starting, Deleting, Creating.
 */
export function normalizeAoeStatus(raw: string | null | undefined): LiveStatus {
  switch ((raw ?? '').toLowerCase()) {
    case 'running':
    case 'starting':
    case 'creating':
      return 'working';
    case 'waiting':
      return 'waiting';
    case 'idle':
      return 'idle';
    case 'error':
      return 'error';
    case 'stopped':
      return 'stopped';
    default:
      return 'unknown';
  }
}

export const LIVE_STATUS_LABEL: Record<LiveStatus | 'missing', string> = {
  working: 'Working',
  waiting: 'Waiting on you',
  idle: 'Idle',
  error: 'Error',
  stopped: 'Stopped',
  unknown: 'Unknown',
  missing: 'Session missing',
};
