import { ResourceRegistry } from '../framework/registry.js';
import { noteResource } from './resources/note.js';

export function createRegistry(): ResourceRegistry {
  return new ResourceRegistry()
    .register(noteResource);
}
