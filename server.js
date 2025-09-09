import express from 'express';
import multer from 'multer';
import path from 'path';
import { execFile } from 'child_process';
import fs from 'fs/promises';
import { existsSync, createWriteStream } from 'fs';
import { nanoid } from 'nanoid';
import { fileURLToPath } from 'url';
import archiver from 'archiver';
import { Worker } from 'worker_threads';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Ensure base directories exist
fs.mkdir(ROOT_UPLOADS, { recursive: true }).catch(()=>{});
fs.mkdir(ROOT_STORAGE, { recursive: true }).catch(()=>{});
fs.mkdir(ROOT_TMP, { recursive: true }).catch(()=>{});

const PORT = process.env.PORT || 3000;

// Root directories (configurable via env)
const ROOT_UPLOADS = process.env.UPLOADS_DIR || path.join(__dirname, 'uploads');
const ROOT_STORAGE = process.env.STORAGE_DIR || path.join(__dirname, 'storage');
const ROOT_TMP = process.env.TMP_DIR || path.join(__dirname, 'tmp');


// Static frontend
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Configure uploads to per-batch temp folders
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const batchId = req.batchId;
    const batchDir = path.join(ROOT_UPLOADS, batchId);
    fs.mkdir(batchDir, { recursive: true }).then(() => cb(null, batchDir)).catch(cb);
  },
  filename: function (req, file, cb) {
    cb(null, file.originalname);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 1024 * 1024 * 200 // 200MB per bestand (pas aan naar wens)
  },
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.dng', '.cr2', '.nef'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true); else cb(new Error('Niet-ondersteund bestandstype: ' + ext));
  }
});

// In-memory batchstatus (kan naar Redis/DB als gewenst)
const batches = new Map();

function createBatch({ mode, dateText, eventText }) {
  const id = nanoid();
  const batch = {
    id,
    mode, // 'edit-watermark' | 'edit-only' | 'watermark-only'
    dateText: dateText || '',
    eventText: eventText || '',
    createdAt: new Date().toISOString(),
    total: 0,
    processed: 0,
    failed: 0,
    status: 'uploading', // 'queued' | 'processing' | 'zipping' | 'done' | 'error'
    files: [], // { name, status: 'queued'|'ok'|'failed', error? }
    outDir: path.join(ROOT_STORAGE, id, 'out'),
    zipPath: path.join(ROOT_STORAGE, `${id}.zip`)
  };
  batches.set(id, batch);
  return batch;
}

// Middleware om batchId te zetten vóór Multer
app.post('/api/upload', (req, res, next) => {
  const { mode, dateText, eventText } = req.query; // eenvoudige query-params via fetch()

  if (!mode || !['edit-watermark','edit-only','watermark-only'].includes(mode)) {
    return res.status(400).json({ error: 'Ongeldige of ontbrekende mode.' });
  }
  if ((mode === 'edit-watermark' || mode === 'watermark-only') && (!dateText || !eventText)) {
    return res.status(400).json({ error: 'Datum en Naam van het evenement zijn verplicht bij watermerk-opties.' });
  }

  const batch = createBatch({ mode, dateText, eventText });
  req.batchId = batch.id;
  res.setHeader('x-batch-id', batch.id);
  next();
}, upload.array('photos', 500), async (req, res) => {
  const batch = batches.get(req.batchId);
  if (!batch) return res.status(500).json({ error: 'Batch niet gevonden.' });

  batch.files = req.files.map(f => ({ name: f.originalname, status: 'queued' }));
  batch.total = batch.files.length;
  batch.status = 'queued';

  // Start achtergrondverwerking
  processBatchInBackground(batch).catch(err => {
    batch.status = 'error';
    batch.error = String(err);
  });

  res.json({ batchId: batch.id, total: batch.total });
});

app.get('/api/status/:id', (req, res) => {
  const batch = batches.get(req.params.id);
  if (!batch) return res.status(404).json({ error: 'Onbekende batch.' });
  res.json({
    id: batch.id,
    status: batch.status,
    processed: batch.processed,
    total: batch.total,
    failed: batch.failed,
    files: batch.files
  });
});

app.get('/api/download/:id', async (req, res) => {
  const batch = batches.get(req.params.id);
  if (!batch) return res.status(404).json({ error: 'Onbekende batch.' });
  if (batch.status !== 'done') return res.status(409).json({ error: 'Batch niet gereed voor download.' });

  const zipPath = batch.zipPath;
  if (!existsSync(zipPath)) return res.status(404).json({ error: 'ZIP niet gevonden.' });

  res.download(zipPath, path.basename(zipPath));
});

app.listen(PORT, () => {
  console.log(`Server draait op http://localhost:${PORT}`);
});

