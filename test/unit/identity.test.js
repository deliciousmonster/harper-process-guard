// The stat line's comm field is chosen by the process being examined, so the parsing seam is
// tested against hostile spellings; a real zombie lives in the e2e reaper suite.
import test from 'node:test';
import assert from 'node:assert/strict';

import { importDist } from '../support/harness.js';

const { isAlive, parseProcStatState } = await importDist('identity.js');

test('the stat state is the token after the LAST close paren, whatever comm contains', () => {
	assert.equal(parseProcStatState('123 (node) S 1 123 123 0 -1'), 'S');
	assert.equal(parseProcStatState('123 (node) Z 1 123 123 0 -1'), 'Z');
	// comm is user-controlled and may contain spaces and parens; splitting on the FIRST ')'
	// reads a letter out of the name instead of the state field.
	assert.equal(parseProcStatState('42 (a) (b) R 0 42'), 'R', 'a ") (" inside comm broke the parse');
	assert.equal(parseProcStatState('42 (tricky Z name) R 0 42'), 'R', 'a Z inside comm read as the state');
	assert.equal(parseProcStatState('7 (ends)) Z 1'), 'Z', 'a comm ending in ")" broke the parse');
	assert.equal(parseProcStatState('9 (spaced out comm (v2)) D 3'), 'D');
});

test('a stat line that does not parse yields null, never a guessed state', () => {
	assert.equal(parseProcStatState(''), null);
	assert.equal(parseProcStatState('no parens at all'), null);
	assert.equal(parseProcStatState('1 (cut off)'), null, 'nothing after comm must not invent a state');
	assert.equal(parseProcStatState('1 (cut off)   '), null);
});

test('the examining process itself is alive; the group selectors still are not', () => {
	assert.equal(isAlive(process.pid), true, 'the zombie check misread a running process');
	assert.equal(isAlive(0), false);
	assert.equal(isAlive(-1), false);
});
