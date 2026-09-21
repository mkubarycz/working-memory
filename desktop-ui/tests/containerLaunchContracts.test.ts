import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const desktopRoot = resolve(import.meta.dirname, '..');

describe('container app contracts and renderer', () => {
  it('connects typed preload IPC to run, inspect, stop, and open handlers', () => {
    const contracts = readFileSync(resolve(desktopRoot, 'src/shared/contracts.ts'), 'utf8');
    const preload = readFileSync(resolve(desktopRoot, 'src/preload/index.ts'), 'utf8');
    const main = readFileSync(resolve(desktopRoot, 'src/main/index.ts'), 'utf8');
    const app = readFileSync(resolve(desktopRoot, 'src/renderer/App.svelte'), 'utf8');

    expect(contracts).toContain('runContainerApp(id: ContainerAppId): Promise<ContainerLaunchResult>');
    expect(contracts).toContain('inspectContainerApp(id: ContainerAppId): Promise<ContainerAppStatus>');
    expect(contracts).toContain('stopContainerApp(id: ContainerAppId): Promise<ContainerStopResult>');
    expect(contracts).toContain('openContainerApp(id: ContainerAppId): Promise<ContainerAppStatus>');
    expect(preload).toContain("runContainerApp: (id) => invoke('container:run', id)");
    expect(preload).toContain("inspectContainerApp: (id) => invoke('container:inspect', id)");
    expect(preload).toContain("stopContainerApp: (id) => invoke('container:stop', id)");
    expect(preload).toContain("openContainerApp: (id) => invoke('container:open', id)");
    expect(main).toContain("ipcMain.handle('container:run'");
    expect(main).toContain("ipcMain.handle('container:inspect'");
    expect(main).toContain("ipcMain.handle('container:stop'");
    expect(main).toContain("ipcMain.handle('container:open'");
    expect(main).toContain('requireContainerAppId(rawId)');
    expect(main).toContain('const scope = beginContainerOperation()');
    expect(main).toContain('clarinetHeroClaim(scope.client)');
    expect(main).toContain('containerEnvironmentGeneration += 1');
    expect(main).toContain('for (const operation of containerOperations) operation.abort()');
    expect(main).toContain("url.hostname !== 'localhost'");
    expect(app).toContain('<ContainerAppStrip');
  });

  it('keeps accessible Log and Container Apps panels mounted while hiding the inactive panel', () => {
    const app = readFileSync(resolve(desktopRoot, 'src/renderer/App.svelte'), 'utf8');
    const strip = readFileSync(resolve(desktopRoot, 'src/renderer/ContainerAppStrip.svelte'), 'utf8');
    const detail = readFileSync(resolve(desktopRoot, 'src/renderer/ContainerAppDetail.svelte'), 'utf8');
    const model = readFileSync(resolve(desktopRoot, 'src/renderer/containerApps.ts'), 'utf8');
    const styles = readFileSync(resolve(desktopRoot, 'src/renderer/style.css'), 'utf8');

    expect(app.indexOf('>Log</button>')).toBeLessThan(app.indexOf('>Container Apps</button>'));
    expect(app).toContain('role="tablist" aria-label="Desktop views"');
    expect(app).toContain('id="desktop-tab-log"');
    expect(app).toContain('aria-controls="desktop-panel-log"');
    expect(app).toContain('id="desktop-panel-log"');
    expect(app).toContain('aria-labelledby="desktop-tab-log"');
    expect(app).toContain('id="desktop-tab-container-apps"');
    expect(app).toContain('aria-controls="desktop-panel-container-apps"');
    expect(app).toContain('id="desktop-panel-container-apps"');
    expect(app).toContain('aria-labelledby="desktop-tab-container-apps"');
    expect(app.match(/id="desktop-panel-log"/g)).toHaveLength(1);
    expect(app.match(/id="desktop-panel-container-apps"/g)).toHaveLength(1);
    expect(app).toContain("hidden={activeHeaderTab !== 'log'}");
    expect(app).toContain("inert={activeHeaderTab !== 'log'}");
    expect(app).toContain("hidden={activeHeaderTab !== 'container-apps'}");
    expect(app).toContain("inert={activeHeaderTab !== 'container-apps'}");
    expect(app).not.toContain("{#if activeHeaderTab === 'log'}");
    expect(styles).toContain('.chat-rail [hidden] { display: none !important; }');
    expect(app).toContain("let activeHeaderTab = $state<HeaderTab>('log');");
    expect(app).toContain("['log', 'container-apps']");
    expect(app).toContain("event.key === 'ArrowLeft'");
    expect(app).toContain("event.key === 'ArrowRight'");
    expect(app).toContain("event.key === 'Home'");
    expect(app).toContain("event.key === 'End'");
    expect(app).toContain("event.key === 'Enter' || event.key === ' '");
    expect(app).toContain("document.getElementById(`desktop-tab-${tab}`)?.focus()");
    expect(app.indexOf('<ContainerAppStrip')).toBeGreaterThan(app.indexOf('id="desktop-panel-container-apps"'));
    expect(app.match(/<ContainerAppDetail/g)).toHaveLength(1);
    expect(app).toContain('openContainerAppDetail(app)');
    expect(model).toContain('export const CONTAINER_APPS');
    expect(model).toContain("displayName: 'Claranet Hero'");
    expect(strip).toContain('{#each apps as app (app.id)}');
    expect(strip).toContain('aria-haspopup="menu"');
    expect(strip).toContain("['ArrowDown', 'ArrowUp', 'Home', 'End']");
    expect(strip).toContain("event.key === 'Escape'");
    expect(strip).toContain('menuButtonElement?.focus()');
    expect(app).toContain('containerAppStatuses[app.id] = status');
    expect(app).toContain('containerAppStatuses = reset.containerAppStatuses');
    expect(app).toContain("activateHeaderTab('container-apps')");
    expect(app).toContain("activateHeaderTab('log')");
    expect(app).toContain("let containerAppError = $state('');");
    expect(styles).toContain('@media (max-width: 760px)');
    for (const action of ['Run', 'Open App', 'Stop', 'Refresh Status']) expect(strip).toContain(`>${action}</button>`);
    for (const field of ['Claim title', 'Claim', 'Repository', 'Build context', 'Image', 'Container', 'Docker context', 'State / health', 'Ports', 'URL', 'Last action']) {
      expect(detail).toContain(`['${field}'`);
    }
  });
});
