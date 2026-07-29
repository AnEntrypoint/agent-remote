process.on('uncaughtException', e => console.log('UNCAUGHT', e && e.stack));
process.on('unhandledRejection', e => console.log('UNHANDLED', e && e.stack));

import Hyperdht from 'hyperdht';
import * as ar from './shell.js';

const boot = new Hyperdht({ bootstrap: false });
await new Promise(r => setTimeout(r, 500));
const baddr = boot.address();
process.env.HYPERDHT_BOOTSTRAP = `127.0.0.1:${baddr.port}`;
console.log('BOOTSTRAP', process.env.HYPERDHT_BOOTSTRAP);

let serverNode = null;
ar.runServer('integ-seed').then(res => { serverNode = res.node; }).catch(e => console.log('SERVER_ERR', e.message));
await new Promise(r => setTimeout(r, 2500));

function withTimeout(p, ms, label) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + label)), ms))]);
}
async function attempt(cmd, tries = 6) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await withTimeout(ar.runCommand('integ-seed', cmd), 15000, 'run'); }
    catch (e) { last = e; console.log('ATTEMPT_FAIL', i, e.message); await new Promise(r => setTimeout(r, 800)); }
  }
  throw last;
}

try {
  const r1 = await attempt('echo hello-from-remote');
  console.log('R1_STDOUT=' + JSON.stringify(r1.stdout) + ' R1_EXIT=' + JSON.stringify(r1.exitCode));
  const r2 = await attempt('node -e "console.log(123); process.stderr.write(\'err-text\')"');
  console.log('R2_STDOUT=' + JSON.stringify(r2.stdout) + ' R2_STDERR=' + JSON.stringify(r2.stderr) + ' R2_EXIT=' + JSON.stringify(r2.exitCode));
  const r3 = await attempt('exit 7');
  console.log('R3_STDOUT=' + JSON.stringify(r3.stdout) + ' R3_EXIT=' + JSON.stringify(r3.exitCode));
  const r4 = await attempt('cmd-that-does-not-exist-xyz');
  console.log('R4_STDOUT=' + JSON.stringify(r4.stdout) + ' R4_STDERR=' + JSON.stringify(r4.stderr) + ' R4_EXIT=' + JSON.stringify(r4.exitCode));
} catch (e) { console.log('FATAL', e.message); }

if (serverNode) serverNode.destroy();
boot.destroy();
console.log('DONE');
setTimeout(() => process.exit(0), 800);
