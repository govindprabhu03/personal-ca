// Tiny date helpers on plain "YYYY-MM-DD[THH:mm:ss]" strings. No timezone maths: the user lives in one timezone.
export const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const todayStr = () => ymd(new Date());
export const nowStr = () => {
  const d = new Date();
  return `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
export const monthOf = (d: string) => d.slice(0, 7);
export const daysInMonth = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};
export const lastDayOf = (month: string) => `${month}-${pad(daysInMonth(month))}`;
export const addDays = (d: string, n: number) => {
  const [y, m, dd] = d.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, dd + n)).toISOString().slice(0, 10);
};
export const monthsBack = (month: string, n: number) => {
  let [y, m] = month.split('-').map(Number);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    m--;
    if (m === 0) { m = 12; y--; }
    out.push(`${y}-${pad(m)}`);
  }
  return out;
};
export const nextMonth = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`;
};
/** The "as of" day for a month: today if it is the current month, otherwise its last day. */
export const asOfFor = (month: string, today: string) => (month === monthOf(today) ? today : lastDayOf(month));
/** Whole days from b to a (a - b), for "YYYY-MM-DD" strings. */
export const dayDiff = (a: string, b: string) => {
  const t = (d: string) => { const [y, m, dd] = d.slice(0, 10).split('-').map(Number); return Date.UTC(y, m - 1, dd); };
  return Math.round((t(a) - t(b)) / 86400000);
};
export const addHoursStr = (iso: string, h: number) => {
  const d = new Date(new Date(iso).getTime() + h * 3600000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
export const hourOf = (iso: string) => Number(iso.slice(11, 13));
export { isLateHour } from '../time'; // 11 pm - 4 am (shared: the phone needs it too)
export const minutesBetween = (a: string, b: string) => Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 60000;

