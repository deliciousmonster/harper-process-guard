// Which supervisor a host gets, and what happens when the one it was given cannot do the job. Until this file
// existed nothing in this package called supervisorFor at all: 231 tests, and the branch that decides whether a
// node supervises its processes natively or with the bundled guard was exercised only by the consumer.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { supervisesNatively, supervisorFor } from '../../src/index.js';

const silent = { info: () => {}, warn: () => {}, error: () => {} };
// Never called on either path here: the native one delegates to the host and the bundled one is only asked for
// its `kind`. Typed as the real Spawn so the cast is honest about what a caller would have to supply.
const spawn = /** @type {import('../../src/supervise.js').Spawn} */ (
	() => {
		throw new Error('the spawn stub must not be reached');
	}
);
const options = (extra = {}) => ({ log: silent, spawn, label: 'probe', reaperName: 'probe-reaper', ...extra });

/**
 * A host exposing the native surface: the duck-type is `processes.start` being callable and nothing more.
 * `processes` is declared optional so a test can take it away, which is the case the refusal exists for.
 *
 * @param {(descriptor: any) => Promise<any>} [start]
 * @returns {{ processes: { start: (descriptor: any) => Promise<any>, reaper: undefined } | undefined }}
 */
const nativeScope = (start = async () => ({ started: true })) => ({ processes: { start, reaper: undefined } });

test('a host with no scope.processes gets the bundled guard', () => {
	assert.equal(supervisesNatively({}), false);
	assert.equal(supervisorFor({}, options()).kind, 'guard');
});

test('a host exposing scope.processes.start gets the native path, under the kind the consumer chose', () => {
	const scope = nativeScope();
	assert.equal(supervisesNatively(scope), true);
	assert.equal(supervisorFor(scope, options()).kind, 'host');
	// The consumer owns this string because its status endpoint has published it; renaming it is not a refactor.
	assert.equal(supervisorFor(scope, options({ nativeKind: 'harper' })).kind, 'harper');
});

// The duck-type is the whole check, so anything that is not a callable `start` is not a native host. A scope
// carrying a truthy `processes` with no start would otherwise take the native path and fail on first use.
test('NEGATIVE: a processes member without a callable start is not a native host', () => {
	for (const processes of [undefined, null, {}, { start: null }, { start: 'yes' }, { start: 42 }, []]) {
		assert.equal(supervisesNatively({ processes }), false, `processes = ${JSON.stringify(processes)}`);
		assert.equal(supervisorFor({ processes }, options()).kind, 'guard');
	}
});

// The defect this is for: a host that satisfied the duck-type when supervisorFor asked, and does not when start
// is called, used to surface as "Cannot read properties of undefined (reading 'start')" thrown from inside this
// package. A consumer catching that has no way to say what an operator should do about it.
test('a host that loses scope.processes between the choice and the start is refused by name', async () => {
	const scope = nativeScope();
	const supervisor = supervisorFor(scope, options({ nativeKind: 'harper' }));
	scope.processes = undefined;

	await assert.rejects(
		() =>
			supervisor.start([{ name: 'agent', title: 'agent', command: '/bin/true', args: [] }], {
				configFiles: {},
				fingerprintParts: ['v1'],
			}),
		(error) => {
			assert.ok(error instanceof Error);
			assert.doesNotMatch(error.message, /Cannot read properties/, 'a TypeError is not a diagnosis');
			assert.match(error.message, /probe:/, 'the refusal names the consumer');
			assert.match(error.message, /scope\.processes\.start/, 'and the member it wanted');
			assert.match(error.message, /bundled guard/, 'and the alternative');
			return true;
		}
	);
});

test('the native path reports the states the host produced, tagged with the descriptor', async () => {
	const scope = nativeScope(async (descriptor) => ({
		started: true,
		pid: 4242,
		verified: true,
		name: descriptor.name,
	}));
	const supervisor = supervisorFor(scope, options({ nativeKind: 'harper' }));
	const { processes, report } = await supervisor.start(
		[{ name: 'agent-x', title: 'agent X', command: '/bin/true', args: [] }],
		{ configFiles: {}, fingerprintParts: ['v1'] }
	);
	assert.equal(processes.length, 1);
	assert.equal(processes[0].name, 'agent-x');
	assert.equal(processes[0].title, 'agent X');
	assert.equal(processes[0].kind, undefined, 'the descriptor carried no kind, so none is invented');
	assert.equal(processes[0].verified, true);
	// The consumer surfaces this so an operator can tell which supervisor ran without reading the code.
	assert.match(report.join(' '), /bundled process guard is present but unused/);
});

// A native start that rejects is one process failing, not the node failing: the others still report.
test('a native start that rejects becomes an unstarted state rather than taking the call down', async () => {
	let calls = 0;
	const scope = nativeScope(async (descriptor) => {
		calls += 1;
		if (descriptor.name === 'bad') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
		return { started: true, verified: true };
	});
	const supervisor = supervisorFor(scope, options({ nativeKind: 'harper' }));
	const { processes } = await supervisor.start(
		[
			{ name: 'good', title: 'good', command: '/bin/true', args: [] },
			{ name: 'bad', title: 'bad', command: '/nope', args: [] },
		],
		{ configFiles: {}, fingerprintParts: ['v1'] }
	);
	assert.equal(calls, 2, 'both descriptors were attempted');
	assert.equal(processes[0].started, true);
	assert.equal(processes[1].started, false);
	assert.equal(processes[1].name, 'bad');
	assert.ok(processes[1].error, 'the failure is carried on the state, not lost');
});
