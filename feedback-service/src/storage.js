import { BlobServiceClient } from '@azure/storage-blob';
import { DefaultAzureCredential } from '@azure/identity';

export function createStorage(account, credential = new DefaultAzureCredential()) {
  if (!/^[a-z0-9]{3,24}$/.test(account ?? '')) throw new Error('FEEDBACK_STORAGE_ACCOUNT is required.');
  const client = new BlobServiceClient(`https://${account}.blob.core.windows.net`, credential, { retryOptions: { maxTries: 3 } });
  return createBlobStorage(client);
}

export function createBlobStorage(client) {
  const stateContainer = client.getContainerClient('feedback-service');
  const stateBlob = stateContainer.getBlockBlobClient('devices.json');
  const reports = client.getContainerClient('reports');
  return {
    async mutate(change) {
      for (let attempt = 0; attempt < 12; attempt++) {
        let state, etag;
        try {
          const response = await stateBlob.download();
          etag = response.etag;
          const chunks = [];
          for await (const chunk of response.readableStreamBody) chunks.push(chunk);
          state = JSON.parse(Buffer.concat(chunks).toString());
        } catch (error) {
          if (error.statusCode !== 404) throw error;
          state = { devices: {} };
        }
        const result = change(state);
        const text = JSON.stringify(state);
        try {
          await stateBlob.upload(text, Buffer.byteLength(text), { conditions: etag ? { ifMatch: etag } : { ifNoneMatch: '*' },
            blobHTTPHeaders: { blobContentType: 'application/json' } });
          return result;
        } catch (error) { if (error.statusCode !== 409 && error.statusCode !== 412) throw error; }
        await new Promise(resolve => setTimeout(resolve, 10 + Math.random() * 40 * (attempt + 1)));
      }
      throw new Error('Feedback state is busy; retry later.');
    },
    async publicKey() {
      const body = await stateContainer.getBlockBlobClient('receiver-public-key.pem').downloadToBuffer();
      if (body.length > 8192) throw new Error('Invalid receiver public key size.');
      return body.toString();
    },
    async claim(id, claim) {
      const blob = stateContainer.getBlockBlobClient(`requests/${id}.json`);
      try {
        await blob.upload(claim, Buffer.byteLength(claim), { conditions: { ifNoneMatch: '*' } });
        return true;
      } catch (error) {
        if (error.statusCode !== 409 && error.statusCode !== 412) throw error;
        return (await blob.downloadToBuffer()).toString() === claim;
      }
    },
    async upload(name, text, digest) {
      const blob = reports.getBlockBlobClient(name);
      try {
        await blob.upload(text, Buffer.byteLength(text), { conditions: { ifNoneMatch: '*' }, metadata: { ciphertextsha256: digest },
          blobHTTPHeaders: { blobContentType: 'application/json' } });
        return 'created';
      } catch (error) {
        if (error.statusCode !== 409 && error.statusCode !== 412) throw error;
        const properties = await blob.getProperties();
        return properties.metadata?.ciphertextsha256 === digest ? 'duplicate' : 'conflict';
      }
    },
  };
}
