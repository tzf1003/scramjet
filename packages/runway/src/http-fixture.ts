import type { Server } from "node:http";

/** Dispose HTTP fixtures even when a client holds an unfinished request open. */
export function stopHttpFixture(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
		// Call after close() so new connections cannot race with disposal.
		server.closeAllConnections();
	});
}
