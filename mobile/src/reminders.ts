// Phone notifications for bills: one local notification per unpaid bill, `remind_days` before it is due, at 9 am.
// expo-notifications is loaded lazily so the web preview (and anyone who never opts in) never touches it.
import { Platform } from 'react-native';
import { formatRupees } from '../../shared/money';
import type { Bill } from '../../shared/types';

export const remindersSupported = Platform.OS !== 'web';

/** Lets a notification show as a banner even while the app is open (otherwise it would only appear when the app is closed). */
async function prepare(N: typeof import('expo-notifications')) {
  N.setNotificationHandler({ handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }) });
  if (Platform.OS === 'android') await N.setNotificationChannelAsync('bills', { name: 'Bill reminders', importance: N.AndroidImportance.HIGH });
}

/** For testing on a real phone: a notification about 10 seconds from now, so you needn't wait for a real due date. */
export async function testReminder(): Promise<'ok' | 'denied' | 'unsupported'> {
  if (!remindersSupported) return 'unsupported';
  try {
    const N = await import('expo-notifications');
    let perm = await N.getPermissionsAsync();
    if (!perm.granted) perm = await N.requestPermissionsAsync();
    if (!perm.granted) return 'denied';
    await prepare(N);
    await N.scheduleNotificationAsync({
      content: { title: '🧪 Test reminder', body: 'If you can see this, bill reminders work on this phone 💜' },
      trigger: { type: N.SchedulableTriggerInputTypes.TIME_INTERVAL, seconds: 10, channelId: 'bills' },
    });
    return 'ok';
  } catch { return 'unsupported'; }
}

/** Reschedules every reminder. `ask` = also request permission (only when the user taps "turn on"). Never throws. */
export async function syncReminders(bills: Bill[], ask = false): Promise<'ok' | 'denied' | 'unsupported'> {
  if (!remindersSupported) return 'unsupported';
  try {
    const N = await import('expo-notifications');
    let perm = await N.getPermissionsAsync();
    if (!perm.granted && ask) perm = await N.requestPermissionsAsync();
    if (!perm.granted) return 'denied';
    await prepare(N);
    await N.cancelAllScheduledNotificationsAsync();
    for (const b of bills) {
      const [y, m, d] = b.next_due.split('-').map(Number);
      const at = new Date(y, m - 1, d - b.remind_days, 9, 0, 0);
      if (at.getTime() <= Date.now()) continue; // already past: the in-app "Coming up" card covers it
      await N.scheduleNotificationAsync({
        content: { title: `${b.emoji} ${b.name} ${b.remind_days ? `is due in ${b.remind_days} day${b.remind_days > 1 ? 's' : ''}` : 'is due today'}`, body: `${formatRupees(b.amount_paise)}. Pay it before a late fee finds you 💜` },
        trigger: { type: N.SchedulableTriggerInputTypes.DATE, date: at, channelId: 'bills' },
      });
    }
    return 'ok';
  } catch { return 'unsupported'; }
}
