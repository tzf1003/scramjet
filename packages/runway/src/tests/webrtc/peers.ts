import type { Frame, Page } from "playwright";
import { isIP } from "node:net";

type Endpoint = Frame | Page;
type PeerState = {
	pc: RTCPeerConnection;
	channel?: RTCDataChannel;
	echoes: string[];
	candidates: string[];
	iceErrors: Array<{ code: number; text: string }>;
	negotiations: number;
};
declare global {
	interface Window {
		__webrtcPeer: PeerState;
	}
}

// These functions are passed to Playwright evaluate: keep browser code self-contained.
export function initializeDataPeer({
	config,
	sender,
	prototypeConstructor = false,
}: {
	config: RTCConfiguration;
	sender: boolean;
	prototypeConstructor?: boolean;
}) {
	const Constructor = prototypeConstructor
		? (RTCPeerConnection.prototype.constructor as typeof RTCPeerConnection)
		: RTCPeerConnection;
	const pc = new Constructor(config);
	const state: PeerState = {
		pc,
		echoes: [],
		candidates: [],
		iceErrors: [],
		negotiations: 0,
	};
	window.__webrtcPeer = state;
	pc.onnegotiationneeded = () => {
		state.negotiations++;
	};
	pc.onicecandidate = (event) => {
		if (event.candidate?.candidate)
			state.candidates.push(event.candidate.candidate);
	};
	pc.onicecandidateerror = (event) =>
		state.iceErrors.push({ code: event.errorCode, text: event.errorText });
	const attach = (channel: RTCDataChannel) => {
		state.channel = channel;
		channel.onmessage = (event) => {
			if (sender) state.echoes.push(String(event.data));
			else channel.send(event.data);
		};
		if (sender) channel.onopen = () => channel.send("direct-path-control");
	};
	if (sender) attach(pc.createDataChannel("probe"));
	else pc.ondatachannel = (event) => attach(event.channel);
}

export async function peerDescription({
	offer,
	restart = false,
	waitMs = 4000,
}: {
	offer: boolean;
	restart?: boolean;
	waitMs?: number;
}) {
	const pc = window.__webrtcPeer.pc;
	await pc.setLocalDescription(
		offer
			? await pc.createOffer({ iceRestart: restart })
			: await pc.createAnswer()
	);
	if (pc.iceGatheringState !== "complete") {
		await new Promise<void>((resolve) => {
			const finish = () => {
				clearTimeout(timer);
				pc.removeEventListener("icegatheringstatechange", changed);
				resolve();
			};
			const changed = () => {
				if (pc.iceGatheringState === "complete") finish();
			};
			const timer = setTimeout(finish, waitMs);
			pc.addEventListener("icegatheringstatechange", changed);
		});
	}
	return {
		description: pc.localDescription!.toJSON(),
		gathering: pc.iceGatheringState,
	};
}

export async function negotiateDataPeers(
	a: Endpoint,
	b: Endpoint,
	restart = false,
	directHost?: string
) {
	if (directHost && isIP(directHost) !== 4)
		throw new Error("direct-control host must be an IPv4 address");
	const forRemote = (description: RTCSessionDescriptionInit) => ({
		...description,
		// Both fixture peers run on this host. Resolve their mDNS candidates
		// in signaling using the runner's explicit interface address.
		sdp: directHost
			? description.sdp?.replace(
					/^(a=candidate:\S+\s+\d+\s+\S+\s+\d+\s+)\S+\.local(?=\s)/gm,
					(_, prefix: string) => prefix + directHost
				)
			: description.sdp,
	});
	const offer = await a.evaluate(peerDescription, { offer: true, restart });
	await b.evaluate(
		(sdp) => window.__webrtcPeer.pc.setRemoteDescription(sdp),
		forRemote(offer.description)
	);
	const answer = await b.evaluate(peerDescription, { offer: false });
	await a.evaluate(
		(sdp) => window.__webrtcPeer.pc.setRemoteDescription(sdp),
		forRemote(answer.description)
	);
	return { offer, answer };
}

export async function expectDataEcho(
	endpoint: Endpoint,
	message = "direct-path-control",
	timeout = 10000
) {
	try {
		await endpoint.waitForFunction(
			(value) => window.__webrtcPeer.echoes.includes(value),
			message,
			{ timeout }
		);
	} catch (error) {
		const state = await endpoint.evaluate(readDataPeer);
		const { sdp: _sdp, username: _username, ...diagnostic } = state;
		throw new Error(
			`DataChannel echo failed: ${JSON.stringify(diagnostic)} (${String(error)})`
		);
	}
}

export async function readDataPeer() {
	const state = window.__webrtcPeer;
	const localTypes: string[] = [];
	(await state.pc.getStats()).forEach((stat) => {
		if (stat.type === "local-candidate") localTypes.push(stat.candidateType);
	});
	return {
		negotiations: state.negotiations,
		username: state.pc.getConfiguration().iceServers?.[0]?.username,
		connection: state.pc.connectionState,
		ice: state.pc.iceConnectionState,
		gathering: state.pc.iceGatheringState,
		signaling: state.pc.signalingState,
		mediaSection: /^m=application/m.test(state.pc.localDescription?.sdp ?? ""),
		channel: state.channel?.readyState,
		echoes: state.echoes,
		candidates: state.candidates,
		iceErrors: state.iceErrors,
		credentialRemainingMs:
			Number(
				state.pc.getConfiguration().iceServers?.[0]?.username?.split(":")[0]
			) *
				1000 -
			Date.now(),
		localTypes,
		sdp: state.pc.localDescription?.sdp ?? "",
	};
}

export async function closeDataPeers(...endpoints: Endpoint[]) {
	await Promise.all(
		endpoints.map((endpoint) =>
			endpoint.evaluate(() => window.__webrtcPeer?.pc.close()).catch(() => {})
		)
	);
}
