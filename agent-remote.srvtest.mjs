process.on('uncaughtException', e => console.log('UNC', e && e.stack));
process.on('unhandledRejection', e => console.log('UNH', e && e.stack));

import Hyperdht from 'hyperdht';
const boot = new Hyperdht({ bootstrap: false });
await new Promise(r => setTimeout(r, 500));
const ba = boot.address();
process.env.HYPERDHT_BOOTSTRAP = `127.0.0.1:${ba.port}`;
console.log('BOOT', JSON.stringify(ba));

import * as ar from './shell.js';

const p = ar.runServer('integ-seed');
const t = new Promise((_, rej) => setTimeout(() => rej(new Error('__NO_REJECT__')), 8000));
try {
  await Promise.race([p, t]);
  console.log('SERVER_RESOLVED_OR_HUNG_OK');
} catch (e) {
  console.log('SERVER_RESULT', e.message === '__NO_REJECT__' ? 'LISTENING_OK_NO_REJECT' : e.stack);
}
process.exit(0);
