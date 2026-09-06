import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const workflow = readFileSync(new URL('./release.yml', import.meta.url), 'utf8');
const authentication = workflow.split('node scripts/verify-staged-release.mjs release-binaries "$RELEASE_VERSION"')[1].split('          chmod')[0];
for (const mode of ['valid', 'changed', 'missing', 'unexpected-helper']) {
  test(`older-source marker authentication: ${mode}`, t => {
    const root = mkdtempSync(join(tmpdir(), 'device-marker-'));
    t.after(() => rmSync(root, {recursive:true, force:true}));
    const dir = join(root, 'release-binaries'); mkdirSync(dir);
    const lines = [];
    for (const platform of ['darwin-x64', 'darwin-arm64']) {
      const name = `code-device-${platform}.json`;
      const content = JSON.stringify({schemaVersion:1,platform,enabled:false});
      writeFileSync(join(dir,name), content);
      lines.push(`${createHash('sha256').update(content).digest('hex')}  ${name}`);
    }
    if (mode === 'changed') writeFileSync(join(dir,'code-device-darwin-arm64.json'),'{}');
    if (mode === 'missing') lines.pop();
    if (mode === 'unexpected-helper') writeFileSync(join(dir,'deixic-code-device-darwin-arm64.app.tar.gz'),'stale helper');
    writeFileSync(join(dir,'MONO_SHA256SUMS'),lines.join('\n')+'\n');
    const result = spawnSync('bash', ['-e','-o','pipefail','-c',authentication], {cwd:root,encoding:'utf8'});
    if (mode === 'valid') assert.equal(result.status,0,result.stderr);
    else assert.notEqual(result.status,0);
  });
}
