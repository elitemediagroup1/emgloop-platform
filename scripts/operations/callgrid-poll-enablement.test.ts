import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('disabled scheduled polling is an actionable failure rather than a green no-op', () => {
  const yaml = readFileSync(new URL('../../.github/workflows/poll-callgrid-routine.yml', import.meta.url), 'utf8');
  const gate = yaml.split('      - name: Stop unless routine polling has been switched on')[1]!.split('        id: gate')[0]!;
  const shell = gate.split('        run: |\n')[1]!.split('\n').map((l) => l.replace(/^          /, '')).join('\n');
  const dir = mkdtempSync(join(tmpdir(), 'callgrid-gate-'));
  try {
    const env = { PATH: process.env.PATH, ORGANIZATIONS: '', GITHUB_STEP_SUMMARY: join(dir, 'summary'), GITHUB_OUTPUT: join(dir, 'output') };
    const off = spawnSync('bash', ['-c', shell], { env, encoding: 'utf8' });
    assert.equal(off.status, 1);
    assert.match(off.stdout, /::error::.*polling is OFF/);
    const on = spawnSync('bash', ['-c', shell], { env: { ...env, ORGANIZATIONS: 'test-org' }, encoding: 'utf8' });
    assert.equal(on.status, 0);
    assert.match(readFileSync(join(dir, 'output'), 'utf8'), /enabled=true/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
