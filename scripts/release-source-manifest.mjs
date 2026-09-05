#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
export function buildSourceManifest(root) {
  const files = [];
  function visit(dir) {
    for (const entry of readdirSync(dir, {withFileTypes:true}).sort((a,b) => a.name.localeCompare(b.name))) {
      const path = join(dir,entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push({path:relative(root,path).split(sep).join('/'),sha256:hash(path)});
      else throw new Error('Source projection must contain only directories and regular files');
    }
  }
  visit(root);
  if (!files.length) throw new Error('Empty source projection');
  return {schemaVersion:1,files};
}
export function verifySourceManifest(root,manifest) {
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files) || !manifest.files.length) throw new Error('Invalid source manifest');
  const seen = new Set(); const boundary = realpathSync(root)+sep;
  for (const file of manifest.files) {
    if (typeof file.path !== 'string' || file.path.includes('\\') || file.path.includes('\0') || file.path.split('/').some(p => !p || p === '.' || p === '..') || seen.has(file.path)) throw new Error('Invalid source path');
    seen.add(file.path);
    const path=join(root,file.path);
    if (!realpathSync(path).startsWith(boundary) || !lstatSync(path).isFile() || hash(path) !== file.sha256) throw new Error(`Public source mismatch: ${file.path}`);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [root,out] = process.argv.slice(2);
  if (!root || !out) throw new Error('Usage: release-source-manifest.mjs PROJECTION OUTPUT');
  writeFileSync(out,JSON.stringify(buildSourceManifest(resolve(root)))+'\n');
}
