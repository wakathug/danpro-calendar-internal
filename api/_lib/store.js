import { Redis } from '@upstash/redis';

let redisClient;

function getRedis() {
  if (globalThis.__DANPRO_TEST_STORE__) return globalThis.__DANPRO_TEST_STORE__;
  if (redisClient) return redisClient;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Session store is not configured');
  redisClient = new Redis({ url, token, automaticDeserialization: true });
  return redisClient;
}

export async function storeGet(key) {
  return getRedis().get(key);
}

export async function storeSet(key, value, ttlSeconds) {
  return getRedis().set(key, value, { ex: ttlSeconds });
}

export async function storeDelete(key) {
  return getRedis().del(key);
}

export async function storeConsume(key) {
  const store = getRedis();
  if (typeof store.getdel === 'function') return store.getdel(key);
  const transaction = store.multi();
  transaction.get(key);
  transaction.del(key);
  const result = await transaction.exec();
  return Array.isArray(result) ? result[0] : null;
}

export async function storeIncrement(key, ttlSeconds) {
  const store = getRedis();
  if (typeof store.multi === 'function') {
    const transaction = store.multi();
    transaction.incr(key);
    transaction.expire(key, ttlSeconds, 'nx');
    const result = await transaction.exec();
    return Number(Array.isArray(result) ? result[0] : 0);
  }
  const count = await store.incr(key);
  if (count === 1) await store.expire(key, ttlSeconds);
  return Number(count);
}

export function resetStoreForTests() {
  redisClient = undefined;
}

