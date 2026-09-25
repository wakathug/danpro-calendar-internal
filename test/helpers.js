export class MemoryStore {
  constructor() {
    this.values = new Map();
  }

  async get(key) { return this.values.get(key) ?? null; }
  async set(key, value) { this.values.set(key, structuredClone(value)); return 'OK'; }
  async del(key) { return this.values.delete(key) ? 1 : 0; }
  async getdel(key) {
    const value = this.values.get(key) ?? null;
    this.values.delete(key);
    return value;
  }
  async incr(key) {
    const value = Number(this.values.get(key) ?? 0) + 1;
    this.values.set(key, value);
    return value;
  }
  async expire() { return 1; }
  multi() {
    const operations = [];
    const self = this;
    return {
      get(key) { operations.push(() => self.get(key)); return this; },
      del(key) { operations.push(() => self.del(key)); return this; },
      incr(key) { operations.push(() => self.incr(key)); return this; },
      expire(key, seconds) { operations.push(() => self.expire(key, seconds)); return this; },
      async exec() {
        const results = [];
        for (const operation of operations) results.push(await operation());
        return results;
      },
    };
  }
}

export function configureTestEnvironment() {
  process.env.APP_ORIGIN = 'https://danpro-calendar-internal.vercel.app';
  process.env.GOOGLE_OAUTH_CLIENT_ID = 'unit-test.apps.googleusercontent.com';
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'unit-test-client-secret-value';
  process.env.INTERNAL_GAS_API_URL = 'https://script.google.com/macros/s/UNIT_TEST_DEPLOYMENT/exec';
  process.env.INTERNAL_GAS_SIGNING_SECRET = 'unit-test-signing-secret-that-is-long-enough';
}

export function mockRequest({ method = 'GET', headers = {}, query = {}, body } = {}) {
  return {
    method,
    headers,
    query,
    body,
    socket: { remoteAddress: '127.0.0.1' },
  };
}

export function mockResponse() {
  const headers = new Map();
  return {
    statusCode: 200,
    body: '',
    ended: false,
    setHeader(name, value) { headers.set(name.toLowerCase(), value); },
    getHeader(name) { return headers.get(name.toLowerCase()); },
    end(value = '') { this.body += value; this.ended = true; },
    json() { return this.body ? JSON.parse(this.body) : null; },
  };
}

