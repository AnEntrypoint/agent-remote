process.on('uncaughtException', e => console.log('UNC', e && e.stack));
process.on('unhandledRejection', e => console.log('UNH', e && e.stack));

import Hyperdht from 'hyperdht';
const boot = new Hyperdht({ bootstrap: false });
await new Promise(r => setTimeout(r, 500));
const ba = boot.address();
console.log('BOOT', JSON.stringify(ba));

const server = new Hyperdht({ bootstrap: [{ host: '127.0.0.1', port: ba.port }] });
const srv = server.createServer({ firewall: () => false });
srv.on('connection', sock => { console.log('CONN_FROM_SERVER'); sock.end(); });
const kp = Hyperdht.keyPair(Buffer.alloc(32, 7));
try {
  await srv.listen(kp);
  console.log('LISTENING ok');
} catch (e) {
  console.log('LISTEN_ERR', e && e.stack);
}

const client = new Hyperdht({ bootstrap: [{ host: '127.0.0.1', port: ba.port }] });
const sock = client.connect(kp.publicKey);
sock.on('open', () => console.log('CLIENT_OPEN'));
sock.on('error', e => console.log('CLIENT_ERR', e && e.message));
await new Promise(r => setTimeout(r, 4000));
console.log('DONE_MIN');
process.exit(0);
