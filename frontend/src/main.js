import './style.css';
import './app.css';

import { LoadWorkspace, SaveWorkspace, SendRequest } from '../wailsjs/go/main/App';

document.querySelector('#app').innerHTML = `
  <main class="layout">
    <aside class="sidebar-panel">
      <div class="sidebar-head">
        <h1>Getman</h1>
        <button id="add-collection" class="ghost">+ Collection</button>
      </div>
      <p class="subtitle">Collections, folders, and requests are persisted locally.</p>
      <div id="workspace-tree" class="workspace-tree"></div>
    </aside>

    <section class="request-panel">
      <div class="section-head">
        <h2>Request</h2>
      </div>
      <input id="request-name" class="control" type="text" placeholder="Request name" />

      <div class="request-line">
        <select id="method" class="control method">
          <option>GET</option>
          <option>POST</option>
          <option>PUT</option>
          <option>PATCH</option>
          <option>DELETE</option>
          <option>HEAD</option>
          <option>OPTIONS</option>
        </select>
        <input id="url" class="control url" type="text" placeholder="https://api.example.com/v1/users" />
        <button id="send" class="send">Send</button>
      </div>

      <div class="section-head">
        <h2>Headers</h2>
        <button id="add-header" class="ghost">Add Header</button>
      </div>
      <div id="headers" class="headers"></div>

      <div class="section-head">
        <h2>Body</h2>
      </div>
      <textarea id="body" class="body" placeholder='{"name":"alice"}'></textarea>
    </section>

    <section class="response-panel">
      <div class="response-meta" id="response-meta">Ready</div>
      <div class="section-head"><h2>Response Headers</h2></div>
      <pre id="response-headers" class="response response-headers">-</pre>
      <div class="section-head"><h2>Response Body</h2></div>
      <pre id="response-body" class="response response-body">Send a request to see response data.</pre>
    </section>
  </main>
`;

const requestNameEl = document.getElementById('request-name');
const methodEl = document.getElementById('method');
const urlEl = document.getElementById('url');
const bodyEl = document.getElementById('body');
const headersEl = document.getElementById('headers');
const responseMetaEl = document.getElementById('response-meta');
const responseHeadersEl = document.getElementById('response-headers');
const responseBodyEl = document.getElementById('response-body');
const sendEl = document.getElementById('send');
const addHeaderEl = document.getElementById('add-header');
const addCollectionEl = document.getElementById('add-collection');
const workspaceTreeEl = document.getElementById('workspace-tree');

let workspace = { collections: [], updatedAt: '' };
let selectedRequestId = '';
let headersDraft = [];
let saveTimer = null;
let bootstrapping = true;

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function createDefaultRequest(name = 'New Request') {
  return {
    id: uid('req'),
    name,
    method: 'GET',
    url: '',
    headers: [{ key: 'Content-Type', value: 'application/json' }],
    body: '',
  };
}

function createDefaultFolder(name = 'New Folder') {
  return {
    id: uid('fld'),
    name,
    requests: [],
  };
}

function createDefaultCollection(name = 'New Collection') {
  return {
    id: uid('col'),
    name,
    requests: [createDefaultRequest('New Request')],
    folders: [],
  };
}

function normalizeWorkspace(input) {
  const normalized = {
    collections: Array.isArray(input?.collections) ? input.collections : [],
    updatedAt: typeof input?.updatedAt === 'string' ? input.updatedAt : '',
  };

  normalized.collections = normalized.collections.map((collection) => ({
    id: collection.id || uid('col'),
    name: collection.name || 'Collection',
    requests: Array.isArray(collection.requests)
      ? collection.requests.map((request) => normalizeRequest(request))
      : [],
    folders: Array.isArray(collection.folders)
      ? collection.folders.map((folder) => ({
          id: folder.id || uid('fld'),
          name: folder.name || 'Folder',
          requests: Array.isArray(folder.requests)
            ? folder.requests.map((request) => normalizeRequest(request))
            : [],
        }))
      : [],
  }));

  return normalized;
}

function normalizeRequest(request) {
  return {
    id: request.id || uid('req'),
    name: request.name || 'Request',
    method: request.method || 'GET',
    url: request.url || '',
    headers: Array.isArray(request.headers) ? request.headers : [],
    body: request.body || '',
  };
}

function ensureWorkspaceSeed() {
  if (workspace.collections.length === 0) {
    const collection = createDefaultCollection('Default Collection');
    workspace.collections.push(collection);
    selectedRequestId = collection.requests[0].id;
    scheduleSave();
    return;
  }

  const selected = findRequestById(selectedRequestId);
  if (selected) {
    return;
  }

  const firstRequest = findFirstRequest();
  selectedRequestId = firstRequest ? firstRequest.id : '';
}

