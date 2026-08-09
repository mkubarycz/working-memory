import { mount } from 'svelte';
import App from './App.svelte';
import CommandWidget from './lib/CommandWidget.svelte';
import './app.css';

const target = document.getElementById('app');
if (!target) {
  throw new Error('Working Memory webview: #app mount target missing');
}

// ONE bundle boots both webviews (WM 14.2.1). The host injects
// `window.__WM_VIEW__ = 'command'` for the right-rail command widget; every
// other host (the document custom editor) gets the default App dispatcher.
const view = (globalThis as { __WM_VIEW__?: string }).__WM_VIEW__;
const component = view === 'command' ? CommandWidget : App;

export default mount(component, { target });
