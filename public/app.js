// ══════════════════════════════════════════
//  CCTV GRID — app.js
// ══════════════════════════════════════════

const ADMIN_PASS_LOCAL = '546546';

// ── Состояние ─────────────────────────────
const state = {
    cameras:    [],      // список доступных камер с сервера
    gridSize:   1,       // 1 | 2 | 4 | 8
    cells:      [],      // [{camId, streamId, hlsUrl, hls, pollTimer, status}]
    activeCell: 0,       // индекс выбранной ячейки
    adminAuthed: false,
};

// ── Утилиты ───────────────────────────────
const $  = id => document.getElementById(id);
const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

function pad(n) { return String(n).padStart(2,'0'); }

// ── Часы ──────────────────────────────────
function updateClock() {
    const n = new Date();
    $('topbarTime').textContent = `${pad(n.getHours())}:${pad(n.getMinutes())}:${pad(n.getSeconds())}`;
    const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
    $('topbarDate').textContent = `${pad(n.getDate())} ${months[n.getMonth()]} ${n.getFullYear()}`;
}
updateClock();
setInterval(updateClock, 1000);

// ── Статус ────────────────────────────────
function setStatus(text, online = false) {
    $('statusText').textContent = text;
    $('statusDot').className = 'status-dot ' + (online ? 'online' : 'offline');
}

// ── Загрузка камер ────────────────────────
async function loadCameras() {
    setStatus('ЗАГРУЗКА...', false);
    try {
        const r    = await fetch('/api/cameras');
        const data = await r.json();
        state.cameras = data;
        renderCamPanel();
        setStatus(data.length > 0 ? `${data.length} КАМ. ОНЛАЙН` : 'НЕТ КАМЕР', data.length > 0);
    } catch(e) {
        setStatus('ОШИБКА СЕРВЕРА', false);
    }
}

// ── Сетка ─────────────────────────────────
function setGrid(size) {
    state.gridSize = size;
    state.cells    = [];

    // Кнопки
    document.querySelectorAll('.grid-btn').forEach(b => {
        b.classList.toggle('active', parseInt(b.dataset.grid) === size);
    });

    // Останавливаем все активные стримы
    stopAllStreams();

    // Строим ячейки
    const grid = $('gridMain');
    grid.className = `grid-main grid-${size}`;
    grid.innerHTML = '';

    for (let i = 0; i < size; i++) {
        state.cells.push({ camId: null, streamId: null, hlsUrl: null, hls: null, pollTimer: null, status: 'empty' });
        grid.appendChild(buildCell(i));
    }

    // Активная ячейка
    state.activeCell = 0;
    highlightCell(0);
}

function buildCell(idx) {
    const cell = document.createElement('div');
    cell.className = 'cam-cell';
    cell.id = `cell-${idx}`;
    cell.onclick = () => selectCell(idx);
    cell.innerHTML = `
        <div class="cam-cell-corner-br"></div>
        <div class="cam-cell-num">${String(idx+1).padStart(2,'0')}</div>
        <video id="video-${idx}" muted playsinline></video>

        <div class="cam-overlay" id="overlay-${idx}">
            <div class="cam-spinner"></div>
            <div class="cam-overlay-text" id="overlayText-${idx}">ОЖИДАНИЕ</div>
        </div>

        <div class="cam-error hidden" id="error-${idx}">
            <div class="cam-error-icon">⚠</div>
            <div class="cam-error-title">СИГНАЛ ПОТЕРЯН</div>
            <div class="cam-error-msg" id="errorMsg-${idx}">Не удалось подключиться к камере</div>
            <button class="cam-retry-btn" onclick="retryCell(${idx}, event)">↺ ПЕРЕПОДКЛЮЧИТЬ</button>
        </div>

        <div class="cam-empty" id="empty-${idx}">
            <div class="cam-empty-icon">⬡</div>
            <div class="cam-empty-text">ВЫБЕРИТЕ КАМЕРУ</div>
        </div>

        <div class="cam-label hidden" id="label-${idx}">
            <span class="cam-label-name" id="labelName-${idx}"></span>
            <span class="cam-label-live">LIVE</span>
        </div>
    `;
    return cell;
}

