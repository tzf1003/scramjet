import ipaddr from "ipaddr.js";

// Forwarded identity is accepted only from an explicitly configured TCP peer.
export function createClientIp(trustedProxyCidrs = "") {
	const trusted = trustedProxyCidrs
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean)
		.map((value) => ipaddr.parseCIDR(value));
	const parse = (value) => {
		try {
			return typeof value === "string" ? ipaddr.process(value) : null;
		} catch {
			return null;
		}
	};
	return (req) => {
		const peer = parse(req.socket.remoteAddress);
		if (!peer) return "unknown-peer";
		if (
			trusted.some(
				([network, bits]) =>
					peer.kind() === network.kind() && peer.match(network, bits)
			)
		) {
			const forwarded = parse(req.headers["x-real-ip"]);
			if (forwarded) return forwarded.toString();
		}
		return peer.toString();
	};
}
