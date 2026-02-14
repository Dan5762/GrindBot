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

const runningProcesses = new Map(); // taskId -> { process } or tmux session name

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

function tmuxSessionExists(sessionName) {
  try {
    execSync(`tmux has-session -t ${sessionName}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

function finishTmuxTask(task, tasks) {
  const logFile = path.join(os.tmpdir(), `grindbot-${task.id}.log`);
  const promptFile = path.join(os.tmpdir(), `grindbot-${task.id}.prompt`);

  let output = '(no output)';
  try {
    output = fs.readFileSync(logFile, 'utf8');
    output = stripAnsi(output);
  } catch {}

  output = output.length > 50000 ? output.slice(-50000) : output;
  task.output = output;

  const questionMatch = output.match(/^\[QUESTION\]:\s*(.+)$/m);
  if (questionMatch) {
    task.status = 'question';
    task.question = questionMatch[1].trim();
  } else {
    task.status = 'review';
    task.question = null;
  }

  task.history = task.history || [];
  task.history.push({ role: 'claude', content: output });
  task.pid = null;
  task.feedback = null;
  task.updatedAt = new Date().toISOString();

  runningProcesses.delete(task.id);

  // Clean up temp files
  try { fs.unlinkSync(logFile); } catch {}
  try { fs.unlinkSync(promptFile); } catch {}
}

function pollTick() {
  const tasks = loadTasks();
  let changed = false;

  for (const task of tasks) {
    if (task.status === 'pending') {
      spawnClaude(task);
      changed = true;
    } else if (task.status === 'running') {
      if (hasTmux && runningProcesses.has(task.id) && runningProcesses.get(task.id).tmux) {
        // tmux mode: check if session still exists
        const sessionName = `grindbot-${task.id}`;
        if (!tmuxSessionExists(sessionName)) {
          finishTmuxTask(task, tasks);
          changed = true;
        }
      } else if (!hasTmux) {
        // Non-tmux mode: process completion handled by spawn callback
        const proc = runningProcesses.get(task.id);
        if (!proc) {
          task.status = 'pending';
          task.pid = null;
          task.updatedAt = new Date().toISOString();
          changed = true;
        }
      } else if (!runningProcesses.has(task.id)) {
        // Server restarted — reset to pending
        task.status = 'pending';
        task.pid = null;
        task.updatedAt = new Date().toISOString();
        changed = true;
      }
    }
  }

  if (changed) saveTasks(tasks);
}

function buildPrompt(task) {
  let prompt = `Task: ${task.title}\n\nDescription: ${task.description}`;

  if (task.history && task.history.length > 0) {
    prompt += '\n\n--- Previous conversation ---';
    for (const entry of task.history) {
      const role = entry.role === 'claude' ? 'Claude' : 'User';
      prompt += `\n\n${role}: ${entry.content}`;
    }
    prompt += '\n\n--- End previous conversation ---';
  }

  if (task.feedback) {
    prompt += `\n\nUser feedback on previous attempt: ${task.feedback}`;
  }

  prompt += '\n\nIMPORTANT: If you need clarification or have a question for the user, start a line with "[QUESTION]:" followed by your question. Otherwise, complete the task.';

  return prompt;
}

function spawnClaudeTmux(task) {
  const config = loadConfig();
  const workDir = path.resolve(config.workingDirectory);
  const prompt = buildPrompt(task);
  const sessionName = `grindbot-${task.id}`;
  const promptFile = path.join(os.tmpdir(), `grindbot-${task.id}.prompt`);
  const logFile = path.join(os.tmpdir(), `grindbot-${task.id}.log`);

  // Write prompt to temp file
  fs.writeFileSync(promptFile, prompt);

  // Ensure no stale log file
  try { fs.unlinkSync(logFile); } catch {}

  try {
    // Start tmux session with claude in interactive mode
    execSync(
      `tmux new-session -d -s ${sessionName} -c ${JSON.stringify(workDir)} -- claude --dangerously-skip-permissions "$(cat ${JSON.stringify(promptFile)})"`,
      { stdio: 'ignore' }
    );

    // Pipe output to log file (output only)
    execSync(
      `tmux pipe-pane -o -t ${sessionName} 'cat >> ${JSON.stringify(logFile)}'`,
      { stdio: 'ignore' }
    );

    runningProcesses.set(task.id, { tmux: true, sessionName });
    task.status = 'running';
    task.pid = null;
    task.updatedAt = new Date().toISOString();
  } catch (err) {
    task.status = 'review';
    task.output = `Error starting tmux session: ${err.message}`;
    task.history = task.history || [];
    task.history.push({ role: 'claude', content: task.output });
    task.updatedAt = new Date().toISOString();
    try { fs.unlinkSync(promptFile); } catch {}
  }
}

function spawnClaudeLegacy(task) {
  const config = loadConfig();
  const workDir = path.resolve(config.workingDirectory);
  const prompt = buildPrompt(task);

  const proc = spawn('claude', ['-p', prompt, '--dangerously-skip-permissions'], {
    cwd: workDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  let stdout = '';
  let stderr = '';

  proc.stdout.on('data', (data) => { stdout += data.toString(); });
  proc.stderr.on('data', (data) => { stderr += data.toString(); });

  proc.on('close', (code) => {
    runningProcesses.delete(task.id);
    const tasks = loadTasks();
    const t = tasks.find(x => x.id === task.id);
    if (!t) return;

    const output = stdout || stderr || (code !== 0 ? `(process exited with code ${code})` : '(no output)');
    t.output = output.length > 50000 ? output.slice(-50000) : output;

    const questionMatch = output.match(/^\[QUESTION\]:\s*(.+)$/m);
    if (questionMatch) {
      t.status = 'question';
      t.question = questionMatch[1].trim();
    } else {
      t.status = 'review';
      t.question = null;
    }

    t.history = t.history || [];
    t.history.push({ role: 'claude', content: output });
    t.pid = null;
    t.feedback = null;
    t.updatedAt = new Date().toISOString();
    saveTasks(tasks);
  });

  proc.on('error', (err) => {
    runningProcesses.delete(task.id);
    const tasks = loadTasks();
    const t = tasks.find(x => x.id === task.id);
    if (!t) return;
    t.status = 'review';
    t.output = `Error spawning claude: ${err.message}`;
    t.history = t.history || [];
    t.history.push({ role: 'claude', content: t.output });
    t.pid = null;
    t.updatedAt = new Date().toISOString();
    saveTasks(tasks);
  });

  runningProcesses.set(task.id, { process: proc });
  task.status = 'running';
  task.pid = proc.pid;
  task.updatedAt = new Date().toISOString();
}

function spawnClaude(task) {
  if (hasTmux) {
    spawnClaudeTmux(task);
  } else {
    spawnClaudeLegacy(task);
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
    question: null,
    feedback: null,
    history: [],
    pid: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  tasks.push(task);
  saveTasks(tasks);
  res.status(201).json(task);
});

app.patch('/api/tasks/:id', (req, res) => {
  const tasks = loadTasks();
  const task = tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'task not found' });

  const { status, feedback, title, description } = req.body;

  // Handle state transitions with validation
  if (status) {
    const validTransitions = {
      'review': ['completed', 'pending'],
      'question': ['pending'],
      'pending': ['pending'],
    };

    const allowed = validTransitions[task.status];
    if (!allowed || !allowed.includes(status)) {
      return res.status(400).json({
        error: `Cannot transition from '${task.status}' to '${status}'`,
      });
    }

    // When rejecting (review → pending) or answering (question → pending), require feedback
    if ((task.status === 'review' || task.status === 'question') && status === 'pending') {
      if (!feedback && !req.body.feedback) {
        return res.status(400).json({ error: 'feedback is required when rejecting or answering' });
      }
      task.feedback = feedback;
      task.history = task.history || [];
      task.history.push({ role: 'user', content: feedback });
    }

    task.status = status;
  }

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
    if (entry.tmux) {
      try { execSync(`tmux kill-session -t grindbot-${req.params.id}`, { stdio: 'ignore' }); } catch {}
      // Clean up temp files
      try { fs.unlinkSync(path.join(os.tmpdir(), `grindbot-${req.params.id}.log`)); } catch {}
      try { fs.unlinkSync(path.join(os.tmpdir(), `grindbot-${req.params.id}.prompt`)); } catch {}
    } else if (entry.process) {
      entry.process.kill();
    }
    runningProcesses.delete(req.params.id);
  }

  tasks.splice(idx, 1);
  saveTasks(tasks);
  res.json({ ok: true });
});

// Open terminal for running task
app.post('/api/tasks/:id/terminal', (req, res) => {
  if (!hasTmux) {
    return res.status(400).json({ error: 'tmux is not available' });
  }

  const tasks = loadTasks();
  const task = tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'task not found' });
  if (task.status !== 'running') return res.status(400).json({ error: 'task is not running' });

  const sessionName = `grindbot-${task.id}`;
  if (!tmuxSessionExists(sessionName)) {
    return res.status(400).json({ error: 'tmux session not found' });
  }

  try {
    execSync(
      `osascript -e 'tell app "Terminal" to do script "tmux attach -t ${sessionName}"'`,
      { stdio: 'ignore' }
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to open terminal: ' + err.message });
  }
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

// --- Start server ---

// --- Graceful shutdown ---

function shutdown() {
  for (const [id, entry] of runningProcesses) {
    if (entry.tmux) {
      try { execSync(`tmux kill-session -t grindbot-${id}`, { stdio: 'ignore' }); } catch {}
    } else if (entry.process) {
      entry.process.kill();
    }
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
