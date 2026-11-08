// `repository.findById(id)` returns a promise of a user ({ id, email, active })
// or null when the user does not exist.

async function countActiveUsers(repository, ids) {
  let count = 0;
  for (const id of ids) {
    const user = await repository.findById(id);
    if (user && user.active) count += 1;
  }
  return count;
}

async function getUserEmails(repository, ids) {
  const users = await Promise.all(ids.map((id) => repository.findById(id)));
  return users.filter(Boolean).map((user) => user.email);
}

module.exports = { countActiveUsers, getUserEmails };