function findFirstRequest() {
  for (const collection of workspace.collections) {
    if (collection.requests.length > 0) {
      return collection.requests[0];
    }

    for (const folder of collection.folders) {
      if (folder.requests.length > 0) {
        return folder.requests[0];
      }
    }
  }

  return null;
}

function findRequestById(requestId) {
  if (!requestId) {
    return null;
  }

  for (const collection of workspace.collections) {
    const fromCollection = collection.requests.find((request) => request.id === requestId);
    if (fromCollection) {
      return fromCollection;
    }

    for (const folder of collection.folders) {
      const fromFolder = folder.requests.find((request) => request.id === requestId);
      if (fromFolder) {
        return fromFolder;
      }
    }
  }

  return null;
}

function setPending(isPending) {
  sendEl.disabled = isPending;
  sendEl.textContent = isPending ? 'Sending...' : 'Send';
}

function formatHeaders(items) {
  if (!items || items.length === 0) {
    return '-';
  }

  return items.map((item) => `${item.key}: ${item.value}`).join('\n');
}

function normalizeBodyForMethod(method, body) {
  if (method === 'GET' || method === 'HEAD') {
    return '';
  }
  return body;
}

function renderHeaders() {
  headersEl.innerHTML = '';

  if (headersDraft.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'headers-empty';
    empty.textContent = 'No headers set.';
    headersEl.appendChild(empty);
    return;
  }

  headersDraft.forEach((header, index) => {
    const row = document.createElement('div');
    row.className = 'header-row';

    const keyInput = document.createElement('input');
    keyInput.className = 'control';
    keyInput.placeholder = 'Header name';
    keyInput.value = header.key;
    keyInput.addEventListener('input', (event) => {
      headersDraft[index].key = event.target.value;
      updateSelectedRequestFromEditor();
    });

    const valueInput = document.createElement('input');
    valueInput.className = 'control';
    valueInput.placeholder = 'Header value';
    valueInput.value = header.value;
    valueInput.addEventListener('input', (event) => {
      headersDraft[index].value = event.target.value;
      updateSelectedRequestFromEditor();
    });

    const removeButton = document.createElement('button');
    removeButton.className = 'remove';
    removeButton.textContent = 'Remove';
    removeButton.addEventListener('click', () => {
      headersDraft = headersDraft.filter((_, i) => i !== index);
      renderHeaders();
      updateSelectedRequestFromEditor();
    });

    row.appendChild(keyInput);
    row.appendChild(valueInput);
    row.appendChild(removeButton);
    headersEl.appendChild(row);
  });
}

function renderTree() {
  workspaceTreeEl.innerHTML = '';

  if (workspace.collections.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'workspace-empty';
    empty.textContent = 'No collections yet.';
    workspaceTreeEl.appendChild(empty);
    return;
  }

  workspace.collections.forEach((collection) => {
    const block = document.createElement('div');
    block.className = 'tree-block';

    const head = document.createElement('div');
    head.className = 'tree-head';

    const title = document.createElement('div');
    title.className = 'tree-title';
    title.textContent = collection.name;

    const actions = document.createElement('div');
    actions.className = 'tree-actions';

    const addRequestBtn = document.createElement('button');
    addRequestBtn.className = 'ghost tiny';
    addRequestBtn.textContent = '+ Request';
    addRequestBtn.addEventListener('click', () => {
      const request = createDefaultRequest('Collection Request');
      collection.requests.push(request);
      selectedRequestId = request.id;
      renderTree();
      syncEditorFromSelectedRequest();
      scheduleSave();
    });

    const addFolderBtn = document.createElement('button');
    addFolderBtn.className = 'ghost tiny';
    addFolderBtn.textContent = '+ Folder';
    addFolderBtn.addEventListener('click', () => {
      collection.folders.push(createDefaultFolder('New Folder'));
      renderTree();
      scheduleSave();
    });

    actions.appendChild(addRequestBtn);
    actions.appendChild(addFolderBtn);
    head.appendChild(title);
    head.appendChild(actions);
    block.appendChild(head);

    collection.requests.forEach((request) => {
      block.appendChild(buildRequestTreeItem(request, 0));
    });

    collection.folders.forEach((folder) => {
      const folderBlock = document.createElement('div');
      folderBlock.className = 'folder-block';

      const folderHead = document.createElement('div');
      folderHead.className = 'folder-head';
      folderHead.textContent = folder.name;

      const folderAddRequest = document.createElement('button');
      folderAddRequest.className = 'ghost tiny';
      folderAddRequest.textContent = '+ Request';
      folderAddRequest.addEventListener('click', () => {
        const request = createDefaultRequest(`${folder.name} Request`);
        folder.requests.push(request);
        selectedRequestId = request.id;
        renderTree();
        syncEditorFromSelectedRequest();
        scheduleSave();
      });

      folderHead.appendChild(folderAddRequest);
      folderBlock.appendChild(folderHead);

      folder.requests.forEach((request) => {
        folderBlock.appendChild(buildRequestTreeItem(request, 1));
      });

      block.appendChild(folderBlock);
    });

    workspaceTreeEl.appendChild(block);
  });
}

