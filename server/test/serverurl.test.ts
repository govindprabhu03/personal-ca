import { describe, expect, it } from 'vitest';
import { normaliseUrl } from '../../shared/serverUrl';

describe('the server address the phone is given', () => {
  it.each([
    ['192.168.0.150', 'http://192.168.0.150:8787'],
    ['192.168.0.150:8787/', 'http://192.168.0.150:8787'],
    ['  http://pc.local  ', 'http://pc.local:8787'],
    ['http://192.168.0.150:9000', 'http://192.168.0.150:9000'],
    ['https://my-app.vercel.app', 'https://my-app.vercel.app'],
    ['HTTPS://My-App.vercel.app/', 'HTTPS://My-App.vercel.app'],
    ['https://my-app.vercel.app/api/health?x=1', 'https://my-app.vercel.app'],
    ['https://example.com:8443', 'https://example.com:8443'],
    ['my-app.vercel.app', 'http://my-app.vercel.app:8787'], // no scheme means plain http on the home port: hosted servers need the https:// typed
    ['', ''],
  ])('%s -> %s', (input, want) => { expect(normaliseUrl(input)).toBe(want); });
});