async function processBatchInBackground(batch) {
  batch.status = 'processing';
  const batchRoot = path.join(ROOT_TMP, batch.id);
  const uploadsDir = path.join(ROOT_UPLOADS, batch.id);
  const outDir = batch.outDir;
  await fs.mkdir(outDir, { recursive: true });

  const files = await fs.readdir(uploadsDir);
  const workerCount = Math.min(4, Math.max(1, (os.cpus()?.length || 2) - 1));
  let idx = 0;

  const runNext = () => new Promise(resolve => {
    const runOne = async () => {
      const filename = files[idx++];
      if (!filename) return resolve();
      const inputPath = path.join(uploadsDir, filename);
      const outputPath = path.join(outDir, filename.replace(/\.(dng|cr2|nef)$/i, '.jpg'));

      await runWorker({
        inputPath,
        outputPath,
        mode: batch.mode,
        dateText: batch.dateText,
        eventText: batch.eventText,
        logoPath: path.join(__dirname, 'public', 'logo.png')
      }).then(() => {
        batch.processed++;
        const f = batch.files.find(x => x.name === filename);
        if (f) f.status = 'ok';
      }).catch(err => {
        batch.failed++;
        const f = batch.files.find(x => x.name === filename);
        if (f) { f.status = 'failed'; f.error = String(err); }
      });

      await runOne();
    };
    runOne();
  });

  // Start N parallel workers (simple work-stealing)
  await Promise.all(Array.from({ length: workerCount }, () => runNext()));

  // Controleer of er outputbestanden zijn
  const outFiles = await fs.readdir(outDir).catch(() => []);
  if (!outFiles.length) {
    batch.status = 'error';
    batch.error = 'Er zijn geen bewerkte bestanden geproduceerd (mogelijk faalden alle items).';
    return;
  }

  // ZIP
  batch.status = 'zipping';
  await zipDirectory(outDir, batch.zipPath);
  batch.status = 'done';
  // Optioneel: lijst outputs in status
  batch.files = batch.files.map(f => {
    if (f.status === 'ok') return f;
    return f;
  });
}


// --- RAW helper: convert proprietary RAW to TIFF/JPG using available tool ---
const RAW_EXTS = ['.dng', '.arw', '.cr2', '.cr3', '.nef', '.orf', '.raf', '.rw2', '.srw'];
const RASTER_OK = ['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.webp', '.bmp'];

function runExec(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr?.toString() || err.message));
      resolve(stdout?.toString() || '');
    });
  });
}

async function ensureRasterInput(inputPath) {
  const ext = path.extname(inputPath).toLowerCase();
  if (RASTER_OK.includes(ext)) return inputPath;
  const isRAW = RAW_EXTS.includes(ext);
  if (!isRAW) return inputPath;

  const tmpOutDir = path.join(process.env.TMPDIR || os.tmpdir(), 'raw2tiff');
  await fs.mkdir(tmpOutDir, { recursive: true });
  const base = path.basename(inputPath, ext);
  const outTif = path.join(tmpOutDir, base + '.tif');

  // Try darktable-cli, then rawtherapee-cli, then dcraw_emu
  const attempts = [
    { cmd: 'darktable-cli', args: [inputPath, outTif, '--core', '--disable-opencl'] },
    { cmd: 'rawtherapee-cli', args: ['-Y', '-o', outTif, '-c', inputPath] },
    { cmd: 'dcraw_emu', args: ['-w', '-o', '1', '-T', '-6', '-c', inputPath], post: async(stdout)=>{
        // dcraw_emu with -c writes to stdout; but many builds write file next to input; ensure outTif exists
        if (!existsSync(outTif)) {
          // try common sidecar name in same dir
          const candidate = path.join(path.dirname(inputPath), base + '.tiff');
          if (existsSync(candidate)) await fs.rename(candidate, outTif);
        }
      }
    },
  ];

  for (const a of attempts) {
    try {
      await runExec(a.cmd, a.args);
      if (a.post) await a.post();
      if (existsSync(outTif)) return outTif;
    } catch (e) {
      // continue
      if (process.env.LOG_LEVEL === 'debug') console.warn(`[RAW] ${a.cmd} failed: ${e.message}`);
    }
  }
  throw new Error(`RAW-conversie mislukt voor ${path.basename(inputPath)} — geen bruikbare converter gevonden`);
}


function runWorker(payload) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./worker.js', import.meta.url), { workerData: payload });
    worker.on('message', (msg) => {
      if (msg.type === 'done') resolve();
      if (msg.type === 'error') reject(new Error(msg.error));
    });
    worker.on('error', reject);
    worker.on('exit', (code) => {
      if (code !== 0) reject(new Error(`Worker exited with code ${code}`));
    });
  });
}

function zipDirectory(srcDir, zipPath) {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', resolve);
    archive.on('error', reject);

    archive.pipe(output);
    archive.directory(srcDir, false);
    archive.finalize();
  });
}
