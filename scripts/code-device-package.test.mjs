import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("native package preserves the provisioned Code helper and replaces obsolete resources", () => {
  const root=mkdtempSync(join(tmpdir(),"code-device-package-"));
  try {
    const input=join(root,"input"); mkdirSync(input);
    writeFileSync(join(input,"maestro-darwin-arm64"),"native fixture");
    const contents=join(input,"deixic-code-device-darwin-arm64.app","Contents");
    mkdirSync(join(contents,"MacOS"),{recursive:true});
    mkdirSync(join(contents,"_CodeSignature"));
    writeFileSync(join(contents,"MacOS","deixic-code-device"),"helper fixture");
    writeFileSync(join(contents,"embedded.provisionprofile"),"profile fixture");
    writeFileSync(join(contents,"_CodeSignature","CodeResources"),"signature fixture");
    const materialize=()=>{
      const result=spawnSync(process.execPath,[new URL("materialize-native-package.mjs",import.meta.url).pathname,"--input-dir",input],{cwd:root,encoding:"utf8"});
      assert.equal(result.status,0,result.stderr);
    };
    materialize();
    const output=join(root,"vendor","maestro","darwin-arm64","DeixicCodeDevice.app","Contents");
    assert.equal(readFileSync(join(output,"embedded.provisionprofile"),"utf8"),"profile fixture");
    assert.equal(readFileSync(join(output,"_CodeSignature","CodeResources"),"utf8"),"signature fixture");
    assert.ok(statSync(join(output,"MacOS","deixic-code-device")).mode & 0o100);
    writeFileSync(join(output,"obsolete"),"old");
    materialize();
    assert.equal(existsSync(join(output,"obsolete")),false);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test("Code helper build rejects missing signing/provisioning before producing a bundle", () => {
  const result=spawnSync(process.execPath,[new URL("build-code-device.mjs",import.meta.url).pathname,"darwin-arm64","unused.app"],{
    env:{...process.env,MAESTRO_RELEASE_DEVELOPER_ID_AUTHORITY:"",MAESTRO_RELEASE_DEVELOPER_ID_TEAM_IDENTIFIER:"",MAESTRO_CODE_DEVICE_PROVISIONING_PROFILE:""},encoding:"utf8",
  });
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/requires Developer ID|Usage on macOS/);
});
