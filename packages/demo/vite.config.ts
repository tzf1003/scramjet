import { viteStaticCopy } from "vite-plugin-static-copy";
import { defineConfig, loadEnv } from "vite";
import { existsSync } from "node:fs";
import {
	DEFAULT_PROXY_DOMAIN,
	normalizeProxyDomain,
	PROXY_RESOURCE_PATH,
} from "./src/routing.ts";

export default defineConfig(({ mode }) => {
	const env = { ...loadEnv(mode, import.meta.dirname, ""), ...process.env };
	const proxyDomain = normalizeProxyDomain(
		env.VITE_PROXY_DOMAIN || DEFAULT_PROXY_DOMAIN
	);
	const externalBuild = existsSync("/Volumes/1T")
		? "/Volumes/1T/scramjet/build/demo"
		: undefined;
	return {
		cacheDir: externalBuild
			? `${externalBuild}/vite-cache`
			: "node_modules/.vite",
		build: {
			outDir:
				env.SCRAMJET_DEMO_OUT_DIR ||
				(externalBuild ? `${externalBuild}/dist` : "dist"),
			emptyOutDir: true,
		},
		server: {
			host: "0.0.0.0",
			allowedHosts: [`.${proxyDomain}`],
			proxy: {
				"/wisp/": {
					target: `ws://127.0.0.1:${env.WISP_PORT || 4142}`,
					ws: true,
				},
			},
		},
		plugins: [
			{
				name: "wildcard-document-entry",
				configureServer(server) {
					server.middlewares.use((req, _res, next) => {
						const pathname = new URL(req.url || "/", "http://localhost")
							.pathname;
						if (
							(req.method === "GET" || req.method === "HEAD") &&
							req.headers.accept?.includes("text/html") &&
							!PROXY_RESOURCE_PATH.test(pathname)
						) {
							// Serve the shell for target paths, including paths with file extensions.
							req.url = "/index.html";
						}
						next();
					});
				},
			},
			viteStaticCopy({
				structured: false,
				targets: [
					{
						src: "node_modules/@mercuryworkshop/scramjet/dist/*",
						dest: "scramjet",
					},
					{
						src: "node_modules/@mercuryworkshop/scramjet-controller/dist/*",
						dest: "controller",
					},
				],
				watch: {
					reloadPageOnChange: true,
				},
			}),
		],
	};
});
