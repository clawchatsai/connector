// Workspace names are interpolated straight into SQLite filenames
// (`<name>.db`) under the data directory, so any character outside this set is
// a path-traversal vector. Kept in one place so the request boundary and the
// create endpoint cannot drift apart.
export const WORKSPACE_NAME_PATTERN = /^[a-z0-9-]{1,32}$/;

export function isValidWorkspaceName(name) {
  return typeof name === 'string' && WORKSPACE_NAME_PATTERN.test(name);
}
