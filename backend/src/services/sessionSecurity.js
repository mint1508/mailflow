import { redisClient } from './redis.js';

// Best-effort revocation for every server-side session belonging to a user.
export async function destroyUserSessions(userId) {
  try {
    let cursor = 0;
    do {
      const result = await redisClient.scan(cursor, { MATCH: 'sess:*', COUNT: 200 });
      cursor = result.cursor;
      for (const key of result.keys) {
        const raw = await redisClient.get(key);
        if (!raw) continue;
        try {
          if (JSON.parse(raw).userId === userId) await redisClient.del(key);
        } catch { /* unrelated or malformed session */ }
      }
    } while (cursor !== 0);
  } catch (error) {
    console.error('destroyUserSessions failed:', error.message);
  }
}
