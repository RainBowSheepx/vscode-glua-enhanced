const vscode = require("vscode");
const http = require("http");
const https = require("https");

/**
 * Loads extra wiki data (functions, classes, libraries, hooks) from a
 * self-hosted gmodwiki instance (https://github.com/CFC-Servers/gmodwiki fork
 * with custom pages) and merges it into the bundled Facepunch wiki data, so
 * addon APIs documented on the custom wiki (e.g. Trolleybus System) get the
 * same autocomplete/hover/signature support as the official API.
 *
 * The wiki serves /gluadump.json (full data + version) and
 * /gluadump.json?check=1 (version only). The provider polls the version and
 * re-ingests automatically whenever pages change on the wiki.
 *
 * Settings:
 *   glua-enhanced.customWiki.url          base URL of the wiki ("" disables)
 *   glua-enhanced.customWiki.pollSeconds  update-check interval (0 disables)
 */
class CustomWikiProvider {
	constructor(GLua) {
		this.GLua = GLua;
		this.GLua.CustomWikiProvider = this;

		this.dump = this.GLua.extension.globalState.get("vscode-glua-custom-wiki-data");
		this.version = this.GLua.extension.globalState.get("vscode-glua-custom-wiki-version");

		// Offline start: apply the cached copy immediately, then look for updates
		if (this.dump) this.apply();
		this.refresh(true);

		this.watch();
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration("glua-enhanced.customWiki")) {
				this.watch();
				this.refresh(true);
			}
		});
	}

	config() {
		const cfg = vscode.workspace.getConfiguration("glua-enhanced");
		return {
			url: (cfg.get("customWiki.url") || "").replace(/\/+$/, ""),
			pollSeconds: cfg.get("customWiki.pollSeconds", 60),
		};
	}

	watch() {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}

		const { url, pollSeconds } = this.config();
		if (url && pollSeconds > 0) {
			this.timer = setInterval(() => this.refresh(false), Math.max(10, pollSeconds) * 1000);
		}
	}

	dispose() {
		if (this.timer) clearInterval(this.timer);
	}

	fetchJSON(url) {
		return new Promise((resolve, reject) => {
			const mod = url.startsWith("https:") ? https : http;
			const req = mod.get(url, { timeout: 10000 }, (stream) => {
				if (stream.statusCode !== 200) {
					stream.resume();
					return reject(new Error("HTTP " + stream.statusCode));
				}
				let data = "";
				stream.on("data", (chunk) => (data += chunk));
				stream.on("end", () => {
					try {
						resolve(JSON.parse(data));
					} catch (e) {
						reject(e);
					}
				});
			});
			req.on("timeout", () => req.destroy(new Error("timeout")));
			req.on("error", reject);
		});
	}

	// NB: no async/await in this file — babel targets node 7, which would pull
	// in regeneratorRuntime (not bundled) and crash the whole extension.
	refresh(force) {
		const { url } = this.config();
		if (!url) return;

		const provider = this;

		const check = !force && this.version
			? this.fetchJSON(url + "/gluadump.json?check=1").then((chk) => !chk || chk.version !== provider.version)
			: Promise.resolve(true);

		check.then((changed) => {
			if (!changed) return;

			return provider.fetchJSON(url + "/gluadump.json").then((data) => {
				if (!data || !data.wiki) return;
				// A forced refresh must re-apply even when the version string is
				// unchanged: the cached copy may predate a dump-format change.
				if (!force && data.version === provider.version && provider.applied) return;

				provider.version = data.version;
				provider.dump = data.wiki;
				provider.GLua.extension.globalState.update("vscode-glua-custom-wiki-version", provider.version);
				provider.GLua.extension.globalState.update("vscode-glua-custom-wiki-data", provider.dump);

				provider.apply();
				console.log("vscode-glua: custom wiki ingested (version " + provider.version + ")");
			});
		}).catch((e) => {
			console.warn("vscode-glua: custom wiki unavailable (" + e.message + ")");
		});
	}

	/** Merges the custom dump into `wiki` (called again after base wiki downloads). */
	mergeInto(wiki) {
		if (!this.dump) return;

		// Entries from a previously applied dump that are gone from the current
		// one (pages deleted on the wiki) must be removed, or they linger in
		// autocomplete until VS Code restarts.
		if (this.lastApplied && this.lastApplied !== this.dump) this.unmergeInto(wiki, this.lastApplied);

		for (const bucket of ["GLOBALS", "ENUMS"]) {
			if (!this.dump[bucket]) continue;
			if (!wiki[bucket]) wiki[bucket] = {};
			for (const [name, def] of Object.entries(this.dump[bucket])) wiki[bucket][name] = def;
		}

		// Buckets whose entries carry MEMBERS: merge member-by-member so custom
		// classes can extend existing ones without wiping their methods.
		for (const bucket of ["CLASSES", "LIBRARIES", "HOOKS", "PANELS", "STRUCTS"]) {
			if (!this.dump[bucket]) continue;
			if (!wiki[bucket]) wiki[bucket] = {};
			for (const [name, def] of Object.entries(this.dump[bucket])) {
				this.mergeMembers(wiki[bucket], name, def);
			}
		}

		this.lastApplied = this.dump;
	}

	/** Removes everything a previously merged dump contributed to `wiki`. */
	unmergeInto(wiki, prev) {
		for (const bucket of ["GLOBALS", "ENUMS"]) {
			if (!prev[bucket] || !wiki[bucket]) continue;
			for (const name of Object.keys(prev[bucket])) delete wiki[bucket][name];
		}

		for (const bucket of ["CLASSES", "LIBRARIES", "HOOKS", "PANELS", "STRUCTS"]) {
			if (!prev[bucket] || !wiki[bucket]) continue;
			for (const [name, def] of Object.entries(prev[bucket])) {
				this.unmergeMembers(wiki[bucket], name, def);
			}
		}
	}

	unmergeMembers(target, name, def) {
		if (!target || !(name in target)) return;

		if (!def.MEMBERS || !target[name].MEMBERS) {
			delete target[name];
			return;
		}

		const existing = target[name];
		for (const [memberName, memberDef] of Object.entries(def.MEMBERS)) {
			if (memberDef && memberDef.MEMBERS) this.unmergeMembers(existing.MEMBERS, memberName, memberDef);
			else delete existing.MEMBERS[memberName];
		}

		// A container that only existed for the overlay's members disappears
		// with them (base-wiki containers always keep their own members).
		if (Object.keys(existing.MEMBERS).length === 0) delete target[name];
	}

	mergeMembers(target, name, def) {
		if (!(name in target) || !def.MEMBERS) {
			target[name] = def;
			return;
		}

		const existing = target[name];

		// Update the container's own fields too (HOOK_ADD, EVENT_PREFIX,
		// DESCRIPTION, ...) — merging only MEMBERS would keep a stale def
		// from an older cached copy forever.
		for (const [key, value] of Object.entries(def)) {
			if (key !== "MEMBERS") existing[key] = value;
		}

		if (!existing.MEMBERS) existing.MEMBERS = {};
		for (const [memberName, memberDef] of Object.entries(def.MEMBERS)) {
			if (memberDef && memberDef.MEMBERS) this.mergeMembers(existing.MEMBERS, memberName, memberDef);
			else existing.MEMBERS[memberName] = memberDef;
		}
	}

	/** Merge into the live wiki data and rebuild completions/docs. */
	apply() {
		if (!this.dump || !this.GLua.WikiProvider || !this.GLua.CompletionProvider) return;

		this.mergeInto(this.GLua.WikiProvider.wiki);

		// createCompletionItems() re-registers every doc tag, so the doc store
		// must be reset first (same thing WikiProvider.downloadWiki does).
		for (let k in this.GLua.WikiProvider.docs) delete this.GLua.WikiProvider.docs[k];
		this.GLua.CompletionProvider.createCompletionItems();
		this.applied = true;
	}
}

module.exports = CustomWikiProvider;
