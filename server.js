const express = require('express');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

const TASKS_FILE = path.join(__dirname, 'tasks.json');
const CONFIG_FILE = path.join(__dirname, 'config.json');

// --- SSE client tracking ---

const sseClients = new Set();

function broadcast() {
  const data = JSON.stringify(loadTasks());
  for (const res of sseClients) {
    try {
      res.write(`data: ${data}\n\n`);
    } catch {
      sseClients.delete(res);
    }
  }
}

// --- File-based persistence ---

function loadTasks() {
  if (!fs.existsSync(TASKS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8')); }
  catch { return []; }
}

function saveTasks(tasks) {
  fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2));
  broadcast();
}

function loadConfig() {
  const defaults = { pollingInterval: 30, workingDirectory: '.' };
  if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(defaults, null, 2));
    return defaults;
  }
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch { return defaults; }
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// --- tmux detection ---

let hasTmux = false;
try {
  execSync('which tmux', { stdio: 'ignore' });
  hasTmux = true;
} catch {
  console.warn('WARNING: tmux not found. Falling back to non-interactive mode. Install with: brew install tmux');
}

// --- Process tracking ---

const runningProcesses = new Map(); // taskId -> TmuxSession or ChildProcess

// --- Polling engine ---

let pollingTimer = null;
let pollingRunning = false;

function startPolling() {
  if (pollingRunning) return;
  pollingRunning = true;
  const config = loadConfig();
  pollTick();
  pollingTimer = setInterval(pollTick, config.pollingInterval * 1000);
}

function stopPolling() {
  pollingRunning = false;
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
  }
}

function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return str
    .replace(/\x1b\[[0-9;?]*[a-zA-Z<>=~]/g, '')  // CSI sequences (incl. ?-prefixed private modes)
    .replace(/\x1b\][^\x07]*\x07/g, '')            // OSC sequences
    .replace(/\x1b[()][0-9A-Z]/g, '')              // Character set selection
    .replace(/\r/g, '');                            // Carriage returns
}

// Shared completion logic — both tmux and legacy paths call this
function finishTask(taskId, rawOutput) {
  const tasks = loadTasks();
  const task = tasks.find(t => t.id === taskId);
  if (!task || task.status !== 'running') return;

  let output = rawOutput || '(no output)';
  output = stripAnsi(output);
  output = output.length > 50000 ? output.slice(-50000) : output;
  task.output = output;

  task.status = 'completed';
  task.pid = null;
  task.updatedAt = new Date().toISOString();

  saveTasks(tasks);
}

// --- TmuxSession: manages one claude instance in a tmux session ---
//
// Claude runs with -p (pipe mode) so it processes the prompt and exits.
// Detection: poll `tmux has-session` every 3 seconds. When claude exits,
// the session is destroyed and the poll detects it.
//
// The launcher uses `exec` so claude replaces the shell — when it exits,
// the session dies immediately. CLAUDECODE is unset so claude doesn't
// refuse to start if the server was launched from inside Claude Code.

class TmuxSession {
  constructor(taskId) {
    this.taskId = taskId;
    this.sessionName = `grindbot-${taskId}`;
    this.promptFile = path.join(os.tmpdir(), `grindbot-${taskId}.prompt`);
    this.logFile = path.join(os.tmpdir(), `grindbot-${taskId}.log`);
    this.launcherFile = path.join(os.tmpdir(), `grindbot-${taskId}.sh`);
    this._pollTimer = null;
  }

  start(prompt, workDir) {
    fs.writeFileSync(this.promptFile, prompt);
    try { fs.unlinkSync(this.logFile); } catch {}

    fs.writeFileSync(this.launcherFile, [
      '#!/bin/bash',
      'unset CLAUDECODE',
      `exec claude -p --dangerously-skip-permissions "$(cat '${this.promptFile}')"`,
    ].join('\n'));
    fs.chmodSync(this.launcherFile, 0o755);

    execSync(
      `tmux new-session -d -s ${this.sessionName} -c '${workDir}' '${this.launcherFile}'`,
      { stdio: 'ignore' }
    );
    execSync(
      `tmux pipe-pane -o -t ${this.sessionName} 'cat >> ${this.logFile}'`,
      { stdio: 'ignore' }
    );

    this._startMonitor();
  }

