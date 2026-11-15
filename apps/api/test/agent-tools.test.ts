import type { Principal } from '@novate/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AGENT_TOOLS } from '../src/agent-tools.ts';

describe('agent tools', () => {
  it('describes every tool in a form an agent can read', () => {
    for (const tool of AGENT_TOOLS) {
      const schema = z.toJSONSchema(tool.input, { io: 'input' });
      expect(schema.type, tool.name).toBe('object');
      expect(tool.description.length, tool.name).toBeGreaterThan(10);
    }
  });

  const balances = AGENT_TOOLS.find((t) => t.name === 'get_balances');
  const asKey = (kind: Principal['kind'], memberId?: string): Principal => ({
    kind,
    id: 'k',
    tenantId: 't',
    memberId,
  });

  it('never lets a key read a member it has no standing over', async () => {
    await expect(balances?.run(asKey('inspector'), { memberId: 'm' })).rejects.toThrow(
      'Not allowed',
    );
    await expect(balances?.run(asKey('member', 'mine'), { memberId: 'theirs' })).rejects.toThrow(
      'Not allowed',
    );
  });

  it('gives agents no way to take money out or decide a case', () => {
    const names = AGENT_TOOLS.map((t) => t.name).join();
    expect(names).not.toMatch(/withdraw|decide|waive|release/);
  });
});
