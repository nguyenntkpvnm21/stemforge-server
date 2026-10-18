const mongoose = require('mongoose');

const MAIN = '6acb9cdb457771b5ea947486';
const EXPECTED_CHECKS = Object.freeze([
  'POST returns exact public artist fields and likedByMe=false for both authors',
  'Guest list/detail expose only public author fields and likedByMe=false',
  'Like/Unlike responses and list/detail follow each account membership, not global count',
  'Public listing stays public-only; private detail is owner-only',
  'Invalid token and malformed authorization return 401 on public list',
  'PATCH returns enriched artist and likedByMe=false after Unlike',
  'POST/PATCH reject response-only fields and do not change existing fixture data',
  'Missing author returns null on list/detail and preserves Track/artistId',
  'Real HTTP list performs batched author and membership queries',
  'Computed response fields are absent from every stored fixture Track',
]);

class VerificationError extends Error {}
function must(condition, message) {
  if (!condition) throw new VerificationError(message);
}
const validId = id => typeof id === 'string' && /^[a-fA-F0-9]{24}$/.test(id) && id.toLowerCase() !== MAIN;
const oid = id => new mongoose.Types.ObjectId(id);

function evaluateVerification(report) {
  const checks = Array.isArray(report.checks) ? report.checks : [];
  const names = checks.map(check => check.name);
  const invalid = names.some(name => !EXPECTED_CHECKS.includes(name)) || new Set(names).size !== names.length;
  const completedGroups = new Set(checks.filter(check => EXPECTED_CHECKS.includes(check.name) && ['passed', 'failed'].includes(check.status)).map(check => check.name)).size;
  const complete = checks.length === EXPECTED_CHECKS.length && !invalid &&
    EXPECTED_CHECKS.every(name => checks.some(check => check.name === name && check.status === 'passed'));
  return {
    status: report.fatal || invalid || checks.some(check => check.status === 'failed') ? 'failed' : complete ? 'passed' : 'incomplete',
    expectedGroups: EXPECTED_CHECKS.length,
    completedGroups,
  };
}

function prepareRecoveryReport(report) {
  const evidence = evaluateVerification(report);
  if (!report.verification) {
    // Legacy manifests had only an overall status. Never infer a new pass from
    // checks alone: the original run must also have explicitly finished passed.
    report.verification = {
      ...evidence,
      status: report.status === 'passed' && evidence.status === 'passed'
        ? 'passed' : report.status === 'failed' || evidence.status === 'failed' ? 'failed' : 'incomplete',
    };
  } else if (report.verification.status === 'passed' && evidence.status !== 'passed') {
    // Correct unsupported historical pass claims; recovery may downgrade, not upgrade.
    report.verification = evidence;
  }
  if (!report.status || (report.status === 'passed' && report.verification.status !== 'passed')) {
    report.status = report.verification.status;
  }
}

function finishReport(report, { cleanupOnly, now = new Date().toISOString() }) {
  const cleaned = report.cleanup?.status === 'passed' && report.preservation?.status === 'passed';
  if (cleanupOnly) {
    // Preserve verification, checks, fatal, status, and original finishedAt.
    report.lastRecovery = { finishedAt: now, status: cleaned ? 'passed' : 'failed' };
    return cleaned;
  }
  report.verification = { ...evaluateVerification(report), finishedAt: now };
  report.finishedAt = now;
  report.status = report.verification.status === 'passed' && cleaned ? 'passed'
    : report.verification.status === 'incomplete' && cleaned ? 'incomplete' : 'failed';
  return report.status === 'passed';
}

function validateFixtureManifest(report) {
  must(report?.kind === 'local-track-response' && /^sf-context-\d{14}-[a-f0-9]{8}$/.test(report.marker), 'Invalid recovery marker');
  must(Array.isArray(report.users) && report.users.length === 2, 'Invalid recovery accounts');
  must(report.users.every((user, index) => user &&
    user.username === `${report.marker}-${index}` && user.email === `${report.marker}-${index}@example.invalid` &&
    (user.id === undefined || validId(user.id))), 'Invalid recovery account identity');
  const userIds = report.users.filter(user => user.id).map(user => user.id.toLowerCase());
  must(new Set(userIds).size === userIds.length, 'Duplicate fixture account IDs');
  must(validId(report.orphanOwnerId) && !userIds.includes(report.orphanOwnerId.toLowerCase()), 'Invalid orphan owner');
  const owners = [...userIds, report.orphanOwnerId.toLowerCase()];
  must(Array.isArray(report.tracks) && report.tracks.every(track => track && validId(track.ownerId) &&
    owners.includes(track.ownerId.toLowerCase()) && typeof track.title === 'string' && track.title.startsWith(`${report.marker}-`) &&
    (track.id === undefined || (validId(track.id) && !owners.includes(track.id.toLowerCase())))), 'Invalid recovery Track owner, title, or ID');
  const ids = report.tracks.filter(track => track.id).map(track => track.id.toLowerCase());
  must(new Set(ids).size === ids.length, 'Duplicate fixture Track IDs');
  must(Array.isArray(report.checks), 'Invalid verification checks');
  must(report.baseline && ['users', 'tracks', 'tracklikes'].every(name =>
    Number.isSafeInteger(report.baseline[name]?.count) && report.baseline[name].count >= 0 &&
    /^[a-f0-9]{64}$/.test(report.baseline[name].digest)) && /^[a-f0-9]{64}$/.test(report.baseline.mainAccountDigest), 'Missing preservation baseline');
}

async function removeOrphanLikes({ db, connection, track, userIds }) {
  must(validId(track.id) && validId(track.ownerId) && userIds.every(validId), 'Unsafe orphan cleanup identity');
  const fixtureUsers = userIds.map(oid);
  await connection.transaction(async session => {
    // Recheck inside the transaction so a visible foreign Track cannot bypass
    // the parent's marker/owner checks by entering the missing-parent branch.
    const parent = await db.collection('tracks').findOne({ _id: oid(track.id) }, { session });
    must(!parent, 'Track appeared during orphan cleanup; retry recovery');
    const foreignLikes = await db.collection('tracklikes').countDocuments({
      trackId: oid(track.id), userId: { $nin: fixtureUsers },
    }, { session });
    must(foreignLikes === 0, 'Orphan Likes reference a nonfixture account; refusing deletion');
    if (fixtureUsers.length) {
      await db.collection('tracklikes').deleteMany({
        trackId: oid(track.id), userId: { $in: fixtureUsers },
      }, { session });
    }
  });
}

module.exports = {
  MAIN, EXPECTED_CHECKS, VerificationError, must, evaluateVerification,
  prepareRecoveryReport, finishReport, validateFixtureManifest, removeOrphanLikes,
};