  // Re-attach monitoring to a session that survived a server restart
  reattach() {
    this._startMonitor();
  }

  _startMonitor() {
    this._pollTimer = setInterval(() => {
      if (!this.exists) {
        this._stopMonitor();
        finishTask(this.taskId, this._readLog());
        this._cleanupFiles();
        runningProcesses.delete(this.taskId);
      }
    }, 3000);
  }

  _stopMonitor() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  _readLog() {
    try { return fs.readFileSync(this.logFile, 'utf8'); }
    catch { return ''; }
  }

  get exists() {
    try {
      execSync(`tmux has-session -t ${this.sessionName}`, { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  kill() {
    this._stopMonitor();
    try { execSync(`tmux kill-session -t ${this.sessionName}`, { stdio: 'ignore' }); } catch {}
    this._cleanupFiles();
    runningProcesses.delete(this.taskId);
  }

  _cleanupFiles() {
    try { fs.unlinkSync(this.logFile); } catch {}
    try { fs.unlinkSync(this.promptFile); } catch {}
    try { fs.unlinkSync(this.launcherFile); } catch {}
  }
}

function pollTick() {
  const tasks = loadTasks();
  let changed = false;

  for (const task of tasks) {
    if (task.status === 'pending') {
      spawnClaude(task);
      changed = true;
    } else if (task.status === 'running') {
      const entry = runningProcesses.get(task.id);

      if (!entry) {
        // Server restarted — check if the tmux session survived
        if (hasTmux) {
          const session = new TmuxSession(task.id);
          if (session.exists) {
            // Session is still alive, re-attach monitoring
            session.reattach();
            runningProcesses.set(task.id, session);
          } else {
            // Session is gone — claude finished while server was down
            task.status = 'completed';
            task.output = task.output || '(session ended while server was down)';
            task.pid = null;
            task.updatedAt = new Date().toISOString();
            changed = true;
          }
        } else {
          // Legacy mode: no way to recover, reset to pending
          task.status = 'pending';
          task.pid = null;
          task.updatedAt = new Date().toISOString();
          changed = true;
        }
      }
    }
  }

  if (changed) saveTasks(tasks);
}

function buildPrompt(task) {
  return `Task: ${task.title}\n\nDescription: ${task.description}`;
}

function spawnClaude(task) {
  const config = loadConfig();
  const workDir = path.resolve(config.workingDirectory);
  const prompt = buildPrompt(task);

  if (hasTmux) {
    const session = new TmuxSession(task.id);
    try {
      session.start(prompt, workDir);
      runningProcesses.set(task.id, session);
      task.status = 'running';
      task.pid = null;
      task.updatedAt = new Date().toISOString();
    } catch (err) {
      session.kill();
      task.status = 'completed';
      task.output = `Error starting tmux session: ${err.message}`;
      task.updatedAt = new Date().toISOString();
    }
  } else {
    const proc = spawn('claude', ['-p', prompt, '--dangerously-skip-permissions'], {
      cwd: workDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CLAUDECODE: undefined },
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      runningProcesses.delete(task.id);
      const output = stdout || stderr || (code !== 0 ? `(process exited with code ${code})` : '(no output)');
      finishTask(task.id, output);
    });

    proc.on('error', (err) => {
      runningProcesses.delete(task.id);
      finishTask(task.id, `Error spawning claude: ${err.message}`);
    });

    runningProcesses.set(task.id, proc);
    task.status = 'running';
    task.pid = proc.pid;
    task.updatedAt = new Date().toISOString();
  }
}

// --- REST API ---

// Serve index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// SSE endpoint
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  // Send current state immediately on connect
  res.write(`data: ${JSON.stringify(loadTasks())}\n\n`);
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// Tasks CRUD
app.get('/api/tasks', (req, res) => {
  res.json(loadTasks());
});

app.post('/api/tasks', (req, res) => {
  const { title, description } = req.body;
  if (!title) return res.status(400).json({ error: 'title is required' });

  const tasks = loadTasks();
  const task = {
    id: uuidv4().slice(0, 8),
    title,
    description: description || '',
    status: 'pending',
    output: null,
    pid: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  tasks.push(task);
  saveTasks(tasks);
  process.nextTick(pollTick);
  res.status(201).json(task);
});

app.patch('/api/tasks/:id', (req, res) => {
  const tasks = loadTasks();
  const task = tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'task not found' });

  const { title, description } = req.body;
  if (title !== undefined) task.title = title;
  if (description !== undefined) task.description = description;
  task.updatedAt = new Date().toISOString();

  saveTasks(tasks);
  res.json(task);
});

app.delete('/api/tasks/:id', (req, res) => {
  let tasks = loadTasks();
  const idx = tasks.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'task not found' });

  // Kill running process/session
  const entry = runningProcesses.get(req.params.id);
  if (entry) {
    entry.kill();
    runningProcesses.delete(req.params.id);
  }

  tasks.splice(idx, 1);
  saveTasks(tasks);
  res.json({ ok: true });
});

