const $ = sel => document.querySelector(sel);
const $$ = sel => document.querySelectorAll(sel);

let currentUser = null;
let role = 'parent'; // default login role toggle
let tab = null;
let chatCid = null;
let chatMsgs = [];
const state = { children: [], photos: [] };

// Socket Connection
const socket = io({ auth: { token: api.token } });

socket.on('message', msg => {
  if (msg.child_id === chatCid) {
    chatMsgs.push(msg);
    drawChat();
  }
});

socket.on('status', () => {
  if (currentUser) refresh();
});

// Toast System
function toast(msg, type = 'ok') {
  const c = $('#toast-container');
  const t = document.createElement('div');
  t.className = `p-3 rounded shadow text-white text-sm transition-all ${type === 'bad' ? 'bg-red-500' : 'bg-emerald-600'}`;
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

function mailToast(info) {
  toast(`Email sent to ${info.to}: ${info.subject}`);
}

function bad() {
  // shake effect or visual cue if needed
}

function chkAll(formSel) {
  const form = $(formSel);
  if (!form) return true;
  return form.checkValidity();
}

// Init App
async function init() {
  if (api.token) {
    try {
      // Try to fetch children to validate token & get user profile
      const children = await api.req('/children');
      // Kung nakuha, kunin ang user info sa pamamagitan ng token payload o re-login trick, 
      // Pero dahil walang /me route, pwede nating i-decode o i-store ang user info sa localStorage.
      currentUser = JSON.parse(localStorage.getItem('kc_user') || 'null');
      if (currentUser) {
        state.children = children;
        if (currentUser.role === 'parent') state.photos = await api.req('/photos').catch(() => []);
      }
    } catch {
      api.setToken(null);
      localStorage.removeItem('kc_user');
      currentUser = null;
    }
  }
  view();
}

async function refresh() {
  try {
    state.children = await api.req('/children');
    if (currentUser && currentUser.role === 'parent') {
      state.photos = await api.req('/photos').catch(() => []);
    }
    view();
  } catch (err) {
    toast(err.message, 'bad');
  }
}

// Views Controller
function view() {
  const app = $('#app');
  if (!currentUser) {
    app.innerHTML = renderAuth();
    initGoogleLogin();
    return;
  }

  if (currentUser.role === 'admin') {
    app.innerHTML = renderAdminDashboard();
  } else {
    app.innerHTML = renderParentDashboard();
  }
}

// --- AUTH RENDERS ---
function renderAuth() {
  return `
    <div class="flex-grow flex items-center justify-center p-4">
      <div class="bg-white p-8 rounded-xl shadow-md w-full max-w-md">
        <h1 class="text-2xl font-bold text-center text-indigo-600 mb-6">KidsCare Portal</h1>
        
        <div class="flex border-b mb-6">
          <button onclick="setAuthMode('login')" class="flex-1 pb-2 font-semibold text-center ${role !== 'signup' ? 'border-b-2 border-indigo-600 text-indigo-600' : 'text-slate-400'}">Login</button>
          <button onclick="setAuthMode('signup')" class="flex-1 pb-2 font-semibold text-center ${role === 'signup' ? 'border-b-2 border-indigo-600 text-indigo-600' : 'text-slate-400'}">Sign Up (Parent)</button>
        </div>

        <div class="mb-4 flex justify-center gap-4 ${role === 'signup' ? 'hidden' : ''}">
          <label class="flex items-center gap-2 cursor-pointer">
            <input type="radio" name="loginRole" value="parent" ${role === 'parent' ? 'checked' : ''} onchange="role='parent'"> Parent
          </label>
          <label class="flex items-center gap-2 cursor-pointer">
            <input type="radio" name="loginRole" value="admin" ${role === 'admin' ? 'checked' : ''} onchange="role='admin'"> Admin
          </label>
        </div>

        <form id="f" onsubmit="handleAuthSubmit(event)" class="space-y-4">
          <div id="nameField" class="${role === 'signup' ? '' : 'hidden'}">
            <label class="block text-sm font-medium mb-1">Full Name</label>
            <input type="text" id="name" class="w-full border rounded p-2 focus:ring-2 focus:ring-indigo-500 outline-none">
          </div>
          <div>
            <label class="block text-sm font-medium mb-1">Email Address</label>
            <input type="email" id="em" required class="w-full border rounded p-2 focus:ring-2 focus:ring-indigo-500 outline-none">
          </div>
          <div>
            <label class="block text-sm font-medium mb-1">Password (min 6 chars)</label>
            <input type="password" id="pw" required minlength="6" class="w-full border rounded p-2 focus:ring-2 focus:ring-indigo-500 outline-none">
          </div>
          <button type="submit" class="w-full bg-indigo-600 text-white py-2 rounded font-semibold hover:bg-indigo-700 transition">
            ${role === 'signup' ? 'Register Account' : 'Login'}
          </button>
        </form>

        <div class="mt-6 ${role === 'signup' ? 'hidden' : ''}">
          <div class="relative flex py-2 items-center">
            <div class="flex-grow border-t border-slate-200"></div>
            <span class="flex-shrink mx-4 text-slate-400 text-sm">O kaya</span>
            <div class="flex-grow border-t border-slate-200"></div>
          </div>
          <div id="googleButtonContainer" class="flex justify-center mt-4"></div>
        </div>
      </div>
    </div>
  `;
}

function setAuthMode(mode) {
  role = mode === 'signup' ? 'parent' : 'parent';
  if (mode === 'signup') role = 'signup';
  view();
}

async function handleAuthSubmit(e) {
  e.preventDefault();
  const email = $('#em').value;
  const password = $('#pw').value;
  
  try {
    if (role === 'signup') {
      const name = $('#name').value;
      const d = await api.req('/signup', { method: 'POST', body: { name, email, password } });
      api.setToken(d.token);
      currentUser = d.user;
      localStorage.setItem('kc_user', JSON.stringify(currentUser));
      toast('Registration successful!');
    } else {
      const loginRole = document.querySelector('input[name="loginRole"]:checked').value;
      const d = await api.req('/login', { method: 'POST', body: { email, password, role: loginRole } });
      api.setToken(d.token);
      currentUser = d.user;
      localStorage.setItem('kc_user', JSON.stringify(currentUser));
      toast('Login successful!');
    }
    socket.auth = { token: api.token };
    socket.connect();
    await refresh();
  } catch (err) {
    toast(err.message, 'bad');
  }
}

async function initGoogleLogin() {
  try {
    const config = await api.req('/config');
    if (!config.googleClientId) return;
    
    google.accounts.id.initialize({
      client_id: config.googleClientId,
      callback: handleGoogleResponse
    });
    google.accounts.id.renderButton(
      document.getElementById('googleButtonContainer'),
      { theme: 'outline', size: 'large', width: '100%' }
    );
  } catch (e) {
    console.error('Google config failed', e);
  }
}

async function handleGoogleResponse(response) {
  try {
    const d = await api.req('/google', { method: 'POST', body: { credential: response.credential } });
    api.setToken(d.token);
    currentUser = d.user;
    localStorage.setItem('kc_user', JSON.stringify(currentUser));
    socket.auth = { token: api.token };
    socket.connect();
    toast('Google Login successful!');
    await refresh();
  } catch (err) {
    toast(err.message, 'bad');
  }
}

function logout() {
  api.setToken(null);
  localStorage.removeItem('kc_user');
  currentUser = null;
  socket.disconnect();
  view();
}

// --- ADMIN DASHBOARD ---
function renderAdminDashboard() {
  return `
    <header class="bg-white shadow px-6 py-4 flex justify-between items-center">
      <h1 class="text-xl font-bold text-indigo-600">KidsCare Admin Portal</h1>
      <div class="flex items-center gap-4">
        <span class="text-sm text-slate-600">Admin: <b>${currentUser.name}</b></span>
        <button onclick="logout()" class="text-sm bg-slate-200 px-3 py-1.5 rounded hover:bg-slate-300">Logout</button>
      </div>
    </header>
    <main class="flex-grow p-6 max-w-6xl mx-auto w-full grid grid-cols-1 md:grid-cols-2 gap-6">
      <div class="bg-white p-6 rounded-xl shadow-md">
        <h2 class="text-lg font-semibold mb-4 text-indigo-600">QR Code Scanner (Attendance)</h2>
        <div class="space-y-4">
          <div>
            <label class="block text-sm font-medium mb-1">Scan QR Token / Enter Code</label>
            <div class="flex gap-2">
              <input type="text" id="qrInput" placeholder="I-paste ang qr_token o i-scan..." class="flex-grow border rounded p-2 outline-none focus:ring-2 focus:ring-indigo-500">
              <button onclick="submitScan()" class="bg-indigo-600 text-white px-4 py-2 rounded hover:bg-indigo-700">Scan</button>
            </div>
          </div>
        </div>
        <hr class="my-6">
        <h2 class="text-lg font-semibold mb-4 text-indigo-600">Mag-upload ng Larawan</h2>
        <form onsubmit="handlePhotoUpload(event)" class="space-y-3">
          <div>
            <label class="block text-sm font-medium mb-1">Pumili ng Bata</label>
            <select id="photoChildId" class="w-full border rounded p-2">
              <option value="all">Lahat ng Bata (General)</option>
              ${state.children.map(c => `<option value="${c.id}">${c.name}</option>`).join('')}
            </select>
          </div>
          <div>
            <label class="block text-sm font-medium mb-1">Larawan (JPG, PNG, WEBP, Max 5MB)</label>
            <input type="file" id="photoFile" accept="image/jpeg,image/png,image/webp" required class="w-full border rounded p-2 text-sm">
          </div>
          <div>
            <label class="block text-sm font-medium mb-1">Caption</label>
            <input type="text" id="photoCaption" placeholder="Maikling kwento o caption..." class="w-full border rounded p-2">
          </div>
          <button type="submit" class="w-full bg-emerald-600 text-white py-2 rounded hover:bg-emerald-700">Upload Photo</button>
        </form>
      </div>

      <div class="bg-white p-6 rounded-xl shadow-md flex flex-col">
        <h2 class="text-lg font-semibold mb-4 text-indigo-600">Listahan ng mga Bata at Chat</h2>
        <div class="overflow-y-auto flex-grow space-y-3 max-h-[500px]">
          ${state.children.length === 0 ? '<p class="text-slate-400 text-sm">Wala pang nakarehistrong bata.</p>' : ''}
          ${state.children.map(c => `
            <div class="border rounded-lg p-4 flex flex-col gap-2 bg-slate-50">
              <div class="flex justify-between items-start">
                <div>
                  <h3 class="font-bold text-slate-800">${c.name}</h3>
                  <p class="text-xs text-slate-500">Parent: ${c.parent_name} (${c.parent_email})</p>
                  <p class="text-xs text-slate-500">Status: <span class="font-semibold ${c.status === 'at_school' ? 'text-emerald-600' : 'text-amber-600'}">${c.status || 'home'}</span></p>
                </div>
                <button onclick="openChatModal(${c.id}, '${c.name}')" class="bg-indigo-100 text-indigo-700 px-3 py-1 rounded text-xs font-semibold hover:bg-indigo-200">Chat</button>
              </div>
              <div class="text-xs font-mono bg-slate-200 p-1.5 rounded truncate">QR Token: ${c.qr_token}</div>
            </div>
          `).join('')}
        </div>
      </div>
    </main>
    <div id="chatModal"></div>
  `;
}

async function submitScan() {
  const tokenVal = $('#qrInput').value.trim();
  if (!tokenVal) return toast('Ilagay ang QR token', 'bad');
  try {
    const r = await api.req('/scan', { method: 'POST', body: { token: tokenVal } });
    mailToast({ to: r.emailedTo, subject: r.subject, body: r.body });
    toast(`Scan Success: ${r.child} ay nasa status na ${r.status}`);
    $('#qrInput').value = '';
    refresh();
  } catch (err) {
    toast(err.message, 'bad');
  }
}

async function handlePhotoUpload(e) {
  e.preventDefault();
  const fileInput = $('#photoFile');
  if (!fileInput.files[0]) return toast('Pumili ng larawan', 'bad');

  const fd = new FormData();
  fd.append('photo', fileInput.files[0]);
  fd.append('childId', $('#photoChildId').value);
  fd.append('caption', $('#photoCaption').value);

  try {
    await api.req('/photos', { method: 'POST', body: fd });
    toast('Photo uploaded successfully!');
    e.target.reset();
  } catch (err) {
    toast(err.message, 'bad');
  }
}

// --- PARENT DASHBOARD ---
function renderParentDashboard() {
  return `
    <header class="bg-white shadow px-6 py-4 flex justify-between items-center">
      <h1 class="text-xl font-bold text-indigo-600">KidsCare Parent Portal</h1>
      <div class="flex items-center gap-4">
        <span class="text-sm text-slate-600">Parent: <b>${currentUser.name}</b></span>
        <button onclick="logout()" class="text-sm bg-slate-200 px-3 py-1.5 rounded hover:bg-slate-300">Logout</button>
      </div>
    </header>
    <main class="flex-grow p-6 max-w-6xl mx-auto w-full grid grid-cols-1 md:grid-cols-2 gap-6">
      <div class="space-y-6">
        <div class="bg-white p-6 rounded-xl shadow-md">
          <h2 class="text-lg font-semibold mb-4 text-indigo-600">Magdagdag ng Anak</h2>
          <form onsubmit="handleAddChild(event)" class="space-y-3">
            <div>
              <label class="block text-sm font-medium mb-1">Pangalan ng Bata</label>
              <input type="text" id="cName" required class="w-full border rounded p-2">
            </div>
            <div class="grid grid-cols-2 gap-2">
              <div>
                <label class="block text-sm font-medium mb-1">Edad</label>
                <input type="number" id="cAge" class="w-full border rounded p-2">
              </div>
              <div>
                <label class="block text-sm font-medium mb-1">Birthdate</label>
                <input type="date" id="cDob" required class="w-full border rounded p-2">
              </div>
            </div>
            <div>
              <label class="block text-sm font-medium mb-1">Address</label>
              <input type="text" id="cAddress" required class="w-full border rounded p-2">
            </div>
            <div>
              <label class="block text-sm font-medium mb-1">Phone Number</label>
              <input type="text" id="cPhone" required class="w-full border rounded p-2">
            </div>
            <button type="submit" class="w-full bg-indigo-600 text-white py-2 rounded hover:bg-indigo-700">Magrehistro ng Anak</button>
          </form>
        </div>

        <div class="bg-white p-6 rounded-xl shadow-md">
          <h2 class="text-lg font-semibold mb-4 text-indigo-600">Mga Anak Mo</h2>
          <div class="space-y-4">
            ${state.children.length === 0 ? '<p class="text-slate-400 text-sm">Wala pang nakatalang anak.</p>' : ''}
            ${state.children.map(c => `
              <div class="border rounded-lg p-4 bg-slate-50 flex flex-col gap-3">
                <div class="flex justify-between items-start">
                  <div>
                    <h3 class="font-bold text-slate-800">${c.name}</h3>
                    <p class="text-xs text-slate-500">Status: <span class="font-semibold ${c.status === 'at_school' ? 'text-emerald-600' : 'text-amber-600'}">${c.status || 'home'}</span></p>
                  </div>
                  <button onclick="openChatModal(${c.id}, '${c.name}')" class="bg-indigo-600 text-white px-3 py-1 rounded text-xs font-semibold hover:bg-indigo-700">Chat sa Admin</button>
                </div>
                <div class="bg-white p-3 rounded border text-center">
                  <p class="text-xs font-semibold text-slate-500 mb-1">QR Code Token (I-pakita sa School)</p>
                  <p class="font-mono text-sm bg-slate-100 p-1 rounded select-all">KIDSCARE:${c.qr_token}</p>
                </div>
              </div>
            `).join('')}
          </div>
        </div>
      </div>

      <div class="bg-white p-6 rounded-xl shadow-md flex flex-col">
        <h2 class="text-lg font-semibold mb-4 text-indigo-600">Photo Gallery</h2>
        <div class="overflow-y-auto flex-grow space-y-4 max-h-[600px]">
          ${state.photos.length === 0 ? '<p class="text-slate-400 text-sm">Wala pang mga larawan.</p>' : ''}
          ${state.photos.map(p => `
            <div class="border rounded-lg overflow-hidden bg-slate-50">
              <img src="${p.url}" alt="Photo" class="w-full h-48 object-cover">
              <div class="p-3">
                <p class="text-xs text-slate-600">${p.caption || 'Walang caption'}</p>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    </main>
    <div id="chatModal"></div>
  `;
}

async function handleAddChild(e) {
  e.preventDefault();
  const body = {
    name: $('#cName').value,
    age: $('#cAge').value,
    dob: $('#cDob').value,
    address: $('#cAddress').value,
    phone: $('#cPhone').value,
    allergies: []
  };
  try {
    await api.req('/children', { method: 'POST', body });
    toast('Matagumpay na naidagdag ang bata!');
    e.target.reset();
    refresh();
  } catch (err) {
    toast(err.message, 'bad');
  }
}

// --- CHAT MODAL (Shared) ---
async function openChatModal(childId, childName) {
  chatCid = childId;
  socket.emit('join', childId);
  try {
    chatMsgs = await api.req('/messages/' + childId);
    renderChatModalWindow(childName);
  } catch (err) {
    toast(err.message, 'bad');
  }
}

function renderChatModalWindow(childName) {
  let modal = $('#chatModal');
  modal.innerHTML = `
    <div class="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
      <div class="bg-white w-full max-w-lg rounded-xl shadow-xl flex flex-col h-[500px]">
        <div class="p-4 border-b flex justify-between items-center bg-indigo-50 rounded-t-xl">
          <h3 class="font-bold text-indigo-700">Chat tungkol kay ${childName}</h3>
          <button onclick="closeChatModal()" class="text-slate-500 hover:text-slate-700 font-bold px-2">✕</button>
        </div>
        <div id="chatMsgsList" class="flex-grow p-4 overflow-y-auto space-y-3 bg-slate-50">
          ${chatMsgs.map(m => `
            <div class="flex flex-col ${m.sender_id === currentUser.id ? 'items-end' : 'items-start'}">
              <span class="text-xs text-slate-500 mb-0.5">${m.sender_name} (${m.sender_role})</span>
              <div class="p-2.5 rounded-lg max-w-[80%] text-sm ${m.sender_id === currentUser.id ? 'bg-indigo-600 text-white rounded-br-none' : 'bg-white border text-slate-800 rounded-bl-none'}">
                ${m.text}
              </div>
            </div>
          `).join('')}
        </div>
        <div class="p-3 border-t bg-white flex gap-2 rounded-b-xl">
          <input type="text" id="ci" placeholder="I-type ang mensahe..." class="flex-grow border rounded p-2 outline-none focus:ring-2 focus:ring-indigo-500 text-sm" onkeydown="if(event.key==='Enter') sendMsg()">
          <button onclick="sendMsg()" class="bg-indigo-600 text-white px-4 py-2 rounded text-sm hover:bg-indigo-700">Ipadala</button>
        </div>
      </div>
    </div>
  `;
  const list = $('#chatMsgsList');
  list.scrollTop = list.scrollHeight;
}

function closeChatModal() {
  chatCid = null;
  $('#chatModal').innerHTML = '';
}

function drawChat() {
  const list = $('#chatMsgsList');
  if (!list) return;
  list.innerHTML = chatMsgs.map(m => `
    <div class="flex flex-col ${m.sender_id === currentUser.id ? 'items-end' : 'items-start'}">
      <span class="text-xs text-slate-500 mb-0.5">${m.sender_name} (${m.sender_role})</span>
      <div class="p-2.5 rounded-lg max-w-[80%] text-sm ${m.sender_id === currentUser.id ? 'bg-indigo-600 text-white rounded-br-none' : 'bg-white border text-slate-800 rounded-bl-none'}">
        ${m.text}
      </div>
    </div>
  `).join('');
  list.scrollTop = list.scrollHeight;
}

async function sendMsg() {
  const i = $('#ci');
  if (!i) return;
  const text = i.value.trim();
  if (!text) return;
  i.value = '';
  try {
    await api.req('/messages/' + chatCid, { method: 'POST', body: { text } });
  } catch (err) {
    toast(err.message, 'bad');
  }
}

// Start application on load
init();