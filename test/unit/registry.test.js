// The descriptors are the reaper's memory of processes whose launching thread joined an existing
// reaper: whatever cannot round-trip through this file is a process nobody stops.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { importDist, withTempDir } from '../support/harness.js';

const {
	GUARD_DESCRIPTOR_SUFFIX,
	guardDescriptorPath,
	guardDescriptorPathForLock,
	readGuardDescriptors,
	writeGuardDescriptor,
} = await importDist('registry.js');

test('a written descriptor reads back verbatim, keyed beside its lock', () =>
	withTempDir('registry-roundtrip-', (dir) => {
		const pidDir = path.join(dir, 'pids');
		const descriptor = {
			name: 'trace-agent',
			pidFile: path.join(pidDir, 'trace-agent.pid'),
			pid: 4321,
			binaryPath: '/opt/agent/trace-agent',
		};
		// The write must create pidDir itself: a losing thread can get here before Harper's
		// first lock does.
		writeGuardDescriptor(pidDir, descriptor);
		assert.deepEqual(readGuardDescriptors(pidDir), [descriptor]);
		assert.equal(guardDescriptorPath(pidDir, 'trace-agent'), path.join(pidDir, 'trace-agent.guard.json'));
	}));

test('the arguments round-trip, and a record written without them stays a record without them', () =>
	withTempDir('registry-args-', (dir) => {
		const pidFile = path.join(dir, 'agent.pid');
		// `node <script>` is the shape a Harper sidecar has, and the script is what separates two of them.
		writeGuardDescriptor(dir, { name: 'agent', pidFile, pid: 7, binaryPath: '/usr/bin/node', args: ['/opt/a/run.js'] });
		assert.deepEqual(readGuardDescriptors(dir), [
			{ name: 'agent', pidFile, pid: 7, binaryPath: '/usr/bin/node', args: ['/opt/a/run.js'] },
		]);
		// A descriptor from a launch before this field existed identifies by executable alone,
		// which is what it always did; a half-readable vector is no vector at all.
		fs.writeFileSync(
			path.join(dir, 'old.guard.json'),
			JSON.stringify({ name: 'old', pidFile, pid: 8, binaryPath: '/usr/bin/node' }),
			'utf-8'
		);
		fs.writeFileSync(
			path.join(dir, 'mixed.guard.json'),
			JSON.stringify({ name: 'mixed', pidFile, pid: 9, binaryPath: '/usr/bin/node', args: ['a', 3] }),
			'utf-8'
		);
		const byName = Object.fromEntries(readGuardDescriptors(dir).map((d) => [d.name, d]));
		assert.deepEqual(byName.old, { name: 'old', pidFile, pid: 8, binaryPath: '/usr/bin/node' });
		assert.deepEqual(byName.mixed, { name: 'mixed', pidFile, pid: 9, binaryPath: '/usr/bin/node' });
	}));

test('the suffix cannot collide with a lock or with the Harper port spelling', () => {
	// One pids/ directory serves Harper's `<name>.pid` locks, the harper port's `.sidecar.json`
	// descriptors and these; a shared spelling would have each reading the others' records.
	assert.equal(GUARD_DESCRIPTOR_SUFFIX, '.guard.json');
	assert.notEqual(GUARD_DESCRIPTOR_SUFFIX, '.sidecar.json');
	assert.equal(guardDescriptorPathForLock('/x/pids/agent.pid'), '/x/pids/agent.guard.json');
	// A lock spelled without `.pid` still derives a sibling rather than throwing.
	assert.equal(guardDescriptorPathForLock('/x/pids/agent'), '/x/pids/agent.guard.json');
});

test('descriptors that cannot be read name nothing to act on', () =>
	withTempDir('registry-torn-', (dir) => {
		fs.writeFileSync(path.join(dir, 'torn.guard.json'), '{"name": "torn", "pidFi', 'utf-8');
		fs.writeFileSync(path.join(dir, 'no-pid.guard.json'), JSON.stringify({ name: 'x', pidFile: '/x.pid' }), 'utf-8');
		fs.writeFileSync(
			path.join(dir, 'string-pid.guard.json'),
			JSON.stringify({ name: 'x', pidFile: '/x.pid', pid: '42' }),
			'utf-8'
		);
		fs.writeFileSync(path.join(dir, 'not-a-descriptor.pid'), '123\n1', 'utf-8');
		assert.deepEqual(readGuardDescriptors(dir), [], 'a torn or wrong-shaped record was acted on');
		assert.deepEqual(readGuardDescriptors(path.join(dir, 'absent')), [], 'an absent directory must read as empty');
	}));

test('a rewrite replaces the record in place, so the latest launch wins', () =>
	withTempDir('registry-rewrite-', (dir) => {
		const pidFile = path.join(dir, 'agent.pid');
		writeGuardDescriptor(dir, { name: 'agent', pidFile, pid: 100, binaryPath: '/old/agent' });
		writeGuardDescriptor(dir, { name: 'agent', pidFile, pid: 200, binaryPath: '/new/agent' });
		assert.deepEqual(readGuardDescriptors(dir), [{ name: 'agent', pidFile, pid: 200, binaryPath: '/new/agent' }]);
		// Temp-and-rename leaves no `.tmp` litter for a reader to trip on.
		assert.deepEqual(
			fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')),
			[]
		);
	}));
