import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseCpanelBulkRows } from './cpanelMailbox.js';

describe('cPanel mailbox bulk input', () => {
  it('parses line mode with contact email and optional quota', () => {
    assert.deepEqual(parseCpanelBulkRows('support,user1@example.com\nsales,user2@example.com,2048'), [
      { localPart: 'support', contactEmail: 'user1@example.com' },
      { localPart: 'sales', contactEmail: 'user2@example.com', quotaMb: '2048' },
    ]);
  });

  it('parses CSV headers and quoted values', () => {
    assert.deepEqual(parseCpanelBulkRows('email,contactEmail,quotaMb\n"support@example.com","owner@example.net",1024', 'csv'), [
      { email: 'support@example.com', contactEmail: 'owner@example.net', quotaMb: '1024' },
    ]);
  });
});
