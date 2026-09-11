// Where the binary actually is.
//
// A package that ships native binaries splits them across one platform package per host, installed as
// optionalDependencies, because putting every platform in one package makes every install pay for five. So
// nothing can hardcode a path: the resolver asks each platform package this host installed for a binary by
// filename, and falls back to a dev checkout's own build output.
//
// Asked by filename and checked by filename. A platform package published before a second binary existed
// answers every request with the first one, and that path exists, so trusting the answer starts two copies of
// the wrong process. The basename check is what turns that into an error naming the version to upgrade.

import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';

/** Every host this resolver has a label for. A consumer whose packages are named differently states its own. */
const PLATFORM_LABELS = {
	os: { linux: 'linux', darwin: 'macos', win32: 'windows' },
	arch: { x64: 'x86_64', arm64: 'arm64' },
};

/**
 * @typedef {object} PackageVariant
 * @property {string} suffix Appended to the base package name before the platform label. Empty for the base.
 * @property {boolean} [optional] True for a package that is not a dependency and is installed by name.
 * @property {string} [carries] Why an optional package exists, for the error that says to install it.
 */

/**
 * What asking one platform package for one binary produced.
 *
 * @param {string} packageName @param {string} shipsAs @param {string} file
 * @param {(name: string) => Promise<any>} load
 */
async function ask(packageName, shipsAs, file, load) {
	let pkg;
	try {
		pkg = await load(packageName);
	} catch {
		return { installed: false };
	}
	const getBinaryPath = pkg.getBinaryPath ?? pkg.default?.getBinaryPath;
	let resolved;
	try {
		resolved = getBinaryPath?.(shipsAs);
	} catch {
		// getBinaryPath throws on a name it does not carry, which is the ordinary answer from the base
		// package when asked for a binary only an add-on package ships. It is installed and does not have this one.
		return { installed: true };
	}
	if (resolved && basename(resolved) === file && existsSync(resolved)) return { installed: true, path: resolved };
	// Set only on a name mismatch, so the error below can tell "the package answered with the wrong binary"
	// apart from "the package isn't installed" instead of collapsing both into one guess.
	return { installed: true, staleMatch: resolved };
}

/**
 * Why nothing resolved, distinguishing the three states a package can be in.
 *
 * These want different things from the reader. A missing optional package is a choice they made and the fix
 * is to install it. An installed package that answered with the wrong file is a version that predates the
 * binary and the fix is an upgrade. An absent base package is a broken install.
 *
 * @param {Array<Record<string, any>>} asked @param {string} file @param {string} local @param {string} buildCommand
 */
export function resolutionFailure(asked, file, local, buildCommand) {
	const stale = asked.find((a) => a.staleMatch);
	if (stale)
		return (
			`${stale.name} is installed but predates ${file} support (it resolved ${stale.staleMatch} ` +
			`instead) and no local build exists at ${local}. Update ${stale.name} to a version that ships ` +
			`${file}, or build locally with ${buildCommand}.`
		);

	const missingOptional = asked.find((a) => a.optional && !a.installed);
	const carrier = asked.find((a) => a.optional !== true);
	if (missingOptional && carrier?.installed)
		return (
			`${missingOptional.name} is not installed${missingOptional.carries ? `. ${missingOptional.carries}` : ''}. ` +
			`Install it to get ${file}: npm install ${missingOptional.name}`
		);

	return `none of ${asked.map((a) => a.name).join(', ')} nor a local build at ${local} resolved ${file}`;
}

/**
 * A resolver bound to one package's platform packages.
 *
 * @param {object} options
 * @param {string} options.packageName The base package, stated as a constant by its caller rather than read
 *   off a nearest package.json: a deployed component's can carry any name, and a wrong base resolves a
 *   platform package that does not exist.
 * @param {string} options.packageRoot Where a dev checkout's build output sits.
 * @param {readonly PackageVariant[]} options.variants In the order they are asked. Every variant is asked for
 *   every binary rather than routed by name, so a binary that moves between two of them needs no change here.
 * @param {string} [options.buildCommand] What a dev runs to produce the local build, for the error.
 * @param {{ os: Record<string, string>, arch: Record<string, string> }} [options.labels]
 * @param {(name: string) => Promise<any>} [options.load] How a platform package is imported. A consumer
 *   passes `(name) => import(name)` from its own module: a bare specifier resolves against the file the
 *   `import` is written in, so the default here would look for the consumer's platform packages beside this
 *   package instead of beside the consumer. Flat node_modules hides that; a symlinked or nested install does
 *   not, and the failure is "no binary" on a node that has one.
 */
export function createBinaryResolver({
	packageName,
	packageRoot,
	variants,
	buildCommand = 'npm run build',
	labels = PLATFORM_LABELS,
	load = (name) => import(name),
}) {
	const exe = process.platform === 'win32' ? '.exe' : '';

	/** This package's platform label for the running host; throws where no platform package exists. */
	const platformName = () => {
		const os = labels.os[process.platform];
		const arch = labels.arch[process.arch];
		if (!os || !arch) throw new Error(`unsupported platform: ${process.platform}-${process.arch}`);
		return `${os}-${arch}`;
	};

	/** One variant's package name for this host. */
	const packageFor = (/** @type {PackageVariant} */ variant) => `${packageName}${variant.suffix}-${platformName()}`;

	return {
		platformName,

		/**
		 * Whatever one variant's package states about its own layout, or null when it is not installed.
		 *
		 * Asked rather than computed: a path built here goes stale the moment that package's layout changes,
		 * and the package is the only thing that knows where it put its files. Null is an ordinary answer for
		 * an optional variant most hosts do not install.
		 *
		 * @param {PackageVariant} variant @param {string} accessor Name of the function the package exports.
		 * @returns {Promise<string | null>}
		 */
		async resolveDir(variant, accessor) {
			try {
				const pkg = await load(packageFor(variant));
				const dir = (pkg[accessor] ?? pkg.default?.[accessor])?.();
				return dir && existsSync(dir) ? dir : null;
			} catch {
				return null;
			}
		},

		/**
		 * The platform packages' accessors first (the npm install path), then a dev checkout's build output.
		 *
		 * @param {{ shipsAs: string, title?: string }} wanted
		 * @returns {Promise<string>}
		 */
		async resolveBinary(wanted) {
			const file = `${wanted.shipsAs}${exe}`;
			const platform = platformName();

			const asked = [];
			for (const variant of variants) {
				const name = packageFor(variant);
				const answer = await ask(name, wanted.shipsAs, file, load);
				if (answer.path) return answer.path;
				asked.push({ name, ...variant, ...answer });
			}

			const local = join(packageRoot, 'build', platform, 'bin', file);
			if (existsSync(local)) return local;

			throw new Error(
				`no ${wanted.title ?? wanted.shipsAs} binary: ${resolutionFailure(asked, file, local, buildCommand)}`
			);
		},
	};
}
