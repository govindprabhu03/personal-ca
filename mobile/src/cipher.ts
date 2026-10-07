// Encryption at rest for everything the app keeps on the phone (cached screens + the offline outbox).
// AES-256-GCM: it hides the data AND notices tampering. Pure functions with the randomness injected, so it is unit-tested under Node.
import { gcm } from '@noble/ciphers/aes.js';
import { bytesToHex, bytesToUtf8, hexToBytes, utf8ToBytes } from '@noble/ciphers/utils.js';

const NONCE_BYTES = 12;

/** keyHex = 32 random bytes as 64 hex chars (kept in the OS keystore on a phone). Token = hex(nonce) + hex(ciphertext + auth tag). */
export function makeCipher(keyHex: string, randomBytes: (n: number) => Uint8Array) {
  const key = hexToBytes(keyHex);
  if (key.length !== 32) throw new Error('cipher key must be 32 bytes');
  return {
    encrypt(plain: string): string {
      const nonce = randomBytes(NONCE_BYTES); // a fresh nonce for every write: never reuse one with the same key
      return bytesToHex(nonce) + bytesToHex(gcm(key, nonce).encrypt(utf8ToBytes(plain)));
    },
    /** Throws if the token was modified or the key is wrong. */
    decrypt(token: string): string {
      const nonce = hexToBytes(token.slice(0, NONCE_BYTES * 2));
      return bytesToUtf8(gcm(key, nonce).decrypt(hexToBytes(token.slice(NONCE_BYTES * 2))));
    },
  };
}
