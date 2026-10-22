document.querySelector("#open").addEventListener("submit", (event) => {
	event.preventDefault();
	try {
		let input = document.querySelector("#url").value.trim();
		if (!/^[a-z][a-z0-9+.-]*:/i.test(input)) input = "https://" + input;
		const target = new URL(input);
		if (
			!["http:", "https:"].includes(target.protocol) ||
			target.username ||
			target.password
		)
			throw new Error("请输入有效的 HTTP 或 HTTPS 网址。");
		const entry = new URL("/", location.origin);
		entry.searchParams.set("__scramjet_url", target.href);
		location.assign(entry);
	} catch (error) {
		document.querySelector("#message").textContent = error.message;
	}
});
document.querySelector("#logout").addEventListener("click", async () => {
	const message = document.querySelector("#message");
	try {
		const response = await fetch("/api/logout", {
			method: "POST",
			credentials: "same-origin",
		});
		if (!response.ok) throw new Error("退出失败，请重试");
		browserKeyClient().forget();
		location.replace("/login");
	} catch (error) {
		message.textContent = error.message;
	}
});
import { browserKeyClient } from "./access-key-client.js";
