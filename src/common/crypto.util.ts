import * as crypto from 'crypto';

const EPHEMERAL_SESSION_KEY = crypto.randomBytes(32);
const EPHEMERAL_ENCRYPTION_KEY = crypto.randomBytes(32);

function getSessionSecret(): Buffer {
  const envSecret = process.env.SESSION_SIGNING_SECRET?.trim();
  if (envSecret && envSecret.length > 0) {
    return crypto.createHash('sha256').update(envSecret).digest();
  }
  return EPHEMERAL_SESSION_KEY;
}

function getEncryptionKey(): Buffer {
  const envKey = process.env.CREDENTIALS_ENCRYPTION_KEY?.trim();
  if (envKey && /^[0-9a-fA-F]{64}$/.test(envKey)) {
    return Buffer.from(envKey, 'hex');
  }
  if (envKey && envKey.length > 0) {
    return crypto.createHash('sha256').update(envKey).digest();
  }
  return EPHEMERAL_ENCRYPTION_KEY;
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${derived}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') {
    return false;
  }
  const [, salt, hexKey] = parts;
  const derived = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hexKey, 'hex');
  if (derived.length !== expected.length) {
    return false;
  }
  return crypto.timingSafeEqual(derived, expected);
}

export function encryptSecret(plaintext: string): string {
  if (!plaintext) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `gcm:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptSecret(ciphertext: string | null | undefined): string {
  if (!ciphertext) return '';
  const parts = ciphertext.split(':');
  if (parts.length !== 4 || parts[0] !== 'gcm') {
    return '';
  }
  try {
    const [, ivHex, tagHex, dataHex] = parts;
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      getEncryptionKey(),
      Buffer.from(ivHex, 'hex'),
    );
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(dataHex, 'hex')),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  } catch {
    return '';
  }
}

export function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export interface SessionTokenPayload {
  sid: string;
  uid: string;
  tid: string;
  exp: number;
  jti?: string;
}

export function signSessionToken(payload: SessionTokenPayload): string {
  const enriched: SessionTokenPayload = {
    ...payload,
    jti: payload.jti || crypto.randomBytes(32).toString('hex'),
  };
  const body = Buffer.from(JSON.stringify(enriched), 'utf8').toString('base64url');
  const sig = crypto
    .createHmac('sha256', getSessionSecret())
    .update(body)
    .digest('base64url');
  return `${body}.${sig}`;
}

export function verifySessionToken(token: string): SessionTokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = crypto
    .createHmac('sha256', getSessionSecret())
    .update(body)
    .digest('base64url');

  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionTokenPayload;
    if (!parsed.sid || !parsed.uid || !parsed.tid || !parsed.exp) return null;
    if (Date.now() > parsed.exp) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function verifyHmacSignature(rawPayload: string, signature: string, secret: string): boolean {
  if (!signature || !secret) return false;
  const computed = crypto.createHmac('sha256', secret).update(rawPayload).digest('hex');
  const a = Buffer.from(signature.replace(/^sha256=/, ''), 'utf8');
  const b = Buffer.from(computed, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function generateToken(bytes = 48): string {
  return crypto.randomBytes(bytes).toString('hex');
}
