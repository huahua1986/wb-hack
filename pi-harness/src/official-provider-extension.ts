// A TypeScript entry is intentional: Pi's jiti loader resolves this static
// import to its own bundled pi-ai instance, even outside PiEngine/node_modules.
import { streamSimple } from '@earendil-works/pi-ai';
import { createOfficialProvider } from './official-provider-extension.mjs';
import { OfficialBridgeClient, OFFICIAL_READY } from './official-bridge.mjs';

export default async function officialProviderExtension(pi) {
  const directory = process.env.WORKBUDDY_PI_OFFICIAL_BRIDGE_DIR;
  const requestContextFile = process.env.WORKBUDDY_PI_REQUEST_CONTEXT_FILE;
  if (!requestContextFile) throw new Error('Official request context is unavailable');
  const bridge = new OfficialBridgeClient(directory, { requestContextFile });
  const contextWindows = JSON.parse(process.env.WORKBUDDY_PI_CONTEXT_WINDOWS ?? '{}');
  pi.registerProvider(await createOfficialProvider({ directory, bridge, streamSimple, contextWindows }));
  pi.on('session_start', (_event, ctx) => { if (ctx.mode === 'rpc') ctx.ui.notify(OFFICIAL_READY, 'info'); });
}
