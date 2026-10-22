// Drives the startup overlay in index.html. It stays above the iframe until
// the proxied document has content, then fades out.

const SLOW_AFTER = 8000;

const root = document.querySelector<HTMLElement>(".loader")!;
const bar = root.querySelector<HTMLElement>(".loader__bar span")!;
const host = root.querySelector<HTMLElement>(".loader__host")!;
const status = root.querySelector<HTMLElement>(".loader__status")!;
const hint = root.querySelector<HTMLElement>(".loader__hint")!;
const retry = root.querySelector<HTMLButtonElement>(".loader__retry")!;

let finished = false;
const slowTimer = setTimeout(() => {
	if (!finished) hint.textContent = "网络有点慢，仍在努力加载…";
}, SLOW_AFTER);

retry.addEventListener("click", () => location.reload());

export function showHost(name: string) {
	host.querySelector("span")!.textContent = name;
	host.hidden = false;
}

export function setStage(text: string, progress: number) {
	if (finished) return;
	status.textContent = text;
	bar.style.transform = `scaleX(${progress})`;
}

export function finishLoading() {
	if (finished) return;
	finished = true;
	clearTimeout(slowTimer);
	bar.style.transform = "scaleX(1)";
	root.dataset.state = "done";
	const remove = () => root.remove();
	root.addEventListener("transitionend", remove, { once: true });
	// transitionend never fires when motion is reduced or the tab is hidden.
	setTimeout(remove, 600);
}

export function failLoading(message: string) {
	finished = true;
	clearTimeout(slowTimer);
	root.dataset.state = "error";
	status.textContent = "网页加载失败";
	hint.textContent = message;
	retry.hidden = false;
	root.querySelector(".loader__body")!.setAttribute("role", "alert");
	const app = document.getElementById("app")!;
	app.replaceChildren(root);
	retry.focus();
}
