import type { ContainerAppId } from '../shared/contracts';

export interface ContainerAppItem {
  id: ContainerAppId;
  displayName: string;
  icon: string;
}

export const CONTAINER_APPS: ContainerAppItem[] = [
  { id: 'clarinet-hero', displayName: 'Claranet Hero', icon: 'server-environment' },
];
