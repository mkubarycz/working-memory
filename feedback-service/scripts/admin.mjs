import { AzureCliCredential } from '@azure/identity';
import { BlobServiceClient } from '@azure/storage-blob';
import { readFile } from 'node:fs/promises';
import { approve, revoke, publicConfiguration } from '../src/service.js';
import { createStorage } from '../src/storage.js';

const [action, argument] = process.argv.slice(2);
const account = process.env.FEEDBACK_STORAGE_ACCOUNT;
const baseUrl = process.env.FEEDBACK_PUBLIC_URL ?? 'https://wm-feedback-inbox-mk.azurewebsites.net/api';
try {
  if (!['list', 'approve', 'revoke', 'init-key'].includes(action)) throw new Error('Use list, approve <pairing-code>, revoke <device-id>, or init-key <public-key-file>. Authenticate with az login first.');
  const credential = new AzureCliCredential();
  const storage = createStorage(account, credential);
  if (action === 'init-key') {
    if (!argument) throw new Error('A receiver PUBLIC key file is required. Never supply its private key.');
    const publicKey = publicConfiguration(await readFile(argument, 'utf8'), baseUrl).publicKey;
    const blob = new BlobServiceClient(`https://${account}.blob.core.windows.net`, credential)
      .getContainerClient('feedback-service').getBlockBlobClient('receiver-public-key.pem');
    try { await blob.upload(publicKey, Buffer.byteLength(publicKey), { conditions: { ifNoneMatch: '*' } }); }
    catch (error) {
      if (error.statusCode !== 409 && error.statusCode !== 412) throw error;
      if ((await blob.downloadToBuffer()).toString() !== publicKey) throw new Error('A different receiver key is already installed. Refusing to invalidate queued reports.');
    }
    console.log('Receiver public key initialized (or already identical).');
  } else {
    const result = await storage.mutate(state => {
      if (action === 'approve') return approve(state, argument);
      if (action === 'revoke') return revoke(state, argument);
      return Object.values(state.devices ?? {}).map(({ id, name, state: status, expires }) => ({
        id, name, state: status === 'pending' && expires <= Date.now() ? 'expired' : status,
        ...(status === 'pending' ? { expiresAt: new Date(expires).toISOString() } : {}),
      }));
    });
    console.log(JSON.stringify(result, null, 2));
  }
} catch (error) {
  // SDK/CLI errors can contain credential-bearing headers. Only local validation is printable.
  const known = error.constructor === Error && !('statusCode' in error);
  console.error(known ? error.message : 'Feedback administration failed. Check Azure login, selected subscription, container existence and Blob Data Contributor permissions.');
  process.exitCode = 1;
}
