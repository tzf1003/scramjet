import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { test } from "node:test";
import { stopHttpFixture } from "../../../packages/runway/src/http-fixture.ts";

test(
	"HTTP fixture disposal closes unfinished requests and idle TCP clients",
	{ timeout: 3000 },
	async () => {
		const server = http.createServer(() => {});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const { port } = server.address() as net.AddressInfo;
		const request = net.connect(port, "127.0.0.1");
		const idle = net.connect(port, "127.0.0.1");
		try {
			await Promise.all([once(request, "connect"), once(idle, "connect")]);
			const received = once(server, "request");
			request.write("GET /pending HTTP/1.1\r\nHost: localhost\r\n\r\n");
			await received;
			const closed = [once(request, "close"), once(idle, "close")];
			await stopHttpFixture(server);
			await Promise.all(closed);
			assert.equal(server.listening, false);
		} finally {
			request.destroy();
			idle.destroy();
			server.closeAllConnections();
			server.close();
		}
	}
);
