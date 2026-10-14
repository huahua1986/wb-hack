import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
const OPTIONS = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const AAD = Buffer.from('workbuddy-local-auth-gateway:v1');

export function normalizeUsername(username) {
  if (typeof username !== 'string') throw new Error('Invalid username');
  const value = username.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_.@-]{2,63}$/.test(value)) throw new Error('Username must contain 3-64 ASCII letters, digits, ., _, @, or -');
  return value;
}

export function validatePassword(password) {
  if (typeof password !== 'string' || [...password].length < 15 || Buffer.byteLength(password) > 1024 || /^\s+$/.test(password)) {
    throw new Error('Password must contain at least 15 Unicode characters and at most 1024 UTF-8 bytes');
  }
  if (/^(.)\1+$/u.test(password) || ['123456789012345', 'passwordpassword', 'qwertyuiopasdfgh'].includes(password.toLowerCase())) throw new Error('Choose a less predictable password');
}

export async function hashPassword(password) {
  validatePassword(password);
  const salt = randomBytes(16);
  const digest = await derive(password, salt, 32, OPTIONS);
  return ['scrypt', OPTIONS.N, OPTIONS.r, OPTIONS.p, salt.toString('hex'), digest.toString('hex')].join('$');
}

export async function verifyPassword(password, encoded) {
  if (typeof password !== 'string' || Buffer.byteLength(password) > 1024) return false;
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt' || parts[1] !== '32768' || parts[2] !== '8' || !['1', '3'].includes(parts[3])
    || !/^[a-f0-9]{32}$/.test(parts[4]) || !/^[a-f0-9]{64}$/.test(parts[5])) throw new Error('Invalid password record');
  // Existing p=1 records remain usable; new/reset passwords use p=3.
  const actual = await derive(password, Buffer.from(parts[4], 'hex'), 32, { ...OPTIONS, p: Number(parts[3]) });
  return timingSafeEqual(actual, Buffer.from(parts[5], 'hex'));
}

export const randomSecret = () => randomBytes(32).toString('base64url');
export const tokenHash = value => createHash('sha256').update(value).digest('hex');
export const newAccessToken = () => `wb_at_${randomSecret()}`;
export const newRefreshToken = () => `wb_rt_${randomSecret()}`;
export const isAccessToken = value => typeof value === 'string' && /^wb_at_[A-Za-z0-9_-]{43}$/.test(value);
export const isRefreshToken = value => typeof value === 'string' && /^wb_rt_[A-Za-z0-9_-]{43}$/.test(value);
export const isLoginState = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);

export function csrfToken(key, state, nonce) {
  return createHmac('sha256', key).update(`form\0${state}\0${nonce}`).digest('base64url');
}

export function constantEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function seal(key, value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
}

export function unseal(key, value) {
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length < 29) throw new Error('Invalid encrypted delivery');
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  decipher.setAAD(AAD);
  decipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'));
}
