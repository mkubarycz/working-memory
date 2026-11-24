# Approved-device encrypted Feedback service

Node 22 Azure Functions (HTTP v4), with managed-identity access to private Blob
containers. No report plaintext or Azure upload SAS reaches this service.
Desktop default: `https://wm-feedback-inbox-mk.azurewebsites.net/api`.

## Deployment (owner only)

Authenticate `az login` and select the intended subscription. Create a Node 22
Linux Function App with its normal private Functions host storage first.
The deployment identity needs management permission for the app, role assignments,
and Blob Data Contributor access to the selected storage account.

```sh
cd feedback-service
npm ci --ignore-scripts
npm test
node scripts/provision.mjs home-ai wm-feedback-inbox-mk wmfeedback20261122mk
export FEEDBACK_STORAGE_ACCOUNT=wmfeedback20261122mk
export FEEDBACK_PUBLIC_URL=https://wm-feedback-inbox-mk.azurewebsites.net/api
# Export ONLY the existing receiver public key to a private local file first.
npm run admin -- init-key /private/path/receiver-public-key.pem
npm run deploy -- home-ai wm-feedback-inbox-mk
curl --fail https://wm-feedback-inbox-mk.azurewebsites.net/api/configuration
```

The provision script configures existing infrastructure idempotently; it does not
create a subscription/account/app or touch receiver credentials or volumes.
It creates private `reports` and `feedback-service` containers, assigns the app's
system identity **Storage Blob Data Contributor** separately on each, enforces
HTTPS, and sets:

* `FEEDBACK_STORAGE_ACCOUNT`: account name, no credential.
* `FEEDBACK_PUBLIC_URL`: exact HTTPS origin plus `/api`, not derived from Host.
* `FUNCTIONS_REQUEST_BODY_SIZE_LIMIT=41943040`: host ingress cap.

Normal Functions settings (`FUNCTIONS_WORKER_RUNTIME=node`,
`FUNCTIONS_EXTENSION_VERSION=~4`, Node 22, host storage) remain administrator-owned.
Disable request-body/header telemetry and do not enable Azure SDK HTTP logging.
No secrets belong in URLs, app packages or shell command arguments.

`feedback-service/receiver-public-key.pem` is the receiver's existing RSA PUBLIC
key, initialized create-only. A different existing key is refused. Never rotate
the receiver private key while reports remain queued. `devices.json` contains
only credential hashes, bounded device records and quota counters.
`requests/<uuid>.json` is an immutable ciphertext-digest/name/device claim, retained
for idempotency even after the receiver deletes a successfully imported report.
Do not delete claims as routine cleanup: this would weaken retry identity.

## One-time approval and revocation

Settings > Feedback > **Connect this computer** shows a code valid for 15 minutes.
The owner verifies the code and computer with the requester out of band, then:

```sh
export FEEDBACK_STORAGE_ACCOUNT=wmfeedback20261122mk
npm run admin -- list
npm run admin -- approve ABCDEF123456
npm run admin -- revoke <device-uuid>
```

Admin commands use the owner's current **Azure CLI identity**, not a public HTTP
approval endpoint. Grant the owner Blob Data Contributor on `feedback-service`.
Listing shows names, IDs, states and expiry, never proof/token hashes or codes.
The desktop polls with a separate unguessable proof and stores both proof and
high-entropy upload token encrypted in its credential vault. The server stores
only their SHA-256 hashes. Disconnect revokes before removing local credentials;
an offline revocation error is explicit, so retry or use the owner CLI.

## Limits and failure semantics

* All instances share ETag/If-Match atomic state; contention fails closed with 503.
* Global: 600 requests/minute, 20 registrations/hour, at most 200 retained devices,
  200 upload attempts and 2 GiB/day. Expired pending records are removed; revoked
  records expire after 30 days. Limits use fixed UTC epoch buckets.
* Device: 20 polling requests/minute; 20 upload attempts and 200 MiB/day.
  Failed/uncertain authenticated attempts count too. Exact retries are safe but
  can require waiting for a quota reset.
* Device registration/polling bodies: 2 KiB; encrypted upload: 40 MiB, declared
  Content-Length required and actual streaming size checked. Invalid requests
  cannot consume unbounded pending state.
* Authorization/revocation and quotas are checked before reading upload bodies.
  No HTTP upload/approval forwarding or LAN fallback exists.
* Filenames remain `<request-uuid>-<sha256-plaintext>.json` for the existing
  receiver. The service validates envelope structure, RSA key length, recipient,
  request ID and base64 lengths without decrypting. An immutable request claim
  and ciphertext metadata reject mismatched retries; create-only blob writes
  never overwrite existing reports.
* Responses confirm **queued only**, never imported. After an uncertain network
  result keep the desktop dialog open: its exact ciphertext/identity is reused.
  Receiver polling/import remains independently monitored on loopback 7722.

This deliberately small service has bounded application quotas, not a distributed
DDoS shield. Anonymous floods can exhaust the global request/registration budget,
temporarily blocking legitimate pairing. Use Azure edge/WAF ingress controls and
cost alerts if operating beyond a small owner-approved deployment. Function-host
ingress caps still apply before application authentication. Set cost alerts and
monitor state contention, 429/503 rates and receiver polling errors.

## Migration and smoke validation

Keep the existing receiver `/data/public-inbox` key/config and `reports` queue.
Remove its old LAN port mappings/listeners. Revoke all previously distributed
create-only sender SAS before shipping (coordinate storage signing-key rotation
with receiver pull and Functions host storage credentials). Merely removing the
desktop paste form does not revoke old SAS.

Validate public configuration contains no SAS; pair a test desktop, observe
pending, approve, upload a harmless report, confirm queued then receiver import
as User Story, retry identical bytes, reject changed ciphertext under the same
request ID, revoke and verify the next upload is rejected. Test Windows credential
storage and pairing on an actual Windows installation before declaring Windows
runtime QA complete. Unit tests do not prove deployed Azure identity/RBAC or
receiver connectivity.
