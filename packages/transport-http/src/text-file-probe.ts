import { createTextFileFixture } from "./text-file-fixture.js";

// Manual, isolated UI/network probe. Never binds or changes the deployed service.
const fixture = await createTextFileFixture();
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: fixture.app.fetch });
process.stdout.write(
  `${JSON.stringify({ url: server.url.toString(), path: fixture.path, cwd: fixture.root, conversationId: "local", remoteConversationId: "remote", text: fixture.text })}\n`,
);
async function stop() {
  server.stop(true);
  await fixture.dispose();
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
