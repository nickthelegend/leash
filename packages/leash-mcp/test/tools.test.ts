import fs from 'fs';
import os from 'os';
import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// leash-mcp (agent tools, no upstream) over stdio: the nonce an agent sends is checked before nargo runs.
const ROOT = path.resolve(__dirname, '../../..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'leash-tools-'));
const client = new Client({ name: 'tools-test', version: '1.0.0' });
const textOf = (r: any) => r.content.map((c: any) => c.text).join('\n');

beforeAll(async () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('LEASH_'))) as Record<string, string>;
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(__dirname, '../dist/index.js'), '--demo'],
      cwd: ROOT,
      env: { ...env, LEASH_HOME: home },
      stderr: 'pipe',
    })
  );
}, 60_000);
afterAll(async () => {
  await client.close();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('leash_request_payment nonce', () => {
  it('refuses a TOML-injection nonce before proving (no nargo stderr comes back)', async () => {
    const r: any = await client.callTool({ name: 'leash_request_payment', arguments: { merchant: 'openai', amountCents: 100, nonce: '1"\nmax_per_tx = "1' } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe('nonce must be a decimal integer string without leading zeros (1-30 digits), e.g. "3001"');
  });

  it('refuses hex and zero-padded nonces instead of proving and then reporting approved:false', async () => {
    for (const nonce of ['0x0bb9', '03001']) {
      const r: any = await client.callTool({ name: 'leash_request_payment', arguments: { merchant: 'openai', amountCents: 100, nonce } });
      expect(r.isError, nonce).toBe(true);
      expect(textOf(r)).toMatch(/^nonce must be a decimal integer string/);
    }
  });

  it('a canonical nonce still proves and verifies', async () => {
    const r: any = await client.callTool({ name: 'leash_request_payment', arguments: { merchant: 'openai', amountCents: 100, nonce: '3001' } });
    expect(r.isError, textOf(r)).toBeFalsy();
    const body = JSON.parse(textOf(r));
    expect(body.approved).toBe(true);
    expect(body.publicInputs.nonce).toBe('3001');
  }, 60_000);
});
