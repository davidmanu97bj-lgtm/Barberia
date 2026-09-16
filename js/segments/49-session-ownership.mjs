const clean = value => String(value ?? '').trim();
const safe = value => clean(value).replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown';

export function scopedPrefix(base, uid) {
  return `${base}${safe(uid)}:`;
}

export function taskBelongsToUid(task, uid) {
  return Boolean(clean(uid) && clean(task?.driverUid) === clean(uid));
}

export function createSessionGeneration(initialUid = '') {
  let uid = clean(initialUid);
  let generation = 0;
  return Object.freeze({
    change(nextUid = '') { uid = clean(nextUid); generation += 1; return { uid, generation }; },
    capture() { return Object.freeze({ uid, generation }); },
    isCurrent(token) { return Boolean(token && clean(token.uid) && clean(token.uid) === uid && Number(token.generation) === generation); },
    get uid() { return uid; },
    get generation() { return generation; }
  });
}
