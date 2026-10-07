// The few places where web and phone differ: confirm dialogs, saving/sharing text, picking a file.
import * as DocumentPicker from 'expo-document-picker';
import { Alert, Platform, Share } from 'react-native';

const g = globalThis as any;

export const confirmAsk = (title: string, msg: string) =>
  Platform.OS === 'web'
    ? Promise.resolve<boolean>(g.confirm(`${title}\n\n${msg}`))
    : new Promise<boolean>((res) =>
        Alert.alert(title, msg, [
          { text: 'Cancel', style: 'cancel', onPress: () => res(false) },
          { text: 'Yes', style: 'destructive', onPress: () => res(true) },
        ]));

export async function saveText(filename: string, text: string, mime = 'text/plain') {
  if (Platform.OS === 'web') {
    const a = g.document.createElement('a');
    a.href = g.URL.createObjectURL(new g.Blob([text], { type: mime }));
    a.download = filename;
    a.click();
    g.URL.revokeObjectURL(a.href);
  } else await Share.share({ message: text, title: filename });
}

export type StatementSource = { kind: 'csv'; text: string } | { kind: 'pdf'; base64: string };

const toBase64 = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const fr = new g.FileReader();
  fr.onload = () => resolve(String(fr.result).split(',')[1] ?? '');
  fr.onerror = () => reject(new Error('Could not read that file'));
  fr.readAsDataURL(blob);
});

/** Pick a bank statement: CSV is read as text, PDF as base64 (the server does the parsing, never the phone). */
export async function pickStatement(): Promise<StatementSource | null> {
  const r = await DocumentPicker.getDocumentAsync({ type: ['text/csv', 'text/comma-separated-values', 'application/pdf', 'text/plain', '*/*'], copyToCacheDirectory: true });
  if (r.canceled) return null;
  const a = r.assets[0] as DocumentPicker.DocumentPickerAsset & { file?: Blob };
  if (a.mimeType === 'application/pdf' || /\.pdf$/i.test(a.name)) return { kind: 'pdf', base64: await toBase64(a.file ?? (await (await fetch(a.uri)).blob())) };
  return { kind: 'csv', text: a.file ? await (a.file as Blob).text() : await (await fetch(a.uri)).text() };
}

export async function pickText(): Promise<string | null> {
  const r = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true });
  if (r.canceled) return null;
  const a = r.assets[0] as DocumentPicker.DocumentPickerAsset & { file?: { text(): Promise<string> } };
  return a.file ? a.file.text() : (await fetch(a.uri)).text();
}
