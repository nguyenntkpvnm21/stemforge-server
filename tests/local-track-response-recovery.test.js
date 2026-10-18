const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  MAIN, EXPECTED_CHECKS, evaluateVerification, prepareRecoveryReport,
  finishReport, validateFixtureManifest, removeOrphanLikes,
} = require('../scripts/lib/local-track-response-recovery');

const USER_A = '507f1f77bcf86cd799439011';
const USER_B = '507f1f77bcf86cd799439012';
const ORPHAN_OWNER = '507f1f77bcf86cd799439013';
const TRACK = '507f1f77bcf86cd799439014';
const FOREIGN = '507f1f77bcf86cd799439015';
const allPassed = () => EXPECTED_CHECKS.map(name => ({ name, status: 'passed' }));
const cleaned = () => ({ cleanup: { status: 'passed' }, preservation: { status: 'passed' } });

function manifest() {
  const marker = 'sf-context-20261018120000-1234abcd';
  return {
    kind: 'local-track-response', marker,
    users: [USER_A, USER_B].map((id, index) => ({ id, username: `${marker}-${index}`, email: `${marker}-${index}@example.invalid` })),
    orphanOwnerId: ORPHAN_OWNER,
    tracks: [{ id: TRACK, ownerId: USER_A, title: `${marker}-public-a` }], checks: [],
    baseline: {
      ...Object.fromEntries(['users', 'tracks', 'tracklikes'].map(name => [name, { count: 0, digest: '0'.repeat(64) }])),
      mainAccountDigest: '1'.repeat(64),
    },
  };
}

for (const [name, checks, expected] of [
  ['no groups', [], 'incomplete'],
  ['nine groups', allPassed().slice(0, 9), 'incomplete'],
  ['ten distinct expected groups', allPassed(), 'passed'],
  ['ten duplicate groups', Array.from({ length: 10 }, () => allPassed()[0]), 'failed'],
  ['unknown group replacing an expected one', [...allPassed().slice(0, 9), { name: 'unknown', status: 'passed' }], 'failed'],
  ['a failed group', allPassed().map((check, i) => i ? check : { ...check, status: 'failed' }), 'failed'],
]) {
  test(`verification evaluates ${name} as ${expected}`, () => {
    assert.equal(evaluateVerification({ checks }).status, expected);
  });
}

test('fatal setup error prevents a pass even with every expected group present', () => {
  assert.equal(evaluateVerification({ checks: allPassed(), fatal: 'Setup failed' }).status, 'failed');
});

test('cleanup alone cannot turn an interrupted empty run into passed', () => {
  const report = { checks: [], ...cleaned() };
  prepareRecoveryReport(report);
  assert.equal(finishReport(report, { cleanupOnly: true }), true);
  assert.equal(report.verification.status, 'incomplete');
  assert.equal(report.verification.completedGroups, 0);
  assert.equal(report.status, 'incomplete');
  assert.equal(report.lastRecovery.status, 'passed');
});

test('recovery does not promote a pending verdict even when ten checks were recorded', () => {
  const report = {
    checks: allPassed(), status: 'incomplete',
    verification: { status: 'incomplete', expectedGroups: 10, completedGroups: 0 },
    finishedAt: 'original', ...cleaned(),
  };
  const evidence = structuredClone(report);
  prepareRecoveryReport(report);
  finishReport(report, { cleanupOnly: true, now: 'recovered' });
  assert.deepEqual(report.verification, evidence.verification);
  assert.deepEqual(report.checks, evidence.checks);
  assert.equal(report.status, 'incomplete');
  assert.equal(report.finishedAt, 'original');
  assert.equal(report.lastRecovery.finishedAt, 'recovered');
});

test('legacy false pass with empty checks is downgraded rather than certified', () => {
  const report = { checks: [], status: 'passed', ...cleaned() };
  prepareRecoveryReport(report);
  finishReport(report, { cleanupOnly: true });
  assert.equal(report.status, 'incomplete');
  assert.equal(report.verification.status, 'incomplete');
});

test('legacy complete passed evidence remains passed without changing the original completion time', () => {
  const report = { checks: allPassed(), status: 'passed', finishedAt: 'original', ...cleaned() };
  prepareRecoveryReport(report);
  finishReport(report, { cleanupOnly: true });
  assert.equal(report.verification.status, 'passed');
  assert.equal(report.finishedAt, 'original');
});

test('cleanup cannot erase prior failure or fatal verification evidence', () => {
  const report = { checks: allPassed(), status: 'failed', fatal: 'Original failure', ...cleaned() };
  prepareRecoveryReport(report);
  assert.equal(finishReport(report, { cleanupOnly: true }), true);
  assert.equal(report.status, 'failed');
  assert.equal(report.verification.status, 'failed');
  assert.equal(report.fatal, 'Original failure');
});

