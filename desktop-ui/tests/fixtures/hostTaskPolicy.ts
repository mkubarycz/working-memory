import { HOST_TASK_OPERATION } from '../../../control-plane/src/hostTasks';
import { HOST_TASK_POLICY_HASH, type HostTaskPolicy } from '../../../shared/hostTasks';

export const hostTaskPolicy: HostTaskPolicy = {
  policyHash: HOST_TASK_POLICY_HASH,
  operationHash: HOST_TASK_POLICY_HASH,
  operationVersion: HOST_TASK_OPERATION.version,
  scope: HOST_TASK_OPERATION.scope,
  outputFields: HOST_TASK_OPERATION.outputFields,
  actions: HOST_TASK_OPERATION.actions,
  budgets: HOST_TASK_OPERATION.budgets,
  operation: HOST_TASK_OPERATION,
};
