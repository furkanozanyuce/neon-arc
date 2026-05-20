// Bridges the artifact's `window.storage` API onto `localStorage`.
// The artifact was originally written for Claude's sandbox, which provides
// window.storage with an async key/value API. Real browsers don't have that,
// but localStorage does the same job synchronously. We just wrap it in
// async-returning shims so the existing await calls work.

if (typeof window !== 'undefined' && !window.storage) {
  window.storage = {
    async get(key) {
      try {
        const v = localStorage.getItem(key);
        return v == null ? null : { key, value: v, shared: false };
      } catch (e) {
        // localStorage can throw in private mode / quota-exceeded scenarios.
        return null;
      }
    },
    async set(key, value, shared = false) {
      try {
        localStorage.setItem(key, value);
        return { key, value, shared };
      } catch (e) {
        return null;
      }
    },
    async delete(key, shared = false) {
      try {
        localStorage.removeItem(key);
        return { key, deleted: true, shared };
      } catch (e) {
        return null;
      }
    },
    async list(prefix = '', shared = false) {
      const keys = [];
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && (!prefix || k.startsWith(prefix))) keys.push(k);
        }
      } catch (e) {}
      return { keys, prefix, shared };
    }
  };
}