test('verification and cleanup failure are independent results', () => {
  const report = { checks: allPassed(), cleanup: { status: 'failed' }, preservation: { status: 'passed' } };
  assert.equal(finishReport(report, { cleanupOnly: false }), false);
  assert.equal(report.verification.status, 'passed');
  assert.equal(report.status, 'failed');
  report.cleanup.status = 'passed';
  const verdict = structuredClone(report.verification);
  assert.equal(finishReport(report, { cleanupOnly: true }), true);
  assert.deepEqual(report.verification, verdict);
  assert.equal(report.status, 'failed');
  assert.equal(report.lastRecovery.status, 'passed');
});

test('normal completion cannot pass after cleanup with only nine groups', () => {
  const report = { checks: allPassed().slice(0, 9), ...cleaned() };
  assert.equal(finishReport(report, { cleanupOnly: false }), false);
  assert.equal(report.verification.status, 'incomplete');
  assert.equal(report.status, 'incomplete');
});

test('fixture validation accepts planned-but-uncreated records and early interruptions', () => {
  const report = manifest();
  delete report.tracks[0].id;
  assert.doesNotThrow(() => validateFixtureManifest(report));
  report.tracks = [];
  report.users.forEach(user => { delete user.id; });
  assert.doesNotThrow(() => validateFixtureManifest(report));
});

for (const [name, mutate] of [
  ['main user ID', report => { report.users[0].id = MAIN; }],
  ['main Track ID', report => { report.tracks[0].id = MAIN; }],
  ['foreign Track owner', report => { report.tracks[0].ownerId = FOREIGN; }],
  ['mismatched account marker', report => { report.users[0].email = 'other@example.invalid'; }],
  ['malformed Track ID', report => { report.tracks[0].id = 'invalid'; }],
  ['duplicate Track ID', report => { report.tracks.push({ ...report.tracks[0] }); }],
  ['missing preservation baseline', report => { delete report.baseline; }],
]) {
  test(`fixture validation rejects ${name} before cleanup`, () => {
    const report = manifest();
    mutate(report);
    assert.throws(() => validateFixtureManifest(report));
  });
}

function orphanDatabase({ parent = null, foreign = false } = {}) {
  const session = {};
  let members = [USER_A, USER_B];
  let deletions = 0;
  const db = {
    collection(name) {
      return {
        async findOne(filter, options) {
          assert.equal(name, 'tracks');
          assert.equal(String(filter._id), TRACK);
          assert.equal(options.session, session);
          return parent;
        },
        async countDocuments(filter, options) {
          assert.equal(name, 'tracklikes');
          assert.equal(String(filter.trackId), TRACK);
          assert.deepEqual(filter.userId.$nin.map(String), [USER_A, USER_B]);
          assert.equal(options.session, session);
          return foreign ? 1 : 0;
        },
        async deleteMany(filter, options) {
          assert.equal(name, 'tracklikes');
          assert.equal(String(filter.trackId), TRACK);
          assert.deepEqual(filter.userId.$in.map(String), [USER_A, USER_B]);
          assert.equal(options.session, session);
          const deletedCount = members.length;
          members = [];
          deletions++;
          return { deletedCount };
        },
      };
    },
  };
  const connection = { async transaction(operation) { await operation(session); } };
  return { db, connection, track: manifest().tracks[0], userIds: [USER_A, USER_B], members: () => members, deletions: () => deletions };
}

test('missing Track orphan Likes are deleted transactionally by fixture Track and account IDs; retry is idempotent', async () => {
  const context = orphanDatabase();
  await removeOrphanLikes(context);
  assert.deepEqual(context.members(), []);
  await removeOrphanLikes(context);
  assert.deepEqual(context.members(), []);
  assert.equal(context.deletions(), 2);
});

test('orphan Likes belonging to a foreign/main account cause refusal without deleting any membership', async () => {
  const context = orphanDatabase({ foreign: true });
  await assert.rejects(removeOrphanLikes(context), /nonfixture account/);
  assert.equal(context.deletions(), 0);
  assert.deepEqual(context.members(), [USER_A, USER_B]);
});

test('a parent Track visible again inside the transaction prevents orphan-only deletion', async () => {
  const context = orphanDatabase({ parent: { _id: TRACK, artistId: FOREIGN } });
  await assert.rejects(removeOrphanLikes(context), /Track appeared/);
  assert.equal(context.deletions(), 0);
});

test('main account cannot be passed as an orphan cleanup identity', async () => {
  const context = orphanDatabase();
  await assert.rejects(removeOrphanLikes({ ...context, userIds: [MAIN] }), /Unsafe orphan/);
  assert.equal(context.deletions(), 0);
});
