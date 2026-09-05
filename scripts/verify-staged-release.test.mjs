import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { stagedFiles, verifyStagedFiles } from './verify-staged-release.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'staged-release-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const name of stagedFiles) writeFileSync(join(dir, name), name);
  const digest = name => createHash('sha256').update(readFileSync(join(dir, name))).digest('hex');
  writeFileSync(join(dir, 'release-metadata.json'), JSON.stringify({version:'0.10.72', releaseTag:'v0.10.72', receipt:{sourceSha:'a'.repeat(40)}}));
  for (const p of ['darwin-x64', 'darwin-arm64']) writeFileSync(join(dir, `notarized-${p}.json`), JSON.stringify({schema:'evalops.maestro.macos-notarization.v1',status:'Accepted',platform:p,binarySha256:digest(`maestro-${p}`)}));
  writeFileSync(join(dir, 'package.json'), '{"version":"0.10.72"}');
  writeFileSync(join(dir, 'release-source-manifest.json'), JSON.stringify({schemaVersion:1,files:[{path:'package.json',sha256:digest('package.json')}]}));
  const seal = () => writeFileSync(join(dir, 'MONO_SHA256SUMS'), stagedFiles.map(name => `${digest(name)}  ${name}`).join('\n')+'\n');
  seal();
  return {dir, seal};
}
test('accepts complete content matching the authenticated manifest', t => {
  const {dir} = fixture(t);
  assert.equal(verifyStagedFiles(dir, '0.10.72', dir).receipt.sourceSha, 'a'.repeat(40));
});
test('rejects changed binary bytes', t => {
  const {dir} = fixture(t); writeFileSync(join(dir,'maestro-darwin-arm64'),'changed');
  assert.throws(() => verifyStagedFiles(dir,'0.10.72',dir), /Checksum mismatch/);
});
test('rejects a different requested release', t => {
  assert.throws(() => verifyStagedFiles(fixture(t).dir,'0.10.73'), /version or source/);
});
test('requires every platform even when the checksum list omits one', t => {
  const {dir} = fixture(t);
  writeFileSync(join(dir,'MONO_SHA256SUMS'),readFileSync(join(dir,'MONO_SHA256SUMS'),'utf8').split('\n').filter(l => !l.endsWith('  maestro-darwin-x64')).join('\n'));
  assert.throws(() => verifyStagedFiles(dir,'0.10.72',dir), /Checksum mismatch/);
});
test('rejects path traversal and duplicate manifest entries', t => {
  const {dir} = fixture(t); const path=join(dir,'MONO_SHA256SUMS'); const original=readFileSync(path,'utf8');
  for (const extra of [`${'a'.repeat(64)}  ../secret`, original.split('\n')[0]]) {
    writeFileSync(path,original+extra+'\n');
    assert.throws(() => verifyStagedFiles(dir,'0.10.72',dir), /Invalid or duplicate/);
  }
});
test('rejects signed but rejected notarization receipts', t => {
  const {dir,seal} = fixture(t); const path=join(dir,'notarized-darwin-arm64.json');
  const marker=JSON.parse(readFileSync(path,'utf8')); marker.status='Rejected'; writeFileSync(path,JSON.stringify(marker));seal();
  assert.throws(() => verifyStagedFiles(dir,'0.10.72',dir), /Invalid notarization/);
});
test('rejects notarization for different binary bytes even with valid checksums', t => {
  const {dir,seal} = fixture(t); writeFileSync(join(dir,'maestro-darwin-arm64'),'new binary');seal();
  assert.throws(() => verifyStagedFiles(dir,'0.10.72',dir), /Invalid notarization/);
});

test('rejects a public source tag with the same version but different content', t => {
  const {dir}=fixture(t); writeFileSync(join(dir,'package.json'), '{"version":"0.10.72","changed":true}');
  assert.throws(() => verifyStagedFiles(dir,'0.10.72',dir), /Public source mismatch/);
});
test('rejects traversal in an authenticated source manifest', t => {
  const {dir,seal}=fixture(t);
  writeFileSync(join(dir,'release-source-manifest.json'),JSON.stringify({schemaVersion:1,files:[{path:'../outside',sha256:'a'.repeat(64)}]}));seal();
  assert.throws(() => verifyStagedFiles(dir,'0.10.72',dir), /Invalid source path/);
});
