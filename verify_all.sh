#!/bin/bash
# Full verification of types.d.ts against this repo's actual runtime.
cd /home/user/baileys-mod
TSC=node_modules/typescript/bin/tsc
echo "════════════ TYPE DEFINITION VERIFICATION ════════════"
echo "[1] types.d.ts (--strict):        $(node $TSC --noEmit --strict types.d.ts 2>&1|grep -c 'error TS') errors"
echo "[2] positive emulations:          $(cd typetests && node ../$TSC --noEmit -p . 2>&1|grep -c 'error TS') errors"
echo "[3] negative tests (31 cases):    $(cd typetests/negative && node ../../$TSC --noEmit -p . 2>&1|grep -c 'error TS') errors"
node -e "
const b=require('./lib'),fs=require('fs');
const src=fs.readFileSync('types.d.ts','utf8');
const vals=[...new Set([...src.matchAll(/^export (?:declare )?(?:abstract )?(const|function|class) ([A-Za-z0-9_]+)/gm)].map(m=>m[2]))];
const enums=[...src.matchAll(/^export (?:declare )?enum ([A-Za-z0-9_]+)/gm)].map(m=>m[1]);
const all=[...new Set([...vals,...enums])];
const rt=Object.keys(b).filter(k=>k!=='default');
console.log('[4] export parity:                declared '+all.length+' / runtime '+rt.length+
  ' | ghosts '+all.filter(n=>!(n in b)).length+' | untyped '+rt.filter(n=>!all.includes(n)).length);
"
echo "[5] runtime assertions:           $(node runtime_assert.cjs 2>/dev/null | grep -c PASS) passed / $(node runtime_assert.cjs 2>/dev/null | grep -c FAIL) failed"
echo "[6] lib/ source modified:         $(git status --porcelain -- lib WAProto | wc -l) files"
