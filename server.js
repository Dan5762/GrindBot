const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

const TASKS_FILE = path.join(__dirname, 'tasks.json');
const CONFIG_FILE = path.join(__dirname, 'config.json');

// --- File-based persistence ---

function loadTasks() {
  if (!fs.existsSync(TASKS_FILE)) return [];
  return JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
}

function saveTasks(tasks) {
  fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2));
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    const defaults = { pollingInterval: 30, workingDirectory: '.' };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(defaults, null, 2));
    return defaults;
  }
  return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// --- Process tracking ---

const runningProcesses = new Map(); // taskId -> { process, stdout, stderr }

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

function pollTick() {
  const tasks = loadTasks();
  let changed = false;

  for (const task of tasks) {
    if (task.status === 'pending') {
      spawnClaude(task);
      changed = true;
    } else if (task.status === 'running') {
      const proc = runningProcesses.get(task.id);
      if (!proc) {
        // Process not tracked (server restarted?) — reset to pending
        task.status = 'pending';
        task.pid = null;
        task.updatedAt = new Date().toISOString();
        changed = true;
      }
      // If process is tracked but still running, skip — completion handled in spawn callback
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

function spawnClaude(task) {
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

    const output = stdout || stderr || '(no output)';
    t.output = output.length > 50000 ? output.slice(-50000) : output;

    // Check for question marker
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

  runningProcesses.set(task.id, { process: proc, stdout: '', stderr: '' });

  // Update task in-place
  task.status = 'running';
  task.pid = proc.pid;
  task.updatedAt = new Date().toISOString();
}

// --- REST API ---

// Serve index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
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

  // Kill running process if any
  const proc = runningProcesses.get(req.params.id);
  if (proc) {
    proc.process.kill();
    runningProcesses.delete(req.params.id);
  }

  tasks.splice(idx, 1);
  saveTasks(tasks);
  res.json({ ok: true });
});

// Config
app.get('/api/config', (req, res) => {
  res.json(loadConfig());
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Grindbot running at http://localhost:${PORT}`);
});
