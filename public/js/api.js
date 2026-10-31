// Thin fetch wrappers for the local server.

async function request(method, url, body, headers = {}) {
  const init = { method, headers: { 'X-GeoKeep': '1', ...headers } };
  if (body !== undefined) {
    if (body instanceof Blob || body instanceof ArrayBuffer) {
      init.body = body;
    } else {
      init.body = JSON.stringify(body);
      init.headers['Content-Type'] = 'application/json';
    }
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (!res.ok) throw new Error(data?.error || `${res.status} ${res.statusText}`);
  return data;
}

export const api = {
  state: () => request('GET', '/api/state'),
  reload: () => request('POST', '/api/reload'),
  create: (fields) => request('POST', '/api/notes', fields),
  patch: (id, patch) => request('PATCH', `/api/notes/${id}`, patch),
  remove: (id) => request('DELETE', `/api/notes/${id}`),
  copy: (id) => request('POST', `/api/notes/${id}/copy`),
  attach: (id, file) => request('POST', `/api/notes/${id}/attachments`, file, { 'Content-Type': file.type || 'application/octet-stream' }),
  emptyTrash: () => request('POST', '/api/trash/empty'),
  addLabel: (name) => request('POST', '/api/labels', { name }),
  renameLabel: (from, to) => request('POST', '/api/labels/rename', { from, to }),
  deleteLabel: (name) => request('POST', '/api/labels/delete', { name }),
  importStart: () => request('POST', '/api/import'),
  importCommit: (id) => request('POST', `/api/import/${id}/commit`),
  snapshots: () => request('GET', '/api/snapshots'),
  snapshot: () => request('POST', '/api/snapshots'),

  /** Upload one file into an import session, reporting progress. */
  importFile(id, path, file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', `/api/import/${id}/file?path=${encodeURIComponent(path)}`);
      xhr.setRequestHeader('X-GeoKeep', '1');
      xhr.upload.onprogress = (e) => onProgress?.(e.loaded);
      xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error(xhr.responseText || `Upload failed (${xhr.status})`)));
      xhr.onerror = () => reject(new Error('Upload failed'));
      xhr.send(file);
    });
  },
};
