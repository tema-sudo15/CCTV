// ══════════════════════════════════════════
//  CCTV GRID — server.js
// ══════════════════════════════════════════

const express  = require('express');
const { spawn, execSync } = require('child_process');
const path     = require('path');
const fs       = require('fs');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/hls', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Access-Control-Allow-Origin', '*');
    next();
}, express.static(path.join(__dirname, 'hls')));

const HLS_DIR    = path.join(__dirname, 'hls');
const CAMERAS_FILE = path.join(__dirname, 'cameras.json');
const ADMIN_PASS = process.env.ADMIN_PASS || '546546';

[HLS_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

// ── Камеры (JSON файл) ───────────────────
function loadCameras() {
    try {
        if (!fs.existsSync(CAMERAS_FILE)) return [];
        return JSON.parse(fs.readFileSync(CAMERAS_FILE, 'utf8'));
    } catch(e) { return []; }
}
function saveCameras(cams) {
    fs.writeFileSync(CAMERAS_FILE, JSON.stringify(cams, null, 2));
}

// ── FFmpeg ───────────────────────────────
let FFMPEG_OK = false;
let FFMPEG_VERSION = 'не найден';
try {
    FFMPEG_VERSION = execSync('ffmpeg -version 2>&1').toString().split('\n')[0];
    FFMPEG_OK = true;
    console.log('[INIT] FFmpeg OK:', FFMPEG_VERSION);
} catch(e) {
    console.error('[INIT] FFmpeg не найден!');
}

const activeStreams = {};

function cleanHlsDir(streamId) {
    const dir = path.join(HLS_DIR, streamId);
    if (fs.existsSync(dir)) {
        fs.readdirSync(dir).forEach(f => {
            try { fs.unlinkSync(path.join(dir, f)); } catch(e) {}
        });
    } else {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function startSegmentCleanup(streamId) {
    const timer = setInterval(() => {
        if (!activeStreams[streamId]) { clearInterval(timer); return; }
        const dir = path.join(HLS_DIR, streamId);
        if (!fs.existsSync(dir)) return;
        const now = Date.now();
        fs.readdirSync(dir).forEach(f => {
            if (!f.endsWith('.ts')) return;
            try {
                const age = now - fs.statSync(path.join(dir, f)).mtimeMs;
                if (age > 120000) fs.unlinkSync(path.join(dir, f));
            } catch(e) {}
        });
    }, 60000);
    return timer;
}

function buildArgs(rtspUrl, outDir, m3u8Path, mode) {
    const input = [
        '-rtsp_transport', 'tcp',
        '-timeout', '15000000',
        '-analyzeduration', '3000000',
        '-probesize', '3000000',
        '-i', rtspUrl,
    ];
    const video = mode === 'copy' ? ['-c:v', 'copy'] : [
        '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
        '-profile:v', 'high', '-level', '4.1', '-crf', '18',
        '-maxrate', '4000k', '-bufsize', '8000k',
        '-g', '60', '-keyint_min', '60', '-sc_threshold', '0',
    ];
    const audio = ['-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '192k'];
    const hls = [
        '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0',
        '-hls_flags', 'append_list+independent_segments',
        '-hls_allow_cache', '0', '-hls_segment_type', 'mpegts',
        '-hls_segment_filename', path.join(outDir, 'seg%06d.ts'),
        m3u8Path,
    ];
    return [...input, ...video, ...audio, ...hls];
}

function spawnFfmpeg(streamId, rtspUrl, mode) {
    cleanHlsDir(streamId);
    const outDir   = path.join(HLS_DIR, streamId);
    const m3u8Path = path.join(outDir, 'stream.m3u8');
    const proc     = spawn('ffmpeg', buildArgs(rtspUrl, outDir, m3u8Path, mode));
    let log = '';

    proc.stderr.on('data', chunk => {
        const text = chunk.toString();
        log += text;
        if (activeStreams[streamId]) activeStreams[streamId].lastLog = log.slice(-3000);
    });

    proc.on('close', code => {
        const stream = activeStreams[streamId];
        if (!stream) return;

        const copyFailed = mode === 'copy' && code !== 0 && (
            log.includes('Invalid data found') || log.includes('could not find codec') ||
            log.includes('Conversion failed') || log.includes('not supported in')
        );

        if (copyFailed && stream.retries < 1) {
            clearInterval(stream.cleanupTimer);
            delete activeStreams[streamId];
            setTimeout(() => {
                const p = spawnFfmpeg(streamId, rtspUrl, 'transcode');
                activeStreams[streamId] = { process: p, rtspUrl, mode: 'transcode', retries: 1, startedAt: Date.now(), lastLog: '', cleanupTimer: startSegmentCleanup(streamId) };
            }, 500);
        } else if (code !== 0 && code !== null && stream.retries < 3) {
            const retries = stream.retries + 1;
            clearInterval(stream.cleanupTimer);
            delete activeStreams[streamId];
            setTimeout(() => {
                const p = spawnFfmpeg(streamId, rtspUrl, mode);
                activeStreams[streamId] = { process: p, rtspUrl, mode, retries, startedAt: Date.now(), lastLog: '', cleanupTimer: startSegmentCleanup(streamId) };
            }, 3000);
        } else {
            clearInterval(stream.cleanupTimer);
            delete activeStreams[streamId];
        }
    });
    return proc;
}

// ── API камер (публичное) ────────────────
app.get('/api/cameras', (req, res) => {
    const cams = loadCameras().filter(c => c.enabled);
    res.json(cams.map(c => ({ id: c.id, name: c.name })));
});

// ── API камер (админ) ────────────────────
function adminAuth(req, res) {
    const pass = req.headers['x-admin-pass'] || req.body?.adminPass;
    if (pass !== ADMIN_PASS) { res.status(401).json({ error: 'Неверный пароль' }); return false; }
    return true;
}

app.get('/api/admin/cameras', (req, res) => {
    if (!adminAuth(req, res)) return;
    res.json(loadCameras());
});

app.post('/api/admin/cameras', (req, res) => {
    if (!adminAuth(req, res)) return;
    const { name, url } = req.body;
    if (!name || !url) return res.status(400).json({ error: 'Нужны name и url' });
    const cams = loadCameras();
    const cam  = { id: 'cam_' + Date.now(), name, url, enabled: false };
    cams.push(cam);
    saveCameras(cams);
    res.json(cam);
});

app.put('/api/admin/cameras/:id', (req, res) => {
    if (!adminAuth(req, res)) return;
    const cams = loadCameras();
    const idx  = cams.findIndex(c => c.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Не найдено' });
    cams[idx] = { ...cams[idx], ...req.body };
    saveCameras(cams);
    res.json(cams[idx]);
});

app.delete('/api/admin/cameras/:id', (req, res) => {
    if (!adminAuth(req, res)) return;
    let cams = loadCameras();
    cams = cams.filter(c => c.id !== req.params.id);
    saveCameras(cams);
    res.json({ ok: true });
});

app.post('/api/admin/auth', (req, res) => {
    const { pass } = req.body;
    if (pass !== ADMIN_PASS) return res.status(401).json({ error: 'Неверный пароль' });
    res.json({ ok: true });
});

// ── API стримов ──────────────────────────
function makeStreamId(url) {
    return url.replace(/[^a-z0-9]/gi,'_').slice(0,48).toLowerCase();
}

app.post('/api/stream/start', (req, res) => {
    const { camId } = req.body;
    const cams = loadCameras();
    const cam  = cams.find(c => c.id === camId && c.enabled);
    if (!cam) return res.status(404).json({ error: 'Камера не найдена или выключена' });
    if (!FFMPEG_OK) return res.status(500).json({ error: 'FFmpeg не найден' });

    const streamId = makeStreamId(cam.url);
    if (activeStreams[streamId]) {
        activeStreams[streamId].process.kill('SIGKILL');
        clearInterval(activeStreams[streamId].cleanupTimer);
        delete activeStreams[streamId];
    }

    setTimeout(() => {
        const proc  = spawnFfmpeg(streamId, cam.url, 'copy');
        const timer = startSegmentCleanup(streamId);
        activeStreams[streamId] = { process: proc, rtspUrl: cam.url, mode: 'copy', retries: 0, startedAt: Date.now(), lastLog: '', cleanupTimer: timer };
    }, 500);

    res.json({ ok: true, streamId, hlsUrl: `/hls/${streamId}/stream.m3u8` });
});

app.get('/api/stream/status/:streamId', (req, res) => {
    const { streamId } = req.params;
    const stream = activeStreams[streamId];
    if (!stream) return res.json({ active: false });
    const m3u8 = path.join(HLS_DIR, streamId, 'stream.m3u8');
    const exists = fs.existsSync(m3u8);
    const size   = exists ? fs.statSync(m3u8).size : 0;
    const dir    = path.join(HLS_DIR, streamId);
    const segs   = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.ts')).length : 0;
    res.json({ active: true, ready: exists && size > 0 && segs >= 2, mode: stream.mode });
});

app.post('/api/stream/stop', (req, res) => {
    const { streamId } = req.body;
    const stream = activeStreams[streamId];
    if (stream) {
        stream.process.kill('SIGKILL');
        clearInterval(stream.cleanupTimer);
        delete activeStreams[streamId];
    }
    res.json({ ok: true });
});

app.get('/health', (req, res) => res.json({ ok: true, streams: Object.keys(activeStreams).length }));

process.on('SIGTERM', () => {
    Object.values(activeStreams).forEach(s => { s.process.kill('SIGKILL'); clearInterval(s.cleanupTimer); });
    process.exit(0);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[INIT] CCTV Grid сервер на порту ${PORT}`));
