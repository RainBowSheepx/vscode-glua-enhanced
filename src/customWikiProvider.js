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
 *   glua-enhanced.customWiki.url          base URL of the ACTIVE wiki ("" disables)
 *   glua-enhanced.customWiki.urls         known wiki URLs for the switch command
 *   glua-enhanced.customWiki.pollSeconds  update-check interval (0 disables)
 *
 * Only one wiki is merged at a time; the "GLua Enhanced: Switch Custom Wiki"
 * command changes customWiki.url and the provider swaps the overlays. Dumps
 * are cached per URL, so switching back to a wiki works offline.
 */
const KEY_DATA = "vscode-glua-custom-wiki-data:";
const KEY_VERSION = "vscode-glua-custom-wiki-version:";

class CustomWikiProvider {
	constructor(GLua) {
		this.GLua = GLua;
		this.GLua.CustomWikiProvider = this;

		this.activeUrl = this.config().url;
		this.loadCache(this.activeUrl);
		if (!this.dump && this.activeUrl) {
			// one-time migration of the pre-multi-wiki single-slot cache; it can
			// only have belonged to the URL that was configured at startup
			const gs = this.GLua.extension.globalState;
			this.dump = gs.get("vscode-glua-custom-wiki-data");
			this.version = this.dump ? gs.get("vscode-glua-custom-wiki-version") : undefined;
		}

		// Offline start: apply the cached copy immediately, then look for updates
		if (this.dump) this.apply();
		this.refresh(true);

		this.watch();
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration("glua-enhanced.customWiki")) {
				const { url } = this.config();
				if (url !== this.activeUrl) {
					this.switchTo(url);
				} else {
					this.watch();
					this.refresh(true);
				}
			}
		});
	}

	config() {
		const cfg = vscode.workspace.getConfiguration("glua-enhanced");
		const url = (cfg.get("customWiki.url") || "").replace(/\/+$/, "");
		const urls = (cfg.get("customWiki.urls") || [])
			.map((u) => (u || "").replace(/\/+$/, ""))
			.filter((u) => u.length > 0);
		return {
			url,
			urls,
			pollSeconds: cfg.get("customWiki.pollSeconds", 60),
		};
	}

	loadCache(url) {
		const gs = this.GLua.extension.globalState;
		this.dump = url ? gs.get(KEY_DATA + url) : undefined;
		this.version = this.dump ? gs.get(KEY_VERSION + url) : undefined;
	}

	/** Makes `url` the active wiki: unmerges the old overlay, applies the new one's cache, fetches updates. */
	switchTo(url) {
		if (this.lastApplied && this.GLua.WikiProvider) {
			this.unmergeInto(this.GLua.WikiProvider.wiki, this.lastApplied);
			this.lastApplied = undefined;
		}

		this.activeUrl = url;
		this.applied = false;
		this.loadCache(url);

		if (this.dump) {
			this.apply();
		} else if (this.GLua.WikiProvider && this.GLua.CompletionProvider) {
			// rebuild completions/docs without the previous wiki's entries
			for (let k in this.GLua.WikiProvider.docs) delete this.GLua.WikiProvider.docs[k];
			this.GLua.CompletionProvider.createCompletionItems();
		}

		this.watch();
		this.refresh(true);
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
				// The user may have switched wikis while this request was in
				// flight — a stale response must not clobber the new overlay.
				if (provider.activeUrl !== url) return;
				// A forced refresh must re-apply even when the version string is
				// unchanged: the cached copy may predate a dump-format change.
				if (!force && data.version === provider.version && provider.applied) return;

				provider.version = data.version;
				provider.dump = data.wiki;
				provider.GLua.extension.globalState.update(KEY_VERSION + url, provider.version);
				provider.GLua.extension.globalState.update(KEY_DATA + url, provider.dump);

				provider.apply();
				console.log("vscode-glua: custom wiki ingested (version " + provider.version + " from " + url + ")");
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
