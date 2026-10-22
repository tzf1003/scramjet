import { browserKeyClient, returnTarget } from "./access-key-client.js";

const client = browserKeyClient();
const form = document.querySelector("#login");
const button = form.querySelector("button");
const message = document.querySelector("#message");
const input = document.querySelector("#access-key");
const enter = () =>
	location.replace(returnTarget(location.search, location.origin));

form.addEventListener("submit", async (event) => {
	event.preventDefault();
	button.disabled = true;
	message.textContent = "正在验证访问密钥…";
	try {
		await client.authorize(input.value);
		input.value = "";
		enter();
	} catch (error) {
		message.textContent = error.message;
		button.disabled = false;
	}
});

if (client.load()) {
	button.disabled = true;
	message.textContent = "正在恢复访问…";
	try {
		await client.restore();
		enter();
	} catch (error) {
		message.textContent = error.message;
		button.disabled = false;
	}
}
