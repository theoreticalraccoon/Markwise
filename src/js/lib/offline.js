const PREFIX = "markwise-offline-";

export function readSnapshot(userId, name) {
  if (!userId) return null;
  try { return JSON.parse(localStorage.getItem(`${PREFIX}${userId}:${name}`) ?? "null"); }
  catch { return null; }
}

export function saveSnapshot(userId, name, value) {
  if (!userId) return;
  try {
    const key = `${PREFIX}${userId}:${name}`;
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch { /* Storage restrictions must not break online use. */ }
}

export function clearOfflineWork() {
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(PREFIX) || key.startsWith("markwise-mock-")) localStorage.removeItem(key);
    }
  } catch { /* Storage may be blocked. */ }
}
