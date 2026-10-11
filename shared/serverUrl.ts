// The address a phone is given for its server. People type it every way, so tidy it into one origin.
//   "192.168.0.150"                 -> "http://192.168.0.150:8787"   (the home PC program listens on 8787)
//   "https://my-app.vercel.app/api" -> "https://my-app.vercel.app"   (a hosted server has its own port; paths are dropped)
export function normaliseUrl(input: string): string {
  let u = input.trim();
  if (!u) return '';
  const secure = /^https:\/\//i.test(u);
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`;
  u = u.match(/^https?:\/\/[^/\s?#]+/i)?.[0] ?? u;
  if (!secure && !/:\d+$/.test(u.replace(/^https?:\/\//i, ''))) u += ':8787';
  return u;
}