function selectCell(idx) {
    state.activeCell = idx;
    highlightCell(idx);
}

function highlightCell(idx) {
    document.querySelectorAll('.cam-cell').forEach((c, i) => {
        c.classList.toggle('active', i === idx);
    });
}

// ── Панель камер ──────────────────────────
function renderCamPanel() {
    const panel = $('camPanelInner');
    panel.innerHTML = '';

    if (state.cameras.length === 0) {
        panel.innerHTML = '<div class="cam-panel-empty">НЕТ ДОСТУПНЫХ КАМЕР</div>';
        return;
    }

    state.cameras.forEach(cam => {
        const inUse = state.cells.some(c => c.camId === cam.id);
        const btn   = document.createElement('div');
        btn.className = 'cam-thumb' + (inUse ? ' in-use' : '');
        btn.id = `thumb-${cam.id}`;
        btn.innerHTML = `
            <div class="cam-thumb-name">${esc(cam.name)}</div>
            <div class="cam-thumb-status">${inUse ? '● АКТИВНА' : '○ ГОТОВА'}</div>
        `;
        btn.onclick = () => assignCamera(cam);
        panel.appendChild(btn);
    });
}

// ── Назначить камеру в активную ячейку ───
async function assignCamera(cam) {
    const idx = state.activeCell;

    // Если в ячейке уже что-то есть — останавливаем
    stopCell(idx);

    // Обновляем состояние
    state.cells[idx].camId  = cam.id;
    state.cells[idx].status = 'loading';

    // UI
    showCellState(idx, 'loading', 'ПОДКЛЮЧЕНИЕ...');

    try {
        const r    = await fetch('/api/stream/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ camId: cam.id }),
        });
        const data = await r.json();
        if (!data.ok) throw new Error(data.error || 'Ошибка сервера');

        state.cells[idx].streamId = data.streamId;
        state.cells[idx].hlsUrl   = data.hlsUrl;

        // Показываем имя камеры
        $(`labelName-${idx}`).textContent = cam.name;

        // Ждём готовности
        waitCellReady(idx, data.streamId, data.hlsUrl, cam.name);

    } catch(e) {
        showCellState(idx, 'error', e.message);
        state.cells[idx].status = 'error';
    }

    renderCamPanel();
}

function waitCellReady(idx, streamId, hlsUrl, camName) {
    let attempts = 0;
    clearInterval(state.cells[idx].pollTimer);

    const check = async () => {
        attempts++;
        $(`overlayText-${idx}`).textContent = `ЗАПУСК... ${attempts}/90`;

        try {
            const r    = await fetch(`/api/stream/status/${streamId}`);
            const data = await r.json();

            if (data.ready) {
                clearInterval(state.cells[idx].pollTimer);
                initCellHls(idx, hlsUrl, camName);
                return;
            }
            if (data.mode === 'transcode') {
                $(`overlayText-${idx}`).textContent = `ПЕРЕКОДИРОВАНИЕ... ${attempts}/90`;
            }
        } catch(e) {}

        if (attempts >= 90) {
            clearInterval(state.cells[idx].pollTimer);
            showCellState(idx, 'error', 'Таймаут подключения');
        }
    };

    state.cells[idx].pollTimer = setInterval(check, 500);
    check();
}

function initCellHls(idx, hlsUrl, camName) {
    const video = $(`video-${idx}`);
    if (!video) return;

    // Уничтожаем старый HLS
    if (state.cells[idx].hls) {
        state.cells[idx].hls.destroy();
        state.cells[idx].hls = null;
    }

    if (Hls.isSupported()) {
        const hls = new Hls({
            liveSyncDurationCount: 3, liveMaxLatencyDurationCount: 8,
            liveDurationInfinity: true, maxBufferLength: 30,
            maxBufferHole: 1.0, lowLatencyMode: false,
            startFragPrefetch: true, enableWorker: true,
            fragLoadingMaxRetry: 10, manifestLoadingMaxRetry: 5,
        });
        state.cells[idx].hls = hls;
        hls.loadSource(hlsUrl);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
            video.play().catch(() => {});
            showCellState(idx, 'live', camName);
        });
        hls.on(Hls.Events.ERROR, (e, data) => {
            if (data.fatal) {
                if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
                else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
                else showCellState(idx, 'error', data.details);
            }
        });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = hlsUrl;
        video.addEventListener('loadedmetadata', () => {
            video.play();
            showCellState(idx, 'live', camName);
        });
    } else {
        showCellState(idx, 'error', 'Браузер не поддерживается');
    }

    video.onplaying = () => showCellState(idx, 'live', camName);
}

