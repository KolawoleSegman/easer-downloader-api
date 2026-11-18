'use strict';

/** Sliding-window limiter. Returns express middleware. */
function createLimiter({ windowMs, max, name = 'default', keyFn }) {
  const hits = new Map(); // key -> number[]
  const timer = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [k, arr] of hits) {
      const fresh = arr.filter(t => t > cutoff);
      if (fresh.length) hits.set(k, fresh); else hits.delete(k);
    }
  }, Math.min(windowMs, 60_000));
  timer.unref();

  function check(key, now = Date.now()) {
    const cutoff = now - windowMs;
    const arr = (hits.get(key) || []).filter(t => t > cutoff);
    if (arr.length >= max) {
      hits.set(key, arr);
      return { ok: false, retryAfter: Math.max(1, Math.ceil((arr[0] + windowMs - now) / 1000)), remaining: 0 };
    }
    arr.push(now);
    hits.set(key, arr);
    return { ok: true, remaining: max - arr.length, retryAfter: 0 };
  }

  const middleware = (req, res, next) => {
    const key = keyFn ? keyFn(req) : (req.ip || req.socket?.remoteAddress || 'unknown');
    const r = check(key);
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(r.remaining));
    if (!r.ok) {
      res.setHeader('Retry-After', String(r.retryAfter));
      return res.status(429).json({
        success: false, error: 'Too many requests',
        message: `Rate limit (${name}) exceeded. Try again in ${r.retryAfter}s.`,
        retryAfter: r.retryAfter,
      });
    }
    next();
  };
  middleware.check = check;
  return middleware;
}

module.exports = { createLimiter };
