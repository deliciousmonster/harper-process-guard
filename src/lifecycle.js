// Harper's plugin entry, and the one failure a plugin cannot observe from inside itself.
//
// Both are Harper-shaped and consumer-neutral. A component that Harper imports for its resources and never
// calls the plugin of is a failure every component can hit and none can observe from inside itself, and the
// once-per-thread guarantee is the same for anything that starts a process.

// 60s because handleApplication runs behind scope.ready and waitForDeployCompletion, then behind a
// per-plugin lock whose own wait is Harper's plugin timeout plus 5s: 35s at the 30s default. A shorter
// window libels a slow node.
const START_DEADLINE_MS = 60_000;

/**
 * Watch for Harper never calling the plugin at all, which is what an auto-scanned component directory
 * gets: Harper imports the module for its resources, calls no plugin, and discards it. Module evaluation
 * is the only vantage point left, because nothing inside the plugin ever runs.
 *
 * @param {object} options
 * @param {import('./log.js').Log} options.log
 * @param {string} options.label What this component calls itself in a log line, so this file names no
 *   consumer and can move to the guard unchanged.
 * @param {string} options.configEntry The root-config line an operator has to add, already rendered.
 * @param {number} [options.deadlineMs]
 * @returns {{ seen(): void }} Call `seen` the moment the plugin is entered.
 */
export function watchForNeverCalled({ log, label, configEntry, deadlineMs = START_DEADLINE_MS }) {
	const timer = setTimeout(() => {
		log.error(
			`${label}: Harper has not called handleApplication ${deadlineMs / 1000}s after this ` +
				`module loaded, so no agent started and nothing on this node is supervising one. The likeliest ` +
				`cause is a component Harper loaded by scanning componentsRoot: it calls the plugin only for a ` +
				`component the root harper-config.yaml names, and the module it imports for a scanned directory ` +
				`is discarded.`
		);
		log.error(
			`${label}: add this to the node's harper-config.yaml (the file settings_path names in ` +
				`~/.harperdb/hdb_boot_properties.file), keyed by this directory's name, then restart Harper: ${configEntry}`
		);
	}, deadlineMs);
	// A diagnostic must not be the reason a worker thread stays up.
	timer.unref?.();
	return { seen: () => clearTimeout(timer) };
}

/**
 * The plugin entry Harper calls once per worker thread.
 *
 * Two rules, and both are load-bearing. A deploy pre-flight loads the component against a live node just to
 * validate it, and starting there re-enters the sweep and spawn path on every `harper deploy`. And a second
 * call joins the first promise rather than starting again, which is the single-start guarantee the whole
 * PID lock exists to make good on.
 *
 * @param {object} options
 * @param {(scope?: any) => Promise<object>} options.start
 * @param {{ seen(): void }} options.deadline
 * @param {{ get(): Promise<object> | undefined, set(p: Promise<object>): void }} options.slot Where the
 *   started promise lives, so the read path can see the same one.
 */
export function createHandleApplication({ start, deadline, slot }) {
	return function handleApplication(/** @type {any} */ scope) {
		// Being called at all is what the deadline waits for; a validation load counts, since Harper
		// reached the plugin either way.
		deadline.seen();
		if (scope?.isTransientValidation) return;
		if (!slot.get()) slot.set(start(scope));
	};
}
