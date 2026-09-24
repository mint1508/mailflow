import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseCpanelBulkRows } from './cpanelMailbox.js';

describe('cPanel mailbox bulk input', () => {
  it('parses line mode with optional password and quota', () => {
    assert.deepEqual(parseCpanelBulkRows('support\nsales,StrongPassword123!,2048'), [
      { localPart: 'support' },
      { localPart: 'sales', password: 'StrongPassword123!', quotaMb: '2048' },
    ]);
  });

  it('parses CSV headers and quoted values', () => {
    assert.deepEqual(parseCpanelBulkRows('email,password,quotaMb\n"support@example.com","Strong,Password123!",1024', 'csv'), [
      { email: 'support@example.com', password: 'Strong,Password123!', quotaMb: '1024' },
    ]);
  });
});
