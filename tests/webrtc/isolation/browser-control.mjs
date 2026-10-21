#!/usr/bin/env node
import { chromium } from "../../../packages/runway/node_modules/playwright/index.mjs";
import { execFileSync, spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const ns = process.env.WEBRTC_NETNS;
if (!ns || !process.env.RUNWAY_BROWSER_EXECUTABLE)
	throw new Error("the supervised namespace is required");
const args = ["--disable-features=WebRtcHideLocalIpsWithMdns"];
const isolated = await chromium.launch({
	executablePath: process.env.RUNWAY_BROWSER_EXECUTABLE,
	chromiumSandbox: true,
	args,
});
const outside = await chromium.launch({
	executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
	args,
});
const a = await isolated.newPage(),
	b = await outside.newPage();

async function pair() {
	const initialize = (sender) => {
		const pc = new RTCPeerConnection({
			iceServers: [],
			iceTransportPolicy: "all",
		});
		const state = { pc, received: false };
		window.__directControl = state;
		if (sender) {
			const channel = pc.createDataChannel("direct-control");
			channel.onopen = () => channel.send("local-direct-control");
			channel.onmessage = (event) => {
				if (event.data === "local-direct-control") state.received = true;
			};
		} else
			pc.ondatachannel = (event) => {
				event.channel.onmessage = (message) => event.channel.send(message.data);
			};
	};
	await a.evaluate(initialize, true);
	await b.evaluate(initialize, false);
	const local = async (offer) => {
		const pc = window.__directControl.pc;
		await pc.setLocalDescription(
			offer ? await pc.createOffer() : await pc.createAnswer()
		);
		for (
			let index = 0;
			index < 50 && pc.iceGatheringState !== "complete";
			index++
		)
			await new Promise((resolve) => setTimeout(resolve, 50));
		if (pc.iceGatheringState !== "complete")
			throw new Error("direct-control gathering did not complete");
		return pc.localDescription.toJSON();
	};
	try {
		const offer = await a.evaluate(local, true);
		if (!offer.sdp.includes(" typ host"))
			throw new Error("direct-control has no host candidates");
		await b.evaluate(
			(description) =>
				window.__directControl.pc.setRemoteDescription(description),
			offer
		);
		const answer = await b.evaluate(local, false);
		await a.evaluate(
			(description) =>
				window.__directControl.pc.setRemoteDescription(description),
			answer
		);
		try {
			await a.waitForFunction(
				() => window.__directControl.received,
				undefined,
				{ timeout: 7000 }
			);
			return true;
		} catch {
			return false;
		}
	} finally {
		await a.evaluate(() => window.__directControl.pc.close());
		await b.evaluate(() => window.__directControl.pc.close());
	}
}

try {
	const blocked = !(await pair());
	if (!blocked)
		throw new Error(
			"native browser established an unauthorized direct connection with isolation enabled"
		);
	let capture;
	if (process.env.EVIDENCE_DIR) {
		capture = spawn(
			"ip",
			[
				"netns",
				"exec",
				ns,
				"tcpdump",
				"-U",
				"-i",
				"any",
				"-nn",
				"-w",
				path.join(process.env.EVIDENCE_DIR, "negative-control.pcap"),
			],
			{ stdio: ["ignore", "ignore", "pipe"] }
		);
		await new Promise((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("negative control capture did not start")),
				5000
			);
			capture.stderr.on("data", (chunk) => {
				if (String(chunk).includes("listening on")) {
					clearTimeout(timer);
					resolve();
				}
			});
			capture.once("exit", () => {
				clearTimeout(timer);
				reject(new Error("negative control capture exited"));
			});
		});
	}
	execFileSync("ip", [
		"netns",
		"exec",
		ns,
		"nft",
		"delete",
		"table",
		"inet",
		process.env.NFT_TABLE ?? "scramjet_webrtc",
	]);
	let detectable;
	try {
		detectable = await pair();
		await new Promise((resolve) => setTimeout(resolve, 1200));
	} finally {
		execFileSync(
			"ip",
			["netns", "exec", ns, "python3", path.join(directory, "policy.py")],
			{ stdio: "inherit" }
		);
		if (capture) {
			const stopped = new Promise((resolve) => capture.once("exit", resolve));
			capture.kill("SIGINT");
			await stopped;
		}
	}
	if (!detectable)
		throw new Error(
			"negative control did not detect direct connectivity after removing isolation"
		);
	const result = {
		runId: process.env.WEBRTC_RUN_ID,
		nativeDirectBlocked: blocked,
		removedIsolationDirectDetected: detectable,
		ok: true,
	};
	console.log(JSON.stringify(result));
	if (process.env.EVIDENCE_DIR)
		await writeFile(
			path.join(process.env.EVIDENCE_DIR, "browser-direct-control.json"),
			JSON.stringify(result, null, 2) + "\n"
		);
} finally {
	await isolated.close();
	await outside.close();
}
