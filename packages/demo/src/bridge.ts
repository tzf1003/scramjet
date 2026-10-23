// Handoff bridge entry: loads only the receiver, not the proxy runtime, so a
// first visit to a new proxy hostname answers within the handoff timeout.
import { receiveHandoff } from "./handoff";
import { DEFAULT_PROXY_DOMAIN, normalizeProxyDomain } from "./routing";

receiveHandoff(
	new URL(location.href),
	normalizeProxyDomain(
		import.meta.env.VITE_PROXY_DOMAIN || DEFAULT_PROXY_DOMAIN
	)
);