// Stop a running task (kills session, marks completed)
app.post('/api/tasks/:id/stop', (req, res) => {
  const tasks = loadTasks();
  const task = tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'task not found' });
  if (task.status !== 'running') return res.status(400).json({ error: 'task is not running' });

  const entry = runningProcesses.get(task.id);
  let output = '(stopped by user)';
  if (entry) {
    if (entry instanceof TmuxSession) {
      const log = stripAnsi(entry._readLog());
      if (log) output = log;
    }
    entry.kill();
  }

  task.status = 'completed';
  if (output.length > 50000) output = output.slice(-50000);
  task.output = output;
  task.pid = null;
  task.updatedAt = new Date().toISOString();
  saveTasks(tasks);

  res.json(task);
});

// Open terminal for running task
app.post('/api/tasks/:id/terminal', (req, res) => {
  if (!hasTmux) {
    return res.status(400).json({ error: 'tmux is not available' });
  }

  const tasks = loadTasks();
  const task = tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'task not found' });

  const entry = runningProcesses.get(task.id);
  if (!(entry instanceof TmuxSession) || !entry.exists) {
    return res.status(400).json({ error: 'tmux session not found' });
  }

  try {
    execSync(
      `osascript -e 'tell app "Terminal" to do script "tmux attach -t ${entry.sessionName}"'`,
      { stdio: 'ignore' }
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to open terminal: ' + err.message });
  }
});

// Live output for running tasks (reads tmux log)
app.get('/api/tasks/:id/output', (req, res) => {
  const tasks = loadTasks();
  const task = tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'task not found' });

  if (task.status === 'running') {
    const session = runningProcesses.get(task.id);
    if (session instanceof TmuxSession) {
      let log = session._readLog();
      log = stripAnsi(log);
      if (log.length > 50000) log = log.slice(-50000);
      return res.json({ output: log || '(waiting for output...)' });
    }
  }

  res.json({ output: task.output || '(no output)' });
});

// Config
app.get('/api/config', (req, res) => {
  res.json({ ...loadConfig(), hasTmux });
});

app.patch('/api/config', (req, res) => {
  const config = loadConfig();
  const { pollingInterval, workingDirectory } = req.body;
  if (pollingInterval !== undefined) config.pollingInterval = Number(pollingInterval);
  if (workingDirectory !== undefined) config.workingDirectory = workingDirectory;
  saveConfig(config);

  // Restart polling with new interval if running
  if (pollingRunning) {
    stopPolling();
    startPolling();
  }

  res.json(config);
});

// Polling controls
app.post('/api/polling/start', (req, res) => {
  startPolling();
  res.json({ polling: true });
});

app.post('/api/polling/stop', (req, res) => {
  stopPolling();
  res.json({ polling: false });
});

app.get('/api/polling/status', (req, res) => {
  res.json({ polling: pollingRunning });
});

// --- Graceful shutdown ---

function shutdown() {
  for (const [, entry] of runningProcesses) {
    entry.kill();
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// --- Start server ---

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Grindbot running at http://localhost:${PORT}`);
  console.log(`tmux: ${hasTmux ? 'available (interactive mode)' : 'not found (non-interactive fallback)'}`);
  startPolling();
});
