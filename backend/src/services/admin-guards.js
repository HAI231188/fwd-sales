// Pure guard predicates for the admin user-management endpoints. Kept here
// (no DB, no req/res) so the self-lock + last-admin invariants can be unit
// tested in isolation, and so routes/admin.js composes them consistently.
//
// Invariants (owner spec, 2026-06-11):
//   • An admin may NOT disable or demote THEMSELVES (no accidental self-lockout).
//   • The app must ALWAYS retain >= 1 active (non-disabled) admin — the LAST
//     active admin cannot be disabled or demoted away from 'admin'.

const { ALL_ROLES } = require('../constants/roles');

function isValidRole(role) {
  return ALL_ROLES.includes(role);
}

// True when the actor is acting on their own account (id compare, type-safe).
function isSelf(actorId, targetId) {
  return Number(actorId) === Number(targetId);
}

// Would disabling/demoting this target remove the last active admin?
//   targetIsActiveAdmin = target currently has role 'admin' AND is not disabled.
//   activeAdminCount    = COUNT(users WHERE role='admin' AND disabled_at IS NULL)
//                         — this count INCLUDES the target when it is active.
// So when the target is the only active admin, activeAdminCount === 1 → blocked.
function wouldRemoveLastAdmin(targetIsActiveAdmin, activeAdminCount) {
  return !!targetIsActiveAdmin && Number(activeAdminCount) <= 1;
}

module.exports = { isValidRole, isSelf, wouldRemoveLastAdmin };
