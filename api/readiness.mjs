export function createReadiness({ checks, now = Date.now, ttlMs = 60_000, timeoutMs = 20_000 }) {
  let cached;
  let expires = 0;
  let pending;
  return async () => {
    if (cached && now() < expires) return cached;
    if (pending) return pending;
    pending = (async () => {
      let timer;
      try {
        await Promise.race([
          Promise.all(Object.values(checks).map((check) => Promise.resolve().then(check))),
          new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error("readiness deadline")), timeoutMs); }),
        ]);
        cached = { ok: true, readiness: "dependencies_verified", checks: Object.keys(checks) };
      } catch {
        cached = { ok: false, readiness: "dependency_unavailable" };
      } finally {
        clearTimeout(timer);
        expires = now() + ttlMs;
        pending = null;
      }
      return cached;
    })();
    return pending;
  };
}

export function createStorageProbe({ store, key, nonce }) {
  let checkpointed = false;
  return async () => {
    if (!checkpointed) {
      const existing = await store.read(key);
      if (existing && existing.value?.nonce !== nonce) throw new Error("readiness checkpoint conflict");
      if (!existing) {
        const created = await store.compareAndSet(key, null, { version: 1, nonce });
        if (!created) throw new Error("readiness checkpoint conflict");
      }
      checkpointed = true;
    }
    const restored = await store.read(key);
    if (restored?.value?.nonce !== nonce) throw new Error("readiness restoration failed");
  };
}
