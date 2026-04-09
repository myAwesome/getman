import './style.css';
import './app.css';

import {
  LoadWorkspace,
  SendRequest,
  CreateCollection,
  UpdateCollection,
  DeleteCollection,
  CreateFolder,
  UpdateFolder,
  DeleteFolder,
  CreateRequest,
  UpdateRequest,
  DeleteRequest,
} from '../wailsjs/go/main/App';

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
let syncingSelection = false;
let requestSaveTimer = null;

function normalizeWorkspace(input) {
  const normalized = {
    collections: Array.isArray(input?.collections) ? input.collections : [],
    updatedAt: typeof input?.updatedAt === 'string' ? input.updatedAt : '',
  };

  normalized.collections = normalized.collections.map((collection) => ({
    id: collection.id || '',
    name: collection.name || 'Collection',
    requests: Array.isArray(collection.requests)
      ? collection.requests.map((request) => normalizeRequest(request))
      : [],
    folders: Array.isArray(collection.folders)
      ? collection.folders.map((folder) => ({
          id: folder.id || '',
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
    id: request.id || '',
    name: request.name || 'Request',
    method: request.method || 'GET',
    url: request.url || '',
    headers: Array.isArray(request.headers) ? request.headers : [],
    body: request.body || '',
  };
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

function findRequestLocation(requestId) {
  if (!requestId) {
    return null;
  }

  for (const collection of workspace.collections) {
    const fromCollection = collection.requests.find((request) => request.id === requestId);
    if (fromCollection) {
      return { request: fromCollection, collection, folder: null };
    }

    for (const folder of collection.folders) {
      const fromFolder = folder.requests.find((request) => request.id === requestId);
      if (fromFolder) {
        return { request: fromFolder, collection, folder };
      }
    }
  }

  return null;
}

async function reloadWorkspace(preferredRequestId = '') {
  const loaded = await LoadWorkspace();
  workspace = normalizeWorkspace(loaded);

  const preferred = findRequestById(preferredRequestId);
  const current = findRequestById(selectedRequestId);
  if (preferred) {
    selectedRequestId = preferred.id;
  } else if (current) {
    selectedRequestId = current.id;
  } else {
    const first = findFirstRequest();
    selectedRequestId = first ? first.id : '';
  }

  renderTree();
  syncEditorFromSelectedRequest();
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

    const renameCollectionBtn = document.createElement('button');
    renameCollectionBtn.className = 'ghost tiny';
    renameCollectionBtn.textContent = 'Rename';
    renameCollectionBtn.addEventListener('click', async () => {
      const value = window.prompt('Collection name', collection.name);
      if (value === null) {
        return;
      }
      await mutate(async () => {
        await UpdateCollection(collection.id, value.trim());
        await reloadWorkspace(selectedRequestId);
      });
    });

    const addRequestBtn = document.createElement('button');
    addRequestBtn.className = 'ghost tiny';
    addRequestBtn.textContent = '+ Request';
    addRequestBtn.addEventListener('click', async () => {
      await mutate(async () => {
        const request = await CreateRequest({
          collectionId: collection.id,
          folderId: '',
          name: 'Collection Request',
          method: 'GET',
          url: '',
          headers: [{ key: 'Content-Type', value: 'application/json' }],
          body: '',
        });
        await reloadWorkspace(request.id);
      });
    });

    const addFolderBtn = document.createElement('button');
    addFolderBtn.className = 'ghost tiny';
    addFolderBtn.textContent = '+ Folder';
    addFolderBtn.addEventListener('click', async () => {
      await mutate(async () => {
        await CreateFolder(collection.id, 'New Folder');
        await reloadWorkspace(selectedRequestId);
      });
    });

    const deleteCollectionBtn = document.createElement('button');
    deleteCollectionBtn.className = 'remove tiny';
    deleteCollectionBtn.textContent = 'Delete';
    deleteCollectionBtn.addEventListener('click', async () => {
      if (!window.confirm(`Delete collection "${collection.name}"?`)) {
        return;
      }
      await mutate(async () => {
        await DeleteCollection(collection.id);
        await reloadWorkspace('');
      });
    });

    actions.appendChild(renameCollectionBtn);
    actions.appendChild(addRequestBtn);
    actions.appendChild(addFolderBtn);
    actions.appendChild(deleteCollectionBtn);
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

      const folderTitle = document.createElement('span');
      folderTitle.textContent = folder.name;

      const folderActions = document.createElement('div');
      folderActions.className = 'tree-actions';

      const renameFolderBtn = document.createElement('button');
      renameFolderBtn.className = 'ghost tiny';
      renameFolderBtn.textContent = 'Rename';
      renameFolderBtn.addEventListener('click', async () => {
        const value = window.prompt('Folder name', folder.name);
        if (value === null) {
          return;
        }
        await mutate(async () => {
          await UpdateFolder(folder.id, value.trim());
          await reloadWorkspace(selectedRequestId);
        });
      });

      const folderAddRequest = document.createElement('button');
      folderAddRequest.className = 'ghost tiny';
      folderAddRequest.textContent = '+ Request';
      folderAddRequest.addEventListener('click', async () => {
        await mutate(async () => {
          const request = await CreateRequest({
            collectionId: collection.id,
            folderId: folder.id,
            name: `${folder.name} Request`,
            method: 'GET',
            url: '',
            headers: [{ key: 'Content-Type', value: 'application/json' }],
            body: '',
          });
          await reloadWorkspace(request.id);
        });
      });

      const deleteFolderBtn = document.createElement('button');
      deleteFolderBtn.className = 'remove tiny';
      deleteFolderBtn.textContent = 'Delete';
      deleteFolderBtn.addEventListener('click', async () => {
        if (!window.confirm(`Delete folder "${folder.name}" and all contained requests?`)) {
          return;
        }
        await mutate(async () => {
          await DeleteFolder(folder.id);
          await reloadWorkspace(selectedRequestId);
        });
      });

      folderActions.appendChild(renameFolderBtn);
      folderActions.appendChild(folderAddRequest);
      folderActions.appendChild(deleteFolderBtn);
      folderHead.appendChild(folderTitle);
      folderHead.appendChild(folderActions);
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
  const row = document.createElement('div');
  row.className = 'tree-head';

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

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'remove tiny';
  deleteBtn.textContent = 'Delete';
  deleteBtn.addEventListener('click', async () => {
    if (!window.confirm(`Delete request "${request.name}"?`)) {
      return;
    }

    await mutate(async () => {
      await DeleteRequest(request.id);
      await reloadWorkspace('');
    });
  });

  row.appendChild(button);
  row.appendChild(deleteBtn);
  return row;
}

function syncEditorFromSelectedRequest() {
  syncingSelection = true;

  const selected = findRequestById(selectedRequestId);
  if (!selected) {
    requestNameEl.value = '';
    methodEl.value = 'GET';
    urlEl.value = '';
    bodyEl.value = '';
    headersDraft = [];
    renderHeaders();
    syncingSelection = false;
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
  syncingSelection = false;
}

function updateSelectedRequestFromEditor() {
  if (syncingSelection) {
    return;
  }

  const location = findRequestLocation(selectedRequestId);
  if (!location) {
    return;
  }

  location.request.name = requestNameEl.value.trim() || 'Untitled Request';
  location.request.method = methodEl.value;
  location.request.url = urlEl.value.trim();
  location.request.body = bodyEl.value;
  location.request.headers = headersDraft
    .map((header) => ({ key: header.key.trim(), value: header.value }))
    .filter((header) => header.key.length > 0);

  renderTree();
  scheduleRequestSave();
}

function scheduleRequestSave() {
  if (requestSaveTimer) {
    clearTimeout(requestSaveTimer);
  }

  requestSaveTimer = setTimeout(() => {
    persistSelectedRequest();
  }, 250);
}

async function persistSelectedRequest() {
  const location = findRequestLocation(selectedRequestId);
  if (!location) {
    return;
  }

  await mutate(async () => {
    await UpdateRequest({
      id: location.request.id,
      collectionId: location.collection.id,
      folderId: location.folder ? location.folder.id : '',
      name: location.request.name,
      method: location.request.method,
      url: location.request.url,
      headers: location.request.headers,
      body: location.request.body,
    });
  });
}

async function mutate(fn) {
  try {
    await fn();
  } catch (error) {
    responseMetaEl.textContent = `Persistence failed: ${error?.message || String(error)}`;
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

addCollectionEl.addEventListener('click', async () => {
  await mutate(async () => {
    const collection = await CreateCollection(`Collection ${workspace.collections.length + 1}`);
    const request = await CreateRequest({
      collectionId: collection.id,
      folderId: '',
      name: 'New Request',
      method: 'GET',
      url: '',
      headers: [{ key: 'Content-Type', value: 'application/json' }],
      body: '',
    });
    await reloadWorkspace(request.id);
  });
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
    await reloadWorkspace();

    if (workspace.collections.length === 0) {
      const collection = await CreateCollection('Default Collection');
      const request = await CreateRequest({
        collectionId: collection.id,
        folderId: '',
        name: 'New Request',
        method: 'GET',
        url: '',
        headers: [{ key: 'Content-Type', value: 'application/json' }],
        body: '',
      });
      await reloadWorkspace(request.id);
    }
  } catch (error) {
    workspace = { collections: [], updatedAt: '' };
    responseMetaEl.textContent = `Load failed: ${error?.message || String(error)}`;
    renderTree();
    syncEditorFromSelectedRequest();
  }

  urlEl.focus();
}

async function waitForWailsBridge(timeoutMs = 5000) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    if (window?.go?.main?.App) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error('Wails bridge did not initialize in time');
}

async function startApp() {
  try {
    await waitForWailsBridge();
    await bootstrap();
  } catch (error) {
    responseMetaEl.textContent = `Startup failed: ${error?.message || String(error)}`;
  }
}

startApp();
