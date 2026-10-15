import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('the scheduled continuation attempts both briefing targets even when an independent situation request fails', () => {
  const workflow = readFileSync(
    new URL('../../../.github/workflows/run-mail-intelligence.yml', import.meta.url),
    'utf8',
  );
  const step = workflow.slice(
    workflow.indexOf('      - name: Connect evidence and compose proactive briefings'),
  );
  assert.match(
    step,
    /!cancelled\(\)/,
    'earlier Mail failure must not silently skip independent briefing delivery',
  );
  const script = step
    .slice(step.indexOf('        run: |') + '        run: |'.length)
    .trimEnd()
    .split('\n')
    .slice(1)
    .map((l) => l.slice(10))
    .join('\n');
  const dir = mkdtempSync(join(tmpdir(), 'loop-briefing-scheduler-'));
  try {
    writeFileSync(
      join(dir, 'curl'),
      '#!/bin/bash\nfor arg in "$@"; do\n case "$arg" in *phase=*) echo "$arg"; [[ "$arg" == *phase=organization* ]] && exit 22;; esac\ndone\nexit 0\n',
    );
    chmodSync(join(dir, 'curl'), 0o700);
    const result = spawnSync('bash', ['-c', script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        MAIL_URL: 'https://example.invalid/api/internal/intelligence/mail',
        MAIL_SECRET: 'test-only',
      },
    });
    assert.equal(result.status, 1, 'the job still reports the independent failures');
    const attempted = result.stdout.split('\n').filter((l) => l.startsWith('https://'));
    assert.equal(attempted.length, 6, result.stdout);
    assert.ok(attempted.slice(0, 2).every((l) => l.includes('phase=briefing')));
    assert.ok(attempted.slice(-2).every((l) => l.includes('phase=private')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
