import http from "node:http";
import { WebSocketServer, type WebSocket } from "ws";

export type TurnCredentials = {
	urls: string[];
	username: string;
	credential: string;
	ttl: number;
};

const TURN_CREDENTIALS_URL =
	process.env.TURN_CREDENTIALS_URL ?? "http://127.0.0.1:18081/turn-credentials";
const TURN_HOST = process.env.RUNWAY_TURN_HOST;

export async function fetchTurnCredentials(): Promise<TurnCredentials> {
	const response = await fetch(TURN_CREDENTIALS_URL, {
		headers: { origin: "http://localhost:4500" },
	});
	if (!response.ok) {
		throw new Error(`credential endpoint returned ${response.status}`);
	}
	const data = (await response.json()) as TurnCredentials;
	if (!Array.isArray(data.urls) || !data.username || !data.credential) {
		throw new Error("credential endpoint returned an invalid payload");
	}
	if (TURN_HOST) {
		data.urls = data.urls.map((url) => url.replace("127.0.0.1", TURN_HOST));
	}
	return data;
}

export type Signaling = {
	port: number;
	close(): Promise<void>;
};

/**
 * Relay offers/answers/candidates between two browser pages. Kept on its own
 * port so ordinary target-document requests never pass through Node's HTTP
 * upgrade path (libcurl's request can otherwise be mistaken for an upgrade).
 */
export async function createSignaling(): Promise<Signaling> {
	const server = http.createServer((_request, response) => {
		response.writeHead(426, { "content-type": "text/plain" });
		response.end("websocket signaling only");
	});
	const wss = new WebSocketServer({ server });
	const sockets = new Map<string, WebSocket>();

	wss.on("connection", (ws, request) => {
		const url = new URL(request.url ?? "/", "http://localhost");
		const role = url.searchParams.get("role");
		const roleMatch = role ? /^([AB])(\d*)$/.exec(role) : null;
		if (!role || !roleMatch) {
			ws.close(1008, "role required");
			return;
		}
		const suffix = roleMatch[2];
		const peerRole = `${roleMatch[1] === "A" ? "B" : "A"}${suffix}`;
		sockets.set(role, ws);
		ws.on("message", (data) => {
			sockets.get(peerRole)?.send(data.toString());
		});
		ws.on("close", () => {
			if (sockets.get(role) === ws) sockets.delete(role);
		});
		if (sockets.has(role) && sockets.has(peerRole)) {
			sockets.get(role)?.send(JSON.stringify({ type: "peer-ready" }));
			sockets.get(peerRole)?.send(JSON.stringify({ type: "peer-ready" }));
		}
	});

	const listening = Promise.withResolvers<void>();
	server.listen(0, "0.0.0.0", listening.resolve);
	await listening.promise;

	return {
		port: (server.address() as { port: number }).port,
		async close() {
			for (const ws of sockets.values()) ws.terminate();
			sockets.clear();
			const closed = Promise.withResolvers<void>();
			server.close(closed.resolve);
			await closed.promise;
		},
	};
}
