import crypto from "node:crypto";

const SALT_LENGTH = 32;
const KEY_LENGTH = 64;
const SCRYPT_COST = 16384; // N — CPU/memory cost (2^14)
const SCRYPT_BLOCK = 8; // r — block size
const SCRYPT_PARALLEL = 1; // p — parallelization

const SCRYPT_OPTIONS: crypto.ScryptOptions = {
  N: SCRYPT_COST,
  r: SCRYPT_BLOCK,
  p: SCRYPT_PARALLEL,
};

function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, SCRYPT_OPTIONS, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const derived = await scryptAsync(password, salt, KEY_LENGTH);
  return `${salt.toString("hex")}:${derived.toString("hex")}`;
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const sepIdx = stored.indexOf(":");
  if (sepIdx === -1) return false;

  const salt = Buffer.from(stored.slice(0, sepIdx), "hex");
  const expected = Buffer.from(stored.slice(sepIdx + 1), "hex");

  if (salt.length !== SALT_LENGTH || expected.length !== KEY_LENGTH) {
    return false;
  }

  const derived = await scryptAsync(password, salt, KEY_LENGTH);
  return crypto.timingSafeEqual(derived, expected);
}
