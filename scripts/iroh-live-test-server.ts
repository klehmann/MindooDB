/**
 * Start a MindooDBServer with Iroh enabled and print one JSON line of
 * connection info. Used by Haven's live Playwright spec.
 *
 *   pnpm iroh:live-server
 *
 * After ready, stdin accepts JSON commands:
 *   {"cmd":"touch"}  — write a directory document and push (change feed)
 */
import { createInterface } from "node:readline";
import {
  mintLiveAdminToken,
  startIrohLiveServer,
  touchLiveDirectory,
} from "../src/__tests__/_helpers/irohLiveServer";

async function main() {
  const live = await startIrohLiveServer();
  const feedToken = await mintLiveAdminToken(live);
  process.stdout.write(`${JSON.stringify({ ready: true, ...live.info, feedToken })}\n`);

  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    void (async () => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }
      try {
        const command = JSON.parse(trimmed) as { cmd?: string };
        if (command.cmd === "touch") {
          const result = await touchLiveDirectory(live);
          process.stdout.write(`${JSON.stringify({ touched: true, ...result })}\n`);
          return;
        }
        process.stdout.write(`${JSON.stringify({ error: `unknown command ${command.cmd ?? ""}` })}\n`);
      } catch (error) {
        process.stdout.write(
          `${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`,
        );
      }
    })();
  });

  const shutdown = async () => {
    lines.close();
    await live.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => {
    void shutdown();
  });
  process.on("SIGINT", () => {
    void shutdown();
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
