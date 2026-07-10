// ADE Browser Tools - Design Mode content script.
//
// The host toggles this through a DOM event. Selection data is intentionally
// allowlisted and never includes input values, page HTML, cookies, storage, or
// data-* attributes. The main process accepts markers only while Design Mode is
// explicitly active for a localhost page.
(() => {
	if (
		location.hostname !== "localhost" &&
		location.hostname !== "127.0.0.1" &&
		!location.hostname.endsWith(".localhost")
	) {
		return;
	}

	const TOGGLE_EVENT = "ade-design-mode";
	const MARKER = "__ADE_DESIGN_SELECTION__";
	const OUTLINE_ID = "ade-design-mode-outline";
	const STYLE_PROPERTIES = [
		"display",
		"position",
		"color",
		"backgroundColor",
		"fontFamily",
		"fontSize",
		"fontWeight",
		"lineHeight",
		"textAlign",
		"borderRadius",
		"padding",
		"margin",
		"gap",
		"width",
		"height",
	];

	let enabled = false;
	let hovered = null;
	let outline = null;
	let activeNonce = null;

	function isToolElement(target) {
		return target instanceof Element && target.id === OUTLINE_ID;
	}

	function ensureOutline() {
		if (outline?.isConnected) return outline;
		outline = document.createElement("div");
		outline.id = OUTLINE_ID;
		Object.assign(outline.style, {
			position: "fixed",
			zIndex: "2147483647",
			pointerEvents: "none",
			border: "2px solid #8b5cf6",
			background: "rgba(139, 92, 246, 0.12)",
			boxSizing: "border-box",
			display: "none",
		});
		document.documentElement.appendChild(outline);
		return outline;
	}

	function updateOutline(target) {
		const rect = target.getBoundingClientRect();
		const node = ensureOutline();
		Object.assign(node.style, {
			display: "block",
			left: `${rect.left}px`,
			top: `${rect.top}px`,
			width: `${rect.width}px`,
			height: `${rect.height}px`,
		});
	}

	function cssEscape(value) {
		if (globalThis.CSS?.escape) return globalThis.CSS.escape(value);
		return value.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`);
	}

	function selectorFor(element) {
		if (element.id) return `#${cssEscape(element.id)}`;
		const parts = [];
		let current = element;
		while (
			current &&
			current.nodeType === Node.ELEMENT_NODE &&
			parts.length < 5
		) {
			let part = current.tagName.toLowerCase();
			const safeClasses = [...current.classList]
				.filter((name) => /^[a-zA-Z_-][a-zA-Z0-9_-]{0,63}$/.test(name))
				.slice(0, 2);
			if (safeClasses.length) {
				part += safeClasses.map((name) => `.${cssEscape(name)}`).join("");
			}
			const parent = current.parentElement;
			if (parent) {
				const siblings = [...parent.children].filter(
					(child) => child.tagName === current.tagName,
				);
				if (siblings.length > 1) {
					part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
				}
			}
			parts.unshift(part);
			if (parent?.tagName === "BODY") break;
			current = parent;
		}
		return parts.join(" > ");
	}

	function safeText(element) {
		if (
			element.matches(
				"input, textarea, select, [contenteditable='true'], [contenteditable='']",
			)
		) {
			return "[redacted interactive value]";
		}
		return (element.textContent || "")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 180);
	}

	function selectionFor(element) {
		const rect = element.getBoundingClientRect();
		const computed = getComputedStyle(element);
		const styles = {};
		for (const property of STYLE_PROPERTIES)
			styles[property] = computed[property];

		const attributes = {};
		for (const name of ["role", "aria-label", "title", "alt", "type"]) {
			const value = element.getAttribute(name);
			if (value) attributes[name] = value.slice(0, 180);
		}

		return {
			version: 1,
			tagName: element.tagName.toLowerCase(),
			selector: selectorFor(element).slice(0, 500),
			text: safeText(element),
			attributes,
			styles,
			rect: {
				x: Math.round(rect.x),
				y: Math.round(rect.y),
				width: Math.round(rect.width),
				height: Math.round(rect.height),
			},
			page: {
				path: location.pathname.slice(0, 500),
				title: document.title.slice(0, 180),
			},
		};
	}

	function disable() {
		enabled = false;
		activeNonce = null;
		hovered = null;
		if (outline) outline.style.display = "none";
		document.documentElement.style.cursor = "";
	}

	function onPointerMove(event) {
		if (
			!enabled ||
			!(event.target instanceof Element) ||
			isToolElement(event.target)
		)
			return;
		hovered = event.target;
		updateOutline(hovered);
	}

	function onClick(event) {
		if (
			!enabled ||
			!(event.target instanceof Element) ||
			isToolElement(event.target)
		)
			return;
		event.preventDefault();
		event.stopImmediatePropagation();
		const payload = selectionFor(event.target);
		const nonce = activeNonce;
		disable();
		if (nonce) console.info(`${MARKER}${nonce}:${JSON.stringify(payload)}`);
	}

	function onKeyDown(event) {
		if (!enabled || event.key !== "Escape") return;
		event.preventDefault();
		const nonce = activeNonce;
		disable();
		if (nonce) {
			console.info(
				`${MARKER}${nonce}:${JSON.stringify({ version: 1, cancelled: true })}`,
			);
		}
	}

	document.addEventListener(TOGGLE_EVENT, (event) => {
		const nonce = event.detail?.nonce;
		enabled =
			Boolean(event.detail?.enabled) &&
			typeof nonce === "string" &&
			/^[0-9a-f-]{36}$/i.test(nonce);
		if (!enabled) {
			disable();
			return;
		}
		activeNonce = nonce;
		document.documentElement.style.cursor = "crosshair";
		ensureOutline();
	});
	document.addEventListener("pointermove", onPointerMove, true);
	document.addEventListener("click", onClick, true);
	document.addEventListener("keydown", onKeyDown, true);
})();
