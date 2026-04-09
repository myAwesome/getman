import './style.css';
import './app.css';

import { SendRequest } from '../wailsjs/go/main/App';

const initialHeaders = [
  { key: 'Content-Type', value: 'application/json' },
];

document.querySelector('#app').innerHTML = `
  <main class="layout">
    <section class="request-panel">
      <h1>Getman</h1>
      <p class="subtitle">Personal API client for quick request checks.</p>

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

const methodEl = document.getElementById('method');
const urlEl = document.getElementById('url');
const bodyEl = document.getElementById('body');
const headersEl = document.getElementById('headers');
const responseMetaEl = document.getElementById('response-meta');
const responseHeadersEl = document.getElementById('response-headers');
const responseBodyEl = document.getElementById('response-body');
const sendEl = document.getElementById('send');
const addHeaderEl = document.getElementById('add-header');

let headers = [...initialHeaders];

function renderHeaders() {
  headersEl.innerHTML = '';

  if (headers.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'headers-empty';
    empty.textContent = 'No headers set.';
    headersEl.appendChild(empty);
    return;
  }

  headers.forEach((header, index) => {
    const row = document.createElement('div');
    row.className = 'header-row';

    const keyInput = document.createElement('input');
    keyInput.className = 'control';
    keyInput.placeholder = 'Header name';
    keyInput.value = header.key;
    keyInput.addEventListener('input', (event) => {
      headers[index].key = event.target.value;
    });

    const valueInput = document.createElement('input');
    valueInput.className = 'control';
    valueInput.placeholder = 'Header value';
    valueInput.value = header.value;
    valueInput.addEventListener('input', (event) => {
      headers[index].value = event.target.value;
    });

    const removeButton = document.createElement('button');
    removeButton.className = 'remove';
    removeButton.textContent = 'Remove';
    removeButton.addEventListener('click', () => {
      headers = headers.filter((_, i) => i !== index);
      renderHeaders();
    });

    row.appendChild(keyInput);
    row.appendChild(valueInput);
    row.appendChild(removeButton);
    headersEl.appendChild(row);
  });
}

function setPending(isPending) {
  sendEl.disabled = isPending;
  sendEl.textContent = isPending ? 'Sending...' : 'Send';
}

function formatHeaders(items) {
  if (!items || items.length === 0) {
    return '-';
  }

  return items
    .map((item) => `${item.key}: ${item.value}`)
    .join('\n');
}

function normalizeBodyForMethod(method, body) {
  if (method === 'GET' || method === 'HEAD') {
    return '';
  }
  return body;
}

async function sendRequest() {
  const method = methodEl.value;
  const url = urlEl.value.trim();

  if (!url) {
    responseMetaEl.textContent = 'Error: URL is required';
    return;
  }

  const payload = {
    method,
    url,
    headers: headers
      .map((item) => ({ key: item.key.trim(), value: item.value }))
      .filter((item) => item.key.length > 0),
    body: normalizeBodyForMethod(method, bodyEl.value),
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

sendEl.addEventListener('click', sendRequest);
addHeaderEl.addEventListener('click', () => {
  headers.push({ key: '', value: '' });
  renderHeaders();
});
urlEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    sendRequest();
  }
});

renderHeaders();
urlEl.focus();