function showCellState(idx, state_name, text) {
    const overlay = $(`overlay-${idx}`);
    const error   = $(`error-${idx}`);
    const empty   = $(`empty-${idx}`);
    const label   = $(`label-${idx}`);

    // Скрываем всё
    overlay.classList.add('hidden');
    error.classList.add('hidden');
    empty.classList.add('hidden');
    label.classList.add('hidden');

    if (state_name === 'empty') {
        empty.classList.remove('hidden');
    } else if (state_name === 'loading') {
        overlay.classList.remove('hidden');
        $(`overlayText-${idx}`).textContent = text || 'ЗАГРУЗКА...';
    } else if (state_name === 'error') {
        error.classList.remove('hidden');
        $(`errorMsg-${idx}`).textContent = text || 'Ошибка подключения';
    } else if (state_name === 'live') {
        label.classList.remove('hidden');
        if (text) $(`labelName-${idx}`).textContent = text;
    }
}

function retryCell(idx, e) {
    e.stopPropagation();
    const camId = state.cells[idx].camId;
    const cam   = state.cameras.find(c => c.id === camId);
    if (cam) assignCamera(cam);
}

// ── Остановка стримов ─────────────────────
function stopCell(idx) {
    const cell = state.cells[idx];
    if (!cell) return;

    clearInterval(cell.pollTimer);

    if (cell.hls) { cell.hls.destroy(); cell.hls = null; }

    const video = $(`video-${idx}`);
    if (video) video.src = '';

    if (cell.streamId) {
        fetch('/api/stream/stop', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ streamId: cell.streamId }),
        }).catch(() => {});
    }

    state.cells[idx] = { camId: null, streamId: null, hlsUrl: null, hls: null, pollTimer: null, status: 'empty' };
    showCellState(idx, 'empty');
}

function stopAllStreams() {
    state.cells.forEach((_, i) => stopCell(i));
}

// ── Кнопки сетки ─────────────────────────
document.querySelectorAll('.grid-btn').forEach(btn => {
    btn.onclick = () => setGrid(parseInt(btn.dataset.grid));
});

// ── АДМИН ПАНЕЛЬ ──────────────────────────
let dragCamId = null;

// Открыть по клавише Q
document.addEventListener('keydown', e => {
    if (e.key === 'q' || e.key === 'Q') {
        if (document.activeElement.tagName === 'INPUT') return;
        openAdmin();
    }
    if (e.key === 'Escape') closeAdmin();
});

function openAdmin() {
    $('adminOverlay').classList.remove('hidden');
    if (!state.adminAuthed) {
        $('adminAuthScreen').classList.remove('hidden');
        $('adminMainScreen').classList.add('hidden');
        setTimeout(() => $('adminPassInput').focus(), 100);
    } else {
        loadAdminCameras();
    }
}

function closeAdmin() {
    $('adminOverlay').classList.add('hidden');
    $('adminPassInput').value = '';
    $('adminAuthError').textContent = '';
}

$('adminClose').onclick  = closeAdmin;
$('adminOverlay').onclick = e => { if (e.target === $('adminOverlay')) closeAdmin(); };

// Авторизация
$('adminPassBtn').onclick = checkAdminPass;
$('adminPassInput').onkeydown = e => { if (e.key === 'Enter') checkAdminPass(); };

async function checkAdminPass() {
    const pass = $('adminPassInput').value;
    try {
        const r = await fetch('/api/admin/auth', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pass }),
        });
        const data = await r.json();
        if (!data.ok) {
            $('adminAuthError').textContent = '// ДОСТУП ЗАПРЕЩЁН';
            $('adminPassInput').value = '';
            $('adminPassInput').focus();
            return;
        }
        state.adminAuthed = true;
        state.adminPass   = pass;
        $('adminAuthScreen').classList.add('hidden');
        $('adminMainScreen').classList.remove('hidden');
        loadAdminCameras();
    } catch(e) {
        $('adminAuthError').textContent = 'ОШИБКА СЕРВЕРА';
    }
}