function buildRequestTreeItem(request, indentLevel) {
  const button = document.createElement('button');
  button.className = 'tree-request';
  if (request.id === selectedRequestId) {
    button.classList.add('active');
  }
  if (indentLevel > 0) {
    button.classList.add('indented');
  }

  button.textContent = `${request.method || 'GET'} ${request.name || 'Request'}`;
  button.addEventListener('click', () => {
    selectedRequestId = request.id;
    renderTree();
    syncEditorFromSelectedRequest();
  });

  return button;
}

function syncEditorFromSelectedRequest() {
  const selected = findRequestById(selectedRequestId);
  if (!selected) {
    requestNameEl.value = '';
    methodEl.value = 'GET';
    urlEl.value = '';
    bodyEl.value = '';
    headersDraft = [];
    renderHeaders();
    return;
  }

  requestNameEl.value = selected.name || '';
  methodEl.value = selected.method || 'GET';
  urlEl.value = selected.url || '';
  bodyEl.value = selected.body || '';
  headersDraft = Array.isArray(selected.headers)
    ? selected.headers.map((item) => ({ key: item.key || '', value: item.value || '' }))
    : [];

  renderHeaders();
}

function updateSelectedRequestFromEditor() {
  const selected = findRequestById(selectedRequestId);
  if (!selected) {
    return;
  }

  selected.name = requestNameEl.value.trim() || 'Untitled Request';
  selected.method = methodEl.value;
  selected.url = urlEl.value.trim();
  selected.body = bodyEl.value;
  selected.headers = headersDraft
    .map((header) => ({ key: header.key.trim(), value: header.value }))
    .filter((header) => header.key.length > 0);

  renderTree();
  scheduleSave();
}

function scheduleSave() {
  if (bootstrapping) {
    return;
  }

  if (saveTimer) {
    clearTimeout(saveTimer);
  }

  saveTimer = setTimeout(() => {
    persistWorkspace();
  }, 250);
}

async function persistWorkspace() {
  try {
    await SaveWorkspace(workspace);
  } catch (error) {
    responseMetaEl.textContent = `Save failed: ${error?.message || String(error)}`;
  }
}

async function sendRequest() {
  updateSelectedRequestFromEditor();
  const selected = findRequestById(selectedRequestId);

  if (!selected) {
    responseMetaEl.textContent = 'Error: no request selected';
    return;
  }

  if (!selected.url) {
    responseMetaEl.textContent = 'Error: URL is required';
    return;
  }

  const payload = {
    method: selected.method,
    url: selected.url,
    headers: selected.headers,
    body: normalizeBodyForMethod(selected.method, selected.body),
    timeoutSeconds: 30,
  };

  responseMetaEl.textContent = 'Sending request...';
  responseHeadersEl.textContent = '-';
  responseBodyEl.textContent = 'Loading...';
  setPending(true);

  try {
    const response = await SendRequest(payload);
    responseMetaEl.textContent = `${response.statusText} in ${response.durationMs} ms`;
    responseHeadersEl.textContent = formatHeaders(response.headers);
    responseBodyEl.textContent = response.body || '<empty response body>';
  } catch (error) {
    responseMetaEl.textContent = 'Request failed';
    responseHeadersEl.textContent = '-';
    responseBodyEl.textContent = error?.message || String(error);
  } finally {
    setPending(false);
  }
}

addCollectionEl.addEventListener('click', () => {
  const collection = createDefaultCollection(`Collection ${workspace.collections.length + 1}`);
  workspace.collections.push(collection);
  selectedRequestId = collection.requests[0].id;
  renderTree();
  syncEditorFromSelectedRequest();
  scheduleSave();
});

addHeaderEl.addEventListener('click', () => {
  headersDraft.push({ key: '', value: '' });
  renderHeaders();
  updateSelectedRequestFromEditor();
});

sendEl.addEventListener('click', sendRequest);
urlEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    sendRequest();
  }
});

requestNameEl.addEventListener('input', updateSelectedRequestFromEditor);
methodEl.addEventListener('change', updateSelectedRequestFromEditor);
urlEl.addEventListener('input', updateSelectedRequestFromEditor);
bodyEl.addEventListener('input', updateSelectedRequestFromEditor);

async function bootstrap() {
  try {
    const loaded = await LoadWorkspace();
    workspace = normalizeWorkspace(loaded);
  } catch (error) {
    workspace = { collections: [], updatedAt: '' };
    responseMetaEl.textContent = `Load failed: ${error?.message || String(error)}`;
  }

  ensureWorkspaceSeed();
  renderTree();
  syncEditorFromSelectedRequest();
  urlEl.focus();

  bootstrapping = false;
  scheduleSave();
}

bootstrap();
