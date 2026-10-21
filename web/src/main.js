import { mount } from 'svelte';
import './app.css';
import App from './App.svelte';

const start = () => mount(App, { target: document.getElementById('app') });

// No-install demo (npm run build:demo): canned /api answers + a live fake swarm.
// The condition is a build-time constant, so the real build drops this branch.
if (import.meta.env.VITE_DEMO === '1') import('./demo-shim.js').then(start);
else start();
