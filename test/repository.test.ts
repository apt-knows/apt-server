import { describe, expect, it, vi } from 'vitest';
import { PostgresChatRepository } from '../src/repository.js';
import { USER_A } from './fixtures.js';

const now = new Date('2026-08-21T00:00:00.000Z');
const instanceRow = {
  user_id: USER_A,
  hermes_profile_name: 'apt-profile',
  hermes_session_id: '66666666-6666-4666-8666-666666666666',
  status: 'ready',
  created_at: now,
  updated_at: now,
};

function messageRow(sequence: string) {
  return {
    id: `00000000-0000-4000-8000-00000000000${sequence}`,
    sequence,
    role: 'user',
    content: `message ${sequence}`,
    status: 'completed',
    client_message_id: `10000000-0000-4000-8000-00000000000${sequence}`,
    reply_to_message_id: null,
    channel: 'in_app',
    error_code: null,
    created_at: now,
    updated_at: now,
    completed_at: now,
  };
}

describe('PostgresChatRepository', () => {
  it('returns a chronological keyset page with the older cursor', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [instanceRow] })
      .mockResolvedValueOnce({ rows: [messageRow('3'), messageRow('2'), messageRow('1')] })
      .mockResolvedValueOnce({ rows: [] });
    const repo = new PostgresChatRepository({ query } as never);
    const page = await repo.getChat(USER_A, '4', 2);
    expect(page.messages.map((message) => message.sequence)).toEqual(['2', '3']);
    expect(page.olderCursor).toBe('2');
    expect(query.mock.calls[1]?.[0]).toContain('order by sequence desc');
    expect(query.mock.calls[1]?.[1]).toEqual([USER_A, '4', 3]);
  });

  it('rejects a second active turn inside the transaction', async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [instanceRow] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ exists: 1 }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    };
    const repo = new PostgresChatRepository({ connect: vi.fn(async () => client) } as never);
    await expect(repo.createTurn(USER_A, '77777777-7777-4777-8777-777777777777', 'hello'))
      .rejects.toEqual(expect.objectContaining({ code: 'RUN_IN_PROGRESS' }));
    expect(client.query).toHaveBeenLastCalledWith('rollback');
    expect(client.release).toHaveBeenCalledOnce();
  });
});
