import { createBridgeServers } from './server.ts';

const running = await createBridgeServers();

console.log(
  `[gemini-decisions-bridge] Local Decisions proxy listening on 127.0.0.1:${running.proxyPort}` +
    (running.servicePort !== null ? ` | Guest service on 127.0.0.1:${running.servicePort}` : ''),
);

const shutdown = async () => {
  await running.close();
  process.exit(0);
};

process.on('SIGINT', () => {
  void shutdown();
});
process.on('SIGTERM', () => {
  void shutdown();
});
