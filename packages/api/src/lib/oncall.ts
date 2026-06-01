// On-call rotation math. Works in "local minutes" within the schedule's
// timezone to avoid timestamp/timezone ambiguity: civil dates are converted to
// day counts (Howard Hinnant's algorithm) and the current wall-clock time in the
// schedule timezone is read via Intl.
import type { OnCallSchedule } from '@enlight/shared';

/** Days since 1970-01-01 for a civil (proleptic Gregorian) date. */
function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor((yy >= 0 ? yy : yy - 399) / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** Inverse of daysFromCivil → { y, m, d }. */
function civilFromDays(z: number): { y: number; m: number; d: number } {
  z += 719468;
  const era = Math.floor((z >= 0 ? z : z - 146096) / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return { y: m <= 2 ? y + 1 : y, m, d };
}

/** Current wall-clock minutes-since-epoch in a given IANA timezone. */
function nowLocalMinutes(now: Date, timezone: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(now);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
    const hour = get('hour') % 24; // '24' at midnight in some impls
    return daysFromCivil(get('year'), get('month'), get('day')) * 1440 + hour * 60 + get('minute');
  } catch {
    return Math.floor(now.getTime() / 60000); // UTC fallback
  }
}

function parseDate(s: string): { y: number; m: number; d: number } {
  const [y, m, d] = s.split('-').map(Number);
  return { y: y || 1970, m: m || 1, d: d || 1 };
}

function fmtLocalMinutes(totalMin: number): string {
  const days = Math.floor(totalMin / 1440);
  const minOfDay = totalMin - days * 1440;
  const { y, m, d } = civilFromDays(days);
  const hh = String(Math.floor(minOfDay / 60)).padStart(2, '0');
  const mm = String(minOfDay % 60).padStart(2, '0');
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')} ${hh}:${mm}`;
}

export interface OnCallNow {
  currentOnCallUserId: string | null;
  currentShiftEndsAt: string | null;
}

/** Resolves who is on call right now for a schedule, plus when the shift ends. */
export function computeOnCall(
  schedule: Pick<OnCallSchedule, 'timezone' | 'rotationDays' | 'handoffTime' | 'startDate' | 'participants'>,
  now: Date = new Date(),
): OnCallNow {
  const participants = Array.isArray(schedule.participants) ? schedule.participants : [];
  if (participants.length === 0) return { currentOnCallUserId: null, currentShiftEndsAt: null };

  const { y, m, d } = parseDate(schedule.startDate);
  const [hh, mm] = (schedule.handoffTime || '00:00').split(':').map(Number);
  const anchorMin = daysFromCivil(y, m, d) * 1440 + (hh || 0) * 60 + (mm || 0);
  const nowMin = nowLocalMinutes(now, schedule.timezone || 'UTC');
  const shiftLen = Math.max(1, schedule.rotationDays) * 1440;

  const elapsed = nowMin - anchorMin;
  if (elapsed < 0) {
    // Rotation hasn't started yet — first shift begins at the anchor.
    return { currentOnCallUserId: null, currentShiftEndsAt: fmtLocalMinutes(anchorMin) };
  }

  const shiftIndex = Math.floor(elapsed / shiftLen);
  const n = participants.length;
  const idx = ((shiftIndex % n) + n) % n;
  const endMin = anchorMin + (shiftIndex + 1) * shiftLen;
  return { currentOnCallUserId: participants[idx] ?? null, currentShiftEndsAt: fmtLocalMinutes(endMin) };
}
