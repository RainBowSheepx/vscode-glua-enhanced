const vscode = require("vscode");

// NB: no async/await in this file — babel targets node 7, which would pull
// in regeneratorRuntime (not bundled) and crash the whole extension.

const ADD_LABEL = "$(add) Add a new custom wiki URL…";

module.exports = ['glua-enhanced.switchCustomWiki', function() {
	const GLua = this.GLua;
	const cfg = vscode.workspace.getConfiguration("glua-enhanced");
	const active = (cfg.get("customWiki.url") || "").replace(/\/+$/, "");

	const known = [];
	const push = (u) => {
		u = (u || "").replace(/\/+$/, "");
		if (u.length > 0 && known.indexOf(u) === -1) known.push(u);
	};
	push(active);
	(cfg.get("customWiki.urls") || []).forEach(push);

	const items = known.map((u) => ({
		label: u,
		description: u === active ? "active" : "",
	}));
	items.push({ label: ADD_LABEL, description: "" });

	const activate = (url) => {
		if (url === active) return;
		// Keep the previous wiki in the known list so it stays switchable.
		const urls = known.filter((u) => u !== url);
		Promise.resolve(cfg.update("customWiki.urls", urls, vscode.ConfigurationTarget.Global))
			.then(() => cfg.update("customWiki.url", url, vscode.ConfigurationTarget.Global))
			.then(() => vscode.window.showInformationMessage("Custom wiki switched to " + url));
	};

	vscode.window.showQuickPick(items, { placeHolder: "Select the active custom wiki (documentation source)" }).then((picked) => {
		if (!picked) return;

		if (picked.label === ADD_LABEL) {
			vscode.window.showInputBox({
				prompt: "Base URL of a self-hosted gmodwiki instance (serves /gluadump.json)",
				placeHolder: "http://127.0.0.1:4321",
				validateInput: (v) => (/^https?:\/\/.+/i.test((v || "").trim()) ? undefined : "Enter an http(s):// URL"),
			}).then((input) => {
				if (!input) return;
				const url = input.trim().replace(/\/+$/, "");
				push(url);
				activate(url);
			});
			return;
		}

		activate(picked.label);
	});
}];
