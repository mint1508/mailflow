import { describe, expect, it, vi } from 'vitest';
import { readSchemaVersion } from './versionInfo.js';

describe('readSchemaVersion', () => {
  it('returns the newest applied migration', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ version: '9001_internal_roles' }] });

    await expect(readSchemaVersion(query)).resolves.toBe('9001_internal_roles');
    expect(query).toHaveBeenCalledWith(
      'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1'
    );
  });

  it('reports an empty or unavailable schema without exposing database errors', async () => {
    await expect(readSchemaVersion(vi.fn().mockResolvedValue({ rows: [] }))).resolves.toBe('none');
    await expect(readSchemaVersion(vi.fn().mockRejectedValue(new Error('secret host detail'))))
      .resolves.toBe('unavailable');
  });
});
