// AES-256-GCM encryption helper for at-rest secrets (Gmail app passwords etc.)
//
// Key source: process.env.GMAIL_ENCRYPTION_KEY — must be 32 bytes encoded
// as 64 lowercase hex chars. Generate with:
//   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
//
// Wire format (base64-encoded concatenation):
//   [ IV (12 bytes) | authTag (16 bytes) | ciphertext (rest) ]
// GCM is authenticated encryption — tampering or wrong key throws on decrypt
// (the decipher.final() call surfaces the AEAD verification failure).
//
// Graceful degradation: routes call isAvailable() before encrypt/decrypt so
// the app boots without GMAIL_ENCRYPTION_KEY (Gmail features become disabled,
// rest of the app keeps working).

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;        // GCM standard: 96-bit nonce
const TAG_LENGTH = 16;       // GCM standard: 128-bit auth tag
const KEY_BYTES = 32;        // AES-256 needs 256 bits
const KEY_HEX_LENGTH = KEY_BYTES * 2;

function readKeyOrNull() {
  const hex = process.env.GMAIL_ENCRYPTION_KEY;
  if (!hex) return null;
  if (hex.length !== KEY_HEX_LENGTH) return null;
  if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
  return Buffer.from(hex, 'hex');
}

function isAvailable() {
  return readKeyOrNull() !== null;
}

function requireKey() {
  const key = readKeyOrNull();
  if (!key) {
    throw new Error('GMAIL_ENCRYPTION_KEY missing or invalid (need 64 hex chars)');
  }
  return key;
}

function encryptString(plaintext) {
  if (typeof plaintext !== 'string') {
    throw new Error('encryptString: plaintext must be a string');
  }
  const key = requireKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

function decryptString(b64) {
  if (typeof b64 !== 'string' || !b64) {
    throw new Error('decryptString: ciphertext must be a non-empty string');
  }
  const key = requireKey();
  const buf = Buffer.from(b64, 'base64');
  if (buf.length < IV_LENGTH + TAG_LENGTH + 1) {
    throw new Error('decryptString: ciphertext too short');
  }
  const iv = buf.subarray(0, IV_LENGTH);
  const authTag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString('utf8');
}

// One-shot startup check. Logs a warning if the key is missing so DD knows
// Gmail features will 503 until the env var is set on Railway.
function logStartupStatus() {
  if (isAvailable()) {
    console.log('✅ Email encryption ready (GMAIL_ENCRYPTION_KEY loaded, AES-256-GCM)');
  } else {
    console.warn(
      '⚠️  Email encryption disabled — set GMAIL_ENCRYPTION_KEY env var ' +
      '(64 hex chars; generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))")'
    );
  }
}

module.exports = { encryptString, decryptString, isAvailable, logStartupStatus };