// Добавить камеру
$('adminAddBtn').onclick = addAdminCamera;
$('adminCamUrl').onkeydown = e => { if (e.key === 'Enter') addAdminCamera(); };

async function addAdminCamera() {
    const name = $('adminCamName').value.trim();
    const url  = $('adminCamUrl').value.trim();
    $('adminAddError').textContent = '';

    if (!name) { $('adminAddError').textContent = 'Введи название'; return; }
    if (!url)  { $('adminAddError').textContent = 'Введи RTSP ссылку'; return; }

    try {
        const r = await fetch('/api/admin/cameras', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-admin-pass': state.adminPass },
            body: JSON.stringify({ name, url }),
        });
        const data = await r.json();
        if (!data.id) throw new Error(data.error || 'Ошибка');
        $('adminCamName').value = '';
        $('adminCamUrl').value  = '';
        loadAdminCameras();
        loadCameras(); // обновляем публичный список
    } catch(e) {
        $('adminAddError').textContent = e.message;
    }
}

// Загрузить все камеры в админку
async function loadAdminCameras() {
    try {
        const r    = await fetch('/api/admin/cameras', { headers: { 'x-admin-pass': state.adminPass } });
        const cams = await r.json();
        renderAdminColumns(cams);
    } catch(e) {}
}

function renderAdminColumns(cams) {
    const disabled = cams.filter(c => !c.enabled);
    const enabled  = cams.filter(c =>  c.enabled);

    $('countDisabled').textContent = disabled.length;
    $('countEnabled').textContent  = enabled.length;

    renderAdminList('listDisabled', disabled, false);
    renderAdminList('listEnabled',  enabled,  true);
}

function renderAdminList(containerId, cams, isEnabled) {
    const container = $(containerId);
    container.innerHTML = '';

    if (cams.length === 0) {
        container.innerHTML = '<div class="col-empty">Перетащи камеру сюда</div>';
        return;
    }

    cams.forEach(cam => {
        const card = document.createElement('div');
        card.className = 'admin-cam-card' + (isEnabled ? ' enabled' : '');
        card.draggable = true;
        card.dataset.camId = cam.id;
        card.innerHTML = `
            <span class="drag-handle">⠿</span>
            <div class="admin-cam-info">
                <div class="admin-cam-name">${esc(cam.name)}</div>
                <div class="admin-cam-url">${esc(cam.url)}</div>
            </div>
            <button class="admin-cam-del" data-id="${cam.id}" title="Удалить">×</button>
        `;

        card.addEventListener('dragstart', e => {
            dragCamId = cam.id;
            setTimeout(() => card.classList.add('dragging'), 0);
            e.dataTransfer.setData('camId', cam.id);
        });
        card.addEventListener('dragend', () => card.classList.remove('dragging'));

        card.querySelector('.admin-cam-del').onclick = async e => {
            e.stopPropagation();
            if (!confirm(`Удалить камеру "${cam.name}"?`)) return;
            await fetch(`/api/admin/cameras/${cam.id}`, {
                method: 'DELETE',
                headers: { 'x-admin-pass': state.adminPass },
            });
            loadAdminCameras();
            loadCameras();
        };

        container.appendChild(card);
    });
}

// Drag & Drop
function adminDragOver(e) {
    e.preventDefault();
    e.currentTarget.classList.add('drag-over');
}
function adminDragLeave(e) {
    e.currentTarget.classList.remove('drag-over');
}
async function adminDrop(e, enable) {
    e.preventDefault();
    e.currentTarget.classList.remove('drag-over');
    const camId = e.dataTransfer.getData('camId') || dragCamId;
    if (!camId) return;

    await fetch(`/api/admin/cameras/${camId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-admin-pass': state.adminPass },
        body: JSON.stringify({ enabled: enable }),
    });

    loadAdminCameras();
    loadCameras();
    dragCamId = null;
}

// ── Инициализация ─────────────────────────
setGrid(1);
loadCameras();
