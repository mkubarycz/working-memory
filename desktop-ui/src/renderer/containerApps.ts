import type { AppMcpEndpoint, ContainerAppDefinition, ContainerAppStatus } from '../shared/contracts';
import type { DocumentVM } from './documents/types';

export type { ContainerAppDefinition as ContainerAppItem } from '../shared/contracts';

export const CONTAINER_APP_DOCUMENT_KIND = 'container-app';

export function containerAppDocument(app: ContainerAppDefinition): DocumentVM {
  return {
    kind: CONTAINER_APP_DOCUMENT_KIND,
    id: app.id,
    slug: app.id,
    title: app.displayName,
    createdAt: 0,
    updatedAt: 0,
    resourceVersion: 0,
    spec: [],
  };
}

export function containerAppIdForDocument(document: DocumentVM | null): string | null {
  return document?.kind === CONTAINER_APP_DOCUMENT_KIND
    ? (document.slug ?? document.id)
    : null;
}

export function effectiveContainerAppMcp(
  app: Pick<ContainerAppDefinition, 'mcp'>,
  status: Pick<ContainerAppStatus, 'mcp'> | undefined,
): AppMcpEndpoint | undefined {
  return status === undefined ? app.mcp : status.mcp;
}

export async function loadRegisteredContainerApps(
  list: () => Promise<ContainerAppDefinition[]>,
  inspect: (id: ContainerAppDefinition['id']) => Promise<ContainerAppStatus>,
  currentEnvironment: () => unknown,
  onApps: (apps: ContainerAppDefinition[]) => void,
  onStatus: (app: ContainerAppDefinition, status: ContainerAppStatus) => void,
  onError: (error: unknown) => void,
): Promise<void> {
  const apps = await list();
  // Registry definitions are process-wide; an environment change must never discard them.
  onApps(apps);
  const environment = currentEnvironment();
  await refreshRegisteredContainerApps(
    apps,
    inspect,
    () => currentEnvironment() === environment,
    onStatus,
    onError,
  );
}

export async function refreshRegisteredContainerApps(
  apps: ContainerAppDefinition[],
  inspect: (id: ContainerAppDefinition['id']) => Promise<ContainerAppStatus>,
  isCurrent: () => boolean,
  onStatus: (app: ContainerAppDefinition, status: ContainerAppStatus) => void,
  onError: (error: unknown) => void,
): Promise<void> {
  await Promise.all(apps.map(async (app) => {
    try {
      const status = await inspect(app.id);
      if (isCurrent()) onStatus(app, status);
    } catch (error) {
      if (isCurrent()) onError(error);
    }
  }));
}
