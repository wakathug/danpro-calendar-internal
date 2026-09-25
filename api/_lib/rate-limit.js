import { sha256 } from './crypto.js';
import { storeIncrement } from './store.js';

export async function checkRateLimit(namespace, identifier, limit, windowSeconds) {
  const bucket = Math.floor(Date.now() / (windowSeconds * 1000));
  const key = `rate:${namespace}:${sha256(identifier)}:${bucket}`;
  const count = await storeIncrement(key, windowSeconds + 5);
  return count <= limit;
}

