import fs from 'node:fs';

/**
 * Factory that returns workspace config read/write helpers bound to a specific file path.
 * Keeps file I/O out of the HTTP router (server/index.js).
 */
export function createWorkspaceStore(workspacesFile) {
  let cache = null;

  function getWorkspaces() {
    if (!cache) {
      try {
        cache = JSON.parse(fs.readFileSync(workspacesFile, 'utf8'));
      } catch {
        cache = {
          active: 'default',
          workspaces: { default: { name: 'default', label: 'Default', createdAt: Date.now() } },
        };
        fs.writeFileSync(workspacesFile, JSON.stringify(cache, null, 2));
      }
    }
    return cache;
  }

  function setWorkspaces(data) {
    cache = data;
    fs.writeFileSync(workspacesFile, JSON.stringify(data, null, 2));
  }

  return { getWorkspaces, setWorkspaces };
}
