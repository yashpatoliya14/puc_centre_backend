// Asia/Kolkata (IST = UTC+05:30) timezone-accurate date and calling window utilities.

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export interface IstParts {
  dateStr: string; // YYYY-MM-DD
  year: number;
  month: number;
  day: number;
  dayOfWeek: number; // 0 = Sun, 1 = Mon ... 6 = Sat
  hour: number;
  minute: number;
  minutesSinceMidnight: number;
}

export function getIstParts(date: Date = new Date()): IstParts {
  const istDate = new Date(date.getTime() + IST_OFFSET_MS);
  const year = istDate.getUTCFullYear();
  const month = istDate.getUTCMonth() + 1;
  const day = istDate.getUTCDate();
  const dayOfWeek = istDate.getUTCDay();
  const hour = istDate.getUTCHours();
  const minute = istDate.getUTCMinutes();
  const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return {
    dateStr,
    year,
    month,
    day,
    dayOfWeek,
    hour,
    minute,
    minutesSinceMidnight: hour * 60 + minute,
  };
}

export function getIstDateString(date: Date = new Date()): string {
  return getIstParts(date).dateStr;
}

export function addDaysToDateStr(dateStr: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec((dateStr || '').trim());
  if (!match) return dateStr;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const utc = Date.UTC(y, m - 1, d) + days * 24 * 60 * 60 * 1000;
  if (Number.isNaN(utc)) return dateStr;
  const result = new Date(utc);
  return `${result.getUTCFullYear()}-${String(result.getUTCMonth() + 1).padStart(2, '0')}-${String(
    result.getUTCDate(),
  ).padStart(2, '0')}`;
}

export function diffDays(fromDateStr: string, toDateStr: string): number {
  const m1Match = /^(\d{4})-(\d{2})-(\d{2})/.exec((fromDateStr || '').trim());
  const m2Match = /^(\d{4})-(\d{2})-(\d{2})/.exec((toDateStr || '').trim());
  if (!m1Match || !m2Match) return 0;
  const t1 = Date.UTC(Number(m1Match[1]), Number(m1Match[2]) - 1, Number(m1Match[3]));
  const t2 = Date.UTC(Number(m2Match[1]), Number(m2Match[2]) - 1, Number(m2Match[3]));
  return Math.round((t2 - t1) / (24 * 60 * 60 * 1000));
}

export function parseHHMM(timeStr: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(timeStr.trim());
  if (!match) return 10 * 60;
  const h = Math.min(23, Math.max(0, Number(match[1])));
  const m = Math.min(59, Math.max(0, Number(match[2])));
  return h * 60 + m;
}

export function isWithinCallingWindow(
  callingDays: number[],
  windowStart: string,
  windowEnd: string,
  now: Date = new Date(),
): boolean {
  const parts = getIstParts(now);
  if (!callingDays.includes(parts.dayOfWeek)) {
    return false;
  }
  const startMin = parseHHMM(windowStart);
  const endMin = parseHHMM(windowEnd);
  return parts.minutesSinceMidnight >= startMin && parts.minutesSinceMidnight <= endMin;
}

/**
 * Given a certificate expiry YYYY-MM-DD, an offsetDays (-7 before, 0 on expiry, +2 after),
 * and an IST call time HH:mm, returns the exact UTC ISO timestamp for that reminder in Asia/Kolkata.
 */
export function computeReminderScheduledIso(
  expiryDateStr: string,
  offsetDays: number,
  callTimeHHMM: string,
): string {
  const targetDateStr = addDaysToDateStr(expiryDateStr, offsetDays);
  const [y, m, d] = targetDateStr.split('-').map(Number);
  const mins = parseHHMM(callTimeHHMM);
  const hh = Math.floor(mins / 60);
  const mm = mins % 60;
  // Target IST time converted back to UTC by subtracting 5h30m
  const utcMs = Date.UTC(y, m - 1, d, hh, mm, 0) - IST_OFFSET_MS;
  return new Date(utcMs).toISOString();
}

export type DerivedCertificateStatus = 'active' | 'expiring_today' | 'expiring_soon' | 'expired' | 'renewed';

export function deriveCertificateStatus(
  expiryDateStr: string,
  cycleStatus: string,
  warningDays = 7,
  todayIst: string = getIstDateString(),
): { status: DerivedCertificateStatus; daysUntilExpiry: number } {
  const daysUntilExpiry = diffDays(todayIst, expiryDateStr);
  if (cycleStatus === 'renewed' || cycleStatus === 'superseded') {
    return { status: 'renewed', daysUntilExpiry };
  }
  if (daysUntilExpiry < 0) {
    return { status: 'expired', daysUntilExpiry };
  }
  if (daysUntilExpiry === 0) {
    return { status: 'expiring_today', daysUntilExpiry };
  }
  if (daysUntilExpiry <= warningDays) {
    return { status: 'expiring_soon', daysUntilExpiry };
  }
  return { status: 'active', daysUntilExpiry };
}

export function formatReadableDate(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!y || !m || !d) return dateStr;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${String(d).padStart(2, '0')} ${months[m - 1]} ${y}`;
}
