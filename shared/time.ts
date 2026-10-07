// Small time helpers shared by the server and the phone. Times are local "YYYY-MM-DDTHH:mm:ss" strings (one timezone, no TZ maths).
export const isLateHour = (h: number) => h >= 23 || h < 4; // 11 pm - 4 am

const p2 = (n: number) => String(n).padStart(2, '0');
export const todayLocal = (d = new Date()) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
/** The moment a spend is LOGGED. An offline spend must carry this, or it would be stamped with whenever it happens to sync. */
export const nowLocal = (d = new Date()) => `${todayLocal(d)}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
