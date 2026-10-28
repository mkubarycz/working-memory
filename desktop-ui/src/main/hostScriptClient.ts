import { z } from 'zod';
import { HostTaskAdminClient } from './hostTaskBroker';
import {
  scriptJobSchema, scriptLeaseSchema, scriptSnapshotSchema, scriptTaskSchema, scriptDetailsSchema, scriptVersionSchema,
  type ScriptDefinition, type ScriptArguments,
} from '../../../control-plane/src/hostScriptPolicy';

export class HostScriptAdminClient extends HostTaskAdminClient {
  async scripts() { return scriptSnapshotSchema.parse(await this.request('/scripts')); }
  async script(id: string) { return scriptDetailsSchema.parse(await this.request(`/scripts/${z.string().uuid().parse(id)}`)); }
  async saveScriptVersion(id: string, definition: ScriptDefinition, expectedLatestVersion?: number) {
    const path = `/scripts/${z.string().uuid().parse(id)}`;
    return scriptVersionSchema.parse(await this.request(expectedLatestVersion === undefined ? path : `${path}/versions`,
      expectedLatestVersion === undefined ? definition : { definition, expectedLatestVersion }));
  }
  async publishScriptVersion(id: string, version: number, expectedPublishedHash: string) {
    return scriptTaskSchema.parse(await this.request(`/scripts/${z.string().uuid().parse(id)}/publish`, { version, expectedPublishedHash }));
  }
  async registerScript(definition: ScriptDefinition) {
    return scriptTaskSchema.parse(await this.request('/scripts', definition));
  }
  async grantScript(input: { taskId: string; definitionHash: string; appId: string; expiresAt: number }): Promise<void> {
    await this.request('/scripts/grants', input);
  }
  async revokeScript(id: string): Promise<void> { await this.request(`/scripts/${z.string().uuid().parse(id)}/revoke`, {}); }
  async revokeScriptGrant(id: string): Promise<void> { await this.request(`/scripts/grants/${z.string().uuid().parse(id)}/revoke`, {}); }
  async testScript(input: { taskId: string; definitionHash: string; parameters: ScriptArguments; idempotencyKey: string }) {
    return scriptJobSchema.parse(await this.request('/scripts/test', input));
  }
  async startTest(input: { taskId: string; version: number; definitionHash: string; parameters: ScriptArguments; idempotencyKey: string; hostId: string }) {
    return scriptLeaseSchema.parse(await this.request('/scripts/test/claim', input));
  }
  async claimScript(hostId: string) { return scriptLeaseSchema.nullable().parse(await this.request('/scripts/claim', { hostId })); }
  async scriptJob(id: string) { return scriptJobSchema.parse(await this.request(`/scripts/jobs/${z.string().uuid().parse(id)}`)); }
  async completeScript(input: { jobId: string; leaseToken: string; resultJson?: string; error?: string }) {
    return scriptJobSchema.parse(await this.request('/scripts/complete', input));
  }
}
