import type { ContainerClaim } from '../../../shared/controlPlaneClient';
import type { ContainerAppDefinition } from '../shared/contracts';

export function containerAppRegistration(id: string, claims: ContainerClaim[]): ContainerClaim {
  const claim = claims.find((candidate) => candidate.id === id && candidate.runtime);
  if (!claim) throw new Error(`Unsupported container app: ${id}. No live Docker ContainerClaim exists.`);
  return claim;
}

export function containerAppDefinitions(claims: ContainerClaim[]): ContainerAppDefinition[] {
  return claims.filter((claim) => claim.runtime).map((claim) => {
    const embeddable = claim.desktop?.embeddable ?? false;
    return {
      id: claim.id,
      displayName: claim.title,
      icon: claim.desktop?.icon ?? 'server-environment',
      ...(embeddable ? { embeddable } : {}),
      ...(claim.mcp ? { mcp: claim.mcp } : {}),
      ...(claim.application ? { application: claim.application } : {}),
    };
  });
}

export function isContainerAppId(id: string, claims: ContainerClaim[]): boolean {
  return claims.some((claim) => claim.id === id && claim.runtime);
}

export function isRegisteredContainerAppUiUrl(
  rawUrl: string,
  apps: Array<Pick<ContainerClaim, 'application' | 'runtime'>>,
): boolean {
  let candidate: URL;
  try {
    candidate = new URL(rawUrl);
  } catch {
    return false;
  }
  if (
    candidate.protocol !== 'http:'
    || (candidate.hostname !== '127.0.0.1' && candidate.hostname !== 'localhost')
  ) return false;
  return apps.some((app) => {
    const uiUrl = app.application?.uiUrl ?? (app.runtime
      ? `http://localhost:${app.runtime.hostPort}${app.runtime.entryPath}`
      : undefined);
    if (!uiUrl) return false;
    const registered = new URL(uiUrl);
    return candidate.origin === registered.origin
      && (candidate.pathname === registered.pathname
        || candidate.pathname.startsWith(registered.pathname.endsWith('/')
          ? registered.pathname
          : `${registered.pathname}/`));
  });
}
