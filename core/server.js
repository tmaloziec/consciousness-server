#!/usr/bin/env node
/**
 * Consciousness Server (Memory Server) - MVP
 * Central awareness point for Ecosystem ecosystem
 *
 * Consciousness Server
 * Date: 2025-12-30
 * Version: 0.1.0 MVP (in-memory)
 */

const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const redis = require('redis');
const http = require('http');
const { WebSocketServer } = require('ws');

const app = express();
const PORT = process.env.PORT || 3032;

// ============================================================================
// FSM STATES (ECOSYSTEM-ARCHITECTURE.md §1e)
// ============================================================================
// 6 states: OFFLINE → STARTING → IDLE ↔ BUSY ↔ BLOCKED, BUSY → ERROR → IDLE.
// Agents self-report via POST /api/agents/:name/heartbeat {status, ...}.
// Server validates the state value; it does not enforce transition paths.
const FSM_STATES = ['OFFLINE', 'STARTING', 'IDLE', 'BUSY', 'BLOCKED', 'ERROR'];
const FSM_LEGACY_MAP = { FREE: 'IDLE' };  // backward compat, pre-FSM clients
const HEARTBEAT_OFFLINE_THRESHOLD_SEC = 120;  // arch doc §1e

function normalizeFsmState(status) {
  if (status === null || status === undefined) return null;
  const upper = String(status).toUpperCase();
  return FSM_LEGACY_MAP[upper] || upper;
}

function isValidFsmState(status) {
  return FSM_STATES.includes(status);
}

// ============================================================================
// REDIS CONNECTION
// ============================================================================

const redisClient = redis.createClient({
  socket: {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT || '6379', 10)
  }
});

redisClient.on('error', (err) => console.error('Redis error:', err));
redisClient.on('connect', () => console.log('✅ Redis connected'));

// Connect to Redis and load data
(async () => {
  await redisClient.connect();
  console.log('🔄 Loading data from Redis...');
  await loadFromRedis();
  await loadChatFromRedis();
  await loadNotesFromRedis();
  await loadConversationsFromRedis();
  await loadTrainingDataFromRedis();
  await loadSummariesFromRedis();
})();

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Request logging middleware
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.path}`);
  next();
});


// ============================================================================
// RATE LIMITING (2026-01-14)
// Prevents runaway agents (infinite loops, excessive API calls)
// ============================================================================

const RATE_LIMITS = {
  max_requests_per_minute: 60,      // per agent
  max_tasks_per_hour: 100,          // per agent
  max_chat_messages_per_minute: 30, // per agent
  max_consecutive_errors: 5,        // auto-pause agent after errors
  task_timeout_minutes: 30          // max task duration
};

// In-memory rate limit tracking
const rateLimitCounters = new Map();

function getRateLimitCounter(agentName) {
  if (!rateLimitCounters.has(agentName)) {
    rateLimitCounters.set(agentName, {
      requests: [],
      tasks: [],
      chatMessages: [],
      errors: 0,
      paused: false,
      pausedAt: null,
      pauseReason: null
    });
  }
  return rateLimitCounters.get(agentName);
}

function cleanOldTimestamps(timestamps, maxAgeMs) {
  const cutoff = Date.now() - maxAgeMs;
  return timestamps.filter(ts => ts > cutoff);
}

function checkRateLimit(agentName, limitType) {
  if (!agentName || agentName === 'unknown') return null;
  
  const counter = getRateLimitCounter(agentName);
  const now = Date.now();
  
  if (counter.paused) {
    const pausedSecondsAgo = Math.floor((now - counter.pausedAt) / 1000);
    if (pausedSecondsAgo > 300) {
      counter.paused = false;
      counter.pausedAt = null;
      counter.pauseReason = null;
      counter.errors = 0;
    } else {
      return {
        error: 'rate_limit_exceeded',
        limit_type: 'agent_paused',
        reason: counter.pauseReason,
        retry_after_seconds: 300 - pausedSecondsAgo
      };
    }
  }
  
  counter.requests = cleanOldTimestamps(counter.requests, 60000);
  counter.tasks = cleanOldTimestamps(counter.tasks, 3600000);
  counter.chatMessages = cleanOldTimestamps(counter.chatMessages, 60000);
  
  let limit, current, timeWindowSec;
  
  switch(limitType) {
    case 'requests':
      limit = RATE_LIMITS.max_requests_per_minute;
      current = counter.requests.length;
      timeWindowSec = 60;
      break;
    case 'tasks':
      limit = RATE_LIMITS.max_tasks_per_hour;
      current = counter.tasks.length;
      timeWindowSec = 3600;
      break;
    case 'chatMessages':
      limit = RATE_LIMITS.max_chat_messages_per_minute;
      current = counter.chatMessages.length;
      timeWindowSec = 60;
      break;
    default:
      return null;
  }
  
  if (current >= limit) {
    const oldest = counter[limitType === 'chatMessages' ? 'chatMessages' : limitType][0];
    const expiresIn = oldest ? Math.ceil((oldest + (timeWindowSec * 1000) - now) / 1000) : timeWindowSec;
    
    return {
      error: 'rate_limit_exceeded',
      limit_type: limitType === 'requests' ? 'max_requests_per_minute' :
                  limitType === 'tasks' ? 'max_tasks_per_hour' :
                  'max_chat_messages_per_minute',
      current: current,
      limit: limit,
      retry_after_seconds: Math.max(1, expiresIn)
    };
  }
  
  return null;
}

function recordRateLimitAction(agentName, actionType) {
  if (!agentName || agentName === 'unknown') return;
  
  const counter = getRateLimitCounter(agentName);
  const now = Date.now();
  
  switch(actionType) {
    case 'requests':
      counter.requests.push(now);
      break;
    case 'tasks':
      counter.tasks.push(now);
      break;
    case 'chatMessages':
      counter.chatMessages.push(now);
      break;
  }
  
  counter.errors = 0;
}

function recordRateLimitError(agentName) {
  if (!agentName || agentName === 'unknown') return;
  
  const counter = getRateLimitCounter(agentName);
  counter.errors++;
  
  if (counter.errors >= RATE_LIMITS.max_consecutive_errors) {
    counter.paused = true;
    counter.pausedAt = Date.now();
    counter.pauseReason = 'max_consecutive_errors';
    console.log(`[RATE-LIMIT] Agent ${agentName} paused: too many consecutive errors (${counter.errors})`);
  }
}

function pauseAgentRateLimit(agentName, reason) {
  const counter = getRateLimitCounter(agentName);
  counter.paused = true;
  counter.pausedAt = Date.now();
  counter.pauseReason = reason;
  console.log(`[RATE-LIMIT] Agent ${agentName} paused: ${reason}`);
}

function resetRateLimitCounters(agentName) {
  rateLimitCounters.set(agentName, {
    requests: [],
    tasks: [],
    chatMessages: [],
    errors: 0,
    paused: false,
    pausedAt: null,
    pauseReason: null
  });
}

// Rate limiting middleware
app.use((req, res, next) => {
  const agentName = req.body?.agent ||
                    req.body?.from ||
                    req.body?.created_by ||
                    req.params?.agent ||
                    req.params?.name ||
                    req.query?.agent ||
                    req.headers['x-agent-name'] ||
                    'unknown';
  
  req.agentName = agentName;
  
  if (req.path === '/health' || req.path.startsWith('/api/rate-limits')) {
    return next();
  }
  
  const limitError = checkRateLimit(agentName, 'requests');
  if (limitError) {
    console.log(`[RATE-LIMIT] Agent ${agentName} exceeded request limit`);
    return res.status(429).json(limitError);
  }
  
  recordRateLimitAction(agentName, 'requests');
  
  next();
});

// ============================================================================
// RATE LIMIT API ENDPOINTS
// ============================================================================

app.get('/api/rate-limits', (req, res) => {
  res.json({
    limits: RATE_LIMITS,
    description: {
      max_requests_per_minute: 'Maximum API requests per agent per minute',
      max_tasks_per_hour: 'Maximum tasks created per agent per hour',
      max_chat_messages_per_minute: 'Maximum chat messages per agent per minute',
      max_consecutive_errors: 'Auto-pause agent after this many consecutive errors',
      task_timeout_minutes: 'Maximum task duration before timeout warning'
    }
  });
});

app.get('/api/rate-limits/status/:agent', (req, res) => {
  const agentName = req.params.agent.toUpperCase();
  const counter = getRateLimitCounter(agentName);
  
  const requests = cleanOldTimestamps(counter.requests, 60000);
  const tasks = cleanOldTimestamps(counter.tasks, 3600000);
  const chatMessages = cleanOldTimestamps(counter.chatMessages, 60000);
  
  res.json({
    agent: agentName,
    status: counter.paused ? 'paused' : 'active',
    pause_reason: counter.pauseReason,
    paused_at: counter.pausedAt ? new Date(counter.pausedAt).toISOString() : null,
    usage: {
      requests_per_minute: {
        current: requests.length,
        limit: RATE_LIMITS.max_requests_per_minute,
        remaining: Math.max(0, RATE_LIMITS.max_requests_per_minute - requests.length)
      },
      tasks_per_hour: {
        current: tasks.length,
        limit: RATE_LIMITS.max_tasks_per_hour,
        remaining: Math.max(0, RATE_LIMITS.max_tasks_per_hour - tasks.length)
      },
      chat_messages_per_minute: {
        current: chatMessages.length,
        limit: RATE_LIMITS.max_chat_messages_per_minute,
        remaining: Math.max(0, RATE_LIMITS.max_chat_messages_per_minute - chatMessages.length)
      }
    },
    consecutive_errors: counter.errors,
    max_consecutive_errors: RATE_LIMITS.max_consecutive_errors,
    timestamp: new Date().toISOString()
  });
});

app.post('/api/rate-limits/reset/:agent', (req, res) => {
  const agentName = req.params.agent.toUpperCase();
  
  resetRateLimitCounters(agentName);
  
  console.log(`[RATE-LIMIT] Counters reset for agent ${agentName}`);
  
  res.json({
    success: true,
    agent: agentName,
    message: 'Rate limit counters reset',
    timestamp: new Date().toISOString()
  });
});

app.get('/api/rate-limits/all', (req, res) => {
  const allStatus = [];
  
  rateLimitCounters.forEach((counter, agentName) => {
    const requests = cleanOldTimestamps(counter.requests, 60000);
    const tasks = cleanOldTimestamps(counter.tasks, 3600000);
    const chatMessages = cleanOldTimestamps(counter.chatMessages, 60000);
    
    allStatus.push({
      agent: agentName,
      status: counter.paused ? 'paused' : 'active',
      pause_reason: counter.pauseReason,
      requests_per_minute: requests.length,
      tasks_per_hour: tasks.length,
      chat_messages_per_minute: chatMessages.length,
      consecutive_errors: counter.errors
    });
  });
  
  res.json({
    total_agents: allStatus.length,
    agents: allStatus,
    limits: RATE_LIMITS,
    timestamp: new Date().toISOString()
  });
});

app.post('/api/rate-limits/pause/:agent', (req, res) => {
  const agentName = req.params.agent.toUpperCase();
  const { reason } = req.body;
  
  pauseAgentRateLimit(agentName, reason || 'manual_pause');
  
  res.json({
    success: true,
    agent: agentName,
    status: 'paused',
    reason: reason || 'manual_pause',
    timestamp: new Date().toISOString()
  });
});

app.post('/api/rate-limits/unpause/:agent', (req, res) => {
  const agentName = req.params.agent.toUpperCase();
  const counter = getRateLimitCounter(agentName);
  
  counter.paused = false;
  counter.pausedAt = null;
  counter.pauseReason = null;
  counter.errors = 0;
  
  console.log(`[RATE-LIMIT] Agent ${agentName} unpaused`);
  
  res.json({
    success: true,
    agent: agentName,
    status: 'active',
    timestamp: new Date().toISOString()
  });
});


// ============================================================================
// IN-MEMORY DATA STORES (MVP - will be replaced with SQLite)
// ============================================================================

let tasks = [];
let logs = [];
let agents = [];
let brainstorms = [];
let chatMessages = []; // Brainstorm ideas storage

// Memory & Learning stores (2026-01-07)
let conversations = [];  // Full sessions with reasoning
let trainingData = [];   // Dane do fine-tuningu
let summaries = [];      // Session summaries dla inject-context

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function getCurrentTimestamp() {
  return new Date().toISOString();
}

function findTaskById(taskId) {
  return tasks.find(t => t.id === taskId);
}

function findAgentByName(name) {
  return agents.find(a => a.name === name);
}

function findBrainstormById(id) {
  return brainstorms.find(b => b.id === id);
}

// ============================================================================
// REDIS PERSISTENCE HELPERS
// ============================================================================

async function saveLog(log) {
  const TTL_7_DAYS = 7 * 24 * 3600;
  await redisClient.setEx(`log:${log.id}`, TTL_7_DAYS, JSON.stringify(log));
}

async function saveTask(task) {
  await redisClient.set(`task:${task.id}`, JSON.stringify(task));
  // Add TTL for completed/failed tasks
  if (task.status === 'DONE' || task.status === 'FAILED') {
    const TTL_30_DAYS = 30 * 24 * 3600;
    await redisClient.expire(`task:${task.id}`, TTL_30_DAYS);
  }
}

async function saveAgent(agent) {
  const TTL_1_HOUR = 3600;
  await redisClient.setEx(`agent:${agent.name}`, TTL_1_HOUR, JSON.stringify(agent));
}

async function saveBrainstorm(brainstorm) {
  await redisClient.set(`brainstorm:${brainstorm.id}`, JSON.stringify(brainstorm));
}

async function deleteBrainstorm(id) {
  await redisClient.del(`brainstorm:${id}`);
}

// ============================================================================
// MEMORY & LEARNING REDIS PERSISTENCE (2026-01-07)
// ============================================================================

async function saveConversation(conv) {
  const TTL_90_DAYS = 90 * 24 * 3600;
  await redisClient.setEx(`conversation:${conv.id}`, TTL_90_DAYS, JSON.stringify(conv));
}

async function saveTrainingData(data) {
  // Training data never expires — this is gold
  await redisClient.set(`training:${data.id}`, JSON.stringify(data));
}

async function saveSummary(summary) {
  // Summaries trzymamy 90 dni (tak jak conversations)
  const TTL_90_DAYS = 90 * 24 * 3600;
  await redisClient.setEx(`summary:${summary.id}`, TTL_90_DAYS, JSON.stringify(summary));
}

async function loadConversationsFromRedis() {
  try {
    const keys = await redisClient.keys('conversation:*');
    conversations = [];
    for (const key of keys) {
      const data = await redisClient.get(key);
      if (data) conversations.push(JSON.parse(data));
    }
    conversations.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    console.log(`💬 Loaded ${conversations.length} conversations from Redis`);
  } catch (error) {
    console.error('Failed to load conversations from Redis:', error);
  }
}

async function loadTrainingDataFromRedis() {
  try {
    const keys = await redisClient.keys('training:*');
    trainingData = [];
    for (const key of keys) {
      const data = await redisClient.get(key);
      if (data) trainingData.push(JSON.parse(data));
    }
    trainingData.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    console.log(`🎓 Loaded ${trainingData.length} training examples from Redis`);
  } catch (error) {
    console.error('Failed to load training data from Redis:', error);
  }
}

async function loadSummariesFromRedis() {
  try {
    const keys = await redisClient.keys('summary:*');
    summaries = [];
    for (const key of keys) {
      const data = await redisClient.get(key);
      if (data) summaries.push(JSON.parse(data));
    }
    summaries.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    console.log(`📝 Loaded ${summaries.length} summaries from Redis`);
  } catch (error) {
    console.error('Failed to load summaries from Redis:', error);
  }
}

async function loadFromRedis() {
  try {
    // Load tasks
    const taskKeys = await redisClient.keys('task:*');
    tasks = [];
    for (const key of taskKeys) {
      const data = await redisClient.get(key);
      if (data) tasks.push(JSON.parse(data));
    }

    // Load logs
    const logKeys = await redisClient.keys('log:*');
    logs = [];
    for (const key of logKeys) {
      const data = await redisClient.get(key);
      if (data) logs.push(JSON.parse(data));
    }

    // Load agents
    const agentKeys = await redisClient.keys('agent:*');
    agents = [];
    for (const key of agentKeys) {
      const data = await redisClient.get(key);
      if (data) agents.push(JSON.parse(data));
    }

    // Load brainstorms
    const brainstormKeys = await redisClient.keys('brainstorm:*');
    brainstorms = [];
    for (const key of brainstormKeys) {
      const data = await redisClient.get(key);
      if (data) brainstorms.push(JSON.parse(data));
    }

    console.log(`📦 Loaded from Redis: ${tasks.length} tasks, ${logs.length} logs, ${agents.length} agents, ${brainstorms.length} brainstorms`);
  } catch (error) {
    console.error('Failed to load from Redis:', error);
  }
}

// ============================================================================
// ROUTES
// ============================================================================

/**
 * GET /health
 * Healthcheck endpoint
 */
app.get('/health', (req, res) => {
  const uptime = process.uptime();
  res.json({
    status: 'ok',
    uptime: Math.floor(uptime),
    version: '0.1.0-mvp',
    memory: {
      tasks: tasks.length,
      logs: logs.length,
      agents: agents.length,
      brainstorms: brainstorms.length,
      notes: notes.length,
      conversations: conversations.length,
      training_data: trainingData.length
    },
    timestamp: getCurrentTimestamp()
  });
});

/**
 * POST /api/tasks/create
 * Create new task
 * Body: { project, assigned_to, created_by, title, description?, priority? }
 */
// Emit a task event to both transports: the embedded WebSocket 'tasks'
// channel (for subscribers in the sandbox) and the cs:tasks Redis pub/sub
// (for external subscribers — e.g. a Cortex worker or a non-Node runner).
// All task-mutating handlers should call this instead of publishing to
// only one of them, so the two views never drift.
function emitTaskEvent(type, data) {
  const payload = { type, data };
  broadcastToChannel('tasks', payload);
  redisClient.publish('cs:tasks', JSON.stringify(payload))
    .catch(err => console.error('Redis publish error:', err));
}

app.post('/api/tasks/create', (req, res) => {
  const { project, assigned_to, created_by, title, description, priority, metadata } = req.body;

  // Rate limit check for task creation (2026-01-14)
  const taskRateLimitError = checkRateLimit(created_by || req.agentName, 'tasks');
  if (taskRateLimitError) {
    console.log(`[RATE-LIMIT] Agent ${created_by || req.agentName} exceeded task creation limit`);
    return res.status(429).json(taskRateLimitError);
  }

  // Validation — assigned_to is optional (pull-style; task goes into the
  // broadcast pool and any eligible agent can claim it via /api/tasks/:id/claim).
  if (!project || !title) {
    return res.status(400).json({
      error: 'Missing required fields',
      required: ['project', 'title']
    });
  }

  const task = {
    id: uuidv4(),
    project: project,
    assigned_to: assigned_to || null,
    created_by: created_by || 'coord',
    title: title,
    description: description || '',
    priority: priority || 'NORMAL',
    metadata: metadata || null,
    status: 'PENDING',
    created_at: getCurrentTimestamp(),
    claimed_at: null,
    started_at: null,
    completed_at: null,
    result: null
  };

  tasks.push(task);
  saveTask(task);
  recordRateLimitAction(task.created_by || req.agentName, 'tasks'); // Rate limit tracking // Redis persist

  // task_created for push-style (assigned), task_available for pull-style (pool)
  emitTaskEvent(task.assigned_to ? 'task_created' : 'task_available', task);

  // Log creation
  const log = {
    id: logs.length + 1,
    project: project,
    agent: created_by || 'coord',
    level: 'INFO',
    message: `Task created: ${title}`,
    task_id: task.id,
    timestamp: getCurrentTimestamp()
  };
  logs.push(log);
  saveLog(log); // Redis persist

  res.status(201).json({
    task_id: task.id,
    status: task.status,
    created_at: task.created_at
  });
});

/**
 * GET /api/tasks/pending/:agent
 * Get pending tasks for specific agent
 */
app.get('/api/tasks/pending/:agent', (req, res) => {
  const agentName = req.params.agent;

  const pendingTasks = tasks.filter(t =>
    t.assigned_to === agentName && t.status === 'PENDING'
  );

  // Sort by priority (URGENT > HIGH > NORMAL > LOW)
  const priorityOrder = { URGENT: 1, HIGH: 2, NORMAL: 3, LOW: 4 };
  pendingTasks.sort((a, b) => {
    const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
    if (priorityDiff !== 0) return priorityDiff;
    // If same priority, sort by creation time (oldest first)
    return new Date(a.created_at) - new Date(b.created_at);
  });

  res.json(pendingTasks);
});

/**
 * GET /api/tasks/available
 * List pull-style tasks: status=PENDING and assigned_to=null.
 * Any agent can claim one via POST /api/tasks/:id/claim.
 * Sorted by priority then creation time (oldest first).
 */
app.get('/api/tasks/available', (req, res) => {
  const available = tasks.filter(t =>
    t.assigned_to === null && t.status === 'PENDING'
  );
  const priorityOrder = { URGENT: 1, HIGH: 2, NORMAL: 3, LOW: 4 };
  available.sort((a, b) => {
    const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
    if (priorityDiff !== 0) return priorityDiff;
    return new Date(a.created_at) - new Date(b.created_at);
  });
  res.json(available);
});

/**
 * POST /api/tasks/:id/claim
 * Claim an available task. The task must currently have assigned_to=null
 * and status=PENDING. Node's single-threaded event loop makes the
 * "check assigned_to, then set it" sequence atomic for concurrent requests
 * — the first POST wins, the second gets 409.
 * Body: { agent }
 */
app.post('/api/tasks/:id/claim', (req, res) => {
  const taskId = req.params.id;
  const { agent } = req.body || {};

  if (!agent) {
    return res.status(400).json({ error: 'Missing required field: agent' });
  }

  const task = tasks.find(t => t.id === taskId);
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }
  if (task.assigned_to !== null) {
    return res.status(409).json({
      error: 'Task already claimed',
      assigned_to: task.assigned_to,
      claimed_at: task.claimed_at
    });
  }
  if (task.status !== 'PENDING') {
    return res.status(409).json({
      error: 'Task is not in PENDING status',
      status: task.status
    });
  }

  task.assigned_to = agent;
  task.claimed_at = getCurrentTimestamp();
  saveTask(task);

  emitTaskEvent('task_claimed', task);

  res.json({
    task_id: task.id,
    agent,
    claimed_at: task.claimed_at
  });
});

/**
 * PATCH /api/tasks/:id/status
 * Update task status
 * Body: { status, result? }
 */
app.patch('/api/tasks/:id/status', (req, res) => {
  const taskId = req.params.id;
  const { status, result } = req.body;

  if (!status) {
    return res.status(400).json({ error: 'Missing required field: status' });
  }

  const task = findTaskById(taskId);
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }

  const validStatuses = ['PENDING', 'IN_PROGRESS', 'DONE', 'FAILED', 'CANCELLED'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({
      error: 'Invalid status',
      valid_statuses: validStatuses
    });
  }

  // Update task
  const previousStatus = task.status;
  task.status = status;

  if (status === 'IN_PROGRESS' && !task.started_at) {
    task.claimed_at = task.claimed_at || getCurrentTimestamp();
    task.started_at = getCurrentTimestamp();
  }

  if (status === 'DONE' || status === 'FAILED') {
    task.completed_at = getCurrentTimestamp();
    if (result) {
      task.result = result;
    }
  }

  saveTask(task); // Redis persist (adds TTL if DONE/FAILED)

  emitTaskEvent('task_updated', {
    task_id: task.id,
    status,
    previous_status: previousStatus,
    task
  });

  // Log status change
  const log = {
    id: logs.length + 1,
    project: task.project,
    agent: task.assigned_to,
    level: status === 'FAILED' ? 'ERROR' : 'INFO',
    message: `Task status: ${previousStatus} → ${status}`,
    task_id: task.id,
    timestamp: getCurrentTimestamp()
  };
  logs.push(log);
  saveLog(log); // Redis persist

  res.json({
    success: true,
    task_id: task.id,
    status: task.status,
    previous_status: previousStatus
  });
});

// ============================================================================
// AGENT REGISTRY ENDPOINTS
// ============================================================================

/**
 * POST /api/agents/register
 * Register or update an agent
 * Body: { name, location, role, capabilities? }
 */
app.post('/api/agents/register', (req, res) => {
  const { name, location, role, capabilities, status: rawStatus } = req.body;

  if (!name || !location || !role) {
    return res.status(400).json({
      error: 'Missing required fields',
      required: ['name', 'location', 'role']
    });
  }

  let initialStatus = 'IDLE';  // default = ready for tasks (was legacy 'FREE')
  if (rawStatus !== undefined) {
    const normalized = normalizeFsmState(rawStatus);
    if (!isValidFsmState(normalized)) {
      return res.status(400).json({
        error: 'Invalid FSM state',
        valid_states: FSM_STATES,
        received: rawStatus,
        hint: "Legacy 'FREE' accepted (maps to IDLE)"
      });
    }
    initialStatus = normalized;
  }

  const existingAgent = findAgentByName(name);

  if (existingAgent) {
    // Update existing agent
    existingAgent.location = location;
    existingAgent.role = role;
    existingAgent.capabilities = capabilities || existingAgent.capabilities;
    existingAgent.last_heartbeat = getCurrentTimestamp();
    existingAgent.status = initialStatus;
    saveAgent(existingAgent); // Redis persist (refreshes 1h TTL)

    return res.json({
      message: 'Agent updated',
      agent: existingAgent
    });
  }

  // Create new agent
  const agent = {
    name: name,
    location: location,
    role: role,
    capabilities: capabilities || [],
    status: initialStatus,
    registered_at: getCurrentTimestamp(),
    last_heartbeat: getCurrentTimestamp()
  };

  agents.push(agent);
  saveAgent(agent); // Redis persist with 1h TTL

  // Log registration
  const log = {
    id: logs.length + 1,
    project: 'ecosystem',
    agent: name,
    level: 'INFO',
    message: `Agent registered: ${name} (${role})`,
    task_id: null,
    timestamp: getCurrentTimestamp()
  };
  logs.push(log);
  saveLog(log); // Redis persist

  res.status(201).json({
    message: 'Agent registered',
    agent: agent
  });
});

/**
 * POST /api/agents/:name/heartbeat
 * Update agent heartbeat (keep-alive signal)
 */
app.post('/api/agents/:name/heartbeat', (req, res) => {
  const agentName = req.params.name;
  const agent = findAgentByName(agentName);

  if (!agent) {
    return res.status(404).json({
      error: 'Agent not found',
      hint: 'Register agent first using POST /api/agents/register'
    });
  }

  const { status: rawStatus, task_id, blocked_on } = req.body || {};
  const previousStatus = agent.status;

  if (rawStatus !== undefined) {
    const normalized = normalizeFsmState(rawStatus);
    if (!isValidFsmState(normalized)) {
      return res.status(400).json({
        error: 'Invalid FSM state',
        valid_states: FSM_STATES,
        received: rawStatus,
        hint: "Legacy 'FREE' accepted (maps to IDLE)"
      });
    }
    agent.status = normalized;
  }
  if (task_id !== undefined) agent.current_task = task_id;
  if (blocked_on !== undefined) agent.blocked_on = blocked_on;

  agent.last_heartbeat = getCurrentTimestamp();
  saveAgent(agent); // Redis persist (refreshes 1h TTL)

  // Broadcast state transition (only when status actually changed)
  if (rawStatus !== undefined && previousStatus !== agent.status) {
    const event = {
      type: 'agent_status_changed',
      data: {
        agent: agentName,
        status: agent.status,
        previous_status: previousStatus,
        task_id: agent.current_task || null,
        blocked_on: agent.blocked_on || null,
        timestamp: agent.last_heartbeat
      }
    };
    broadcastToChannel('agents', event);
    redisClient.publish('cs:agents', JSON.stringify(event))
      .catch(err => console.error('Redis publish error:', err));
  }

  res.json({
    success: true,
    agent: agentName,
    status: agent.status,
    previous_status: previousStatus,
    heartbeat: agent.last_heartbeat,
    task_id: agent.current_task || null,
    blocked_on: agent.blocked_on || null
  });
});

/**
 * PATCH /api/agents/:name/status
 * Update agent FSM state. Body: { status, task_id?, blocked_on? }
 * Valid states: OFFLINE, STARTING, IDLE, BUSY, BLOCKED, ERROR (+ legacy FREE→IDLE)
 */
app.patch('/api/agents/:name/status', (req, res) => {
  const agentName = req.params.name;
  const { status: rawStatus, task_id, blocked_on } = req.body || {};

  if (!rawStatus) {
    return res.status(400).json({ error: 'Missing required field: status' });
  }

  const normalized = normalizeFsmState(rawStatus);
  if (!isValidFsmState(normalized)) {
    return res.status(400).json({
      error: 'Invalid FSM state',
      valid_states: FSM_STATES,
      received: rawStatus,
      hint: "Legacy 'FREE' accepted (maps to IDLE)"
    });
  }

  const agent = findAgentByName(agentName);

  if (!agent) {
    return res.status(404).json({
      error: 'Agent not found',
      hint: 'Register agent first using POST /api/agents/register'
    });
  }

  const previousStatus = agent.status;
  agent.status = normalized;
  if (task_id !== undefined) agent.current_task = task_id;
  if (blocked_on !== undefined) agent.blocked_on = blocked_on;
  agent.last_heartbeat = getCurrentTimestamp();
  saveAgent(agent); // Redis persist (refreshes 1h TTL)

  // Broadcast transition to both channels (embedded WS + Redis pub/sub)
  const event = {
    type: 'agent_status_changed',
    data: {
      agent: agentName,
      status: agent.status,
      previous_status: previousStatus,
      task_id: agent.current_task || null,
      blocked_on: agent.blocked_on || null,
      timestamp: agent.last_heartbeat
    }
  };
  broadcastToChannel('agents', event);
  redisClient.publish('cs:agents', JSON.stringify(event))
    .catch(err => console.error('Redis publish error:', err));

  res.json({
    success: true,
    agent: agentName,
    status: agent.status,
    previous_status: previousStatus,
    task_id: agent.current_task || null,
    blocked_on: agent.blocked_on || null
  });
});

/**
 * GET /api/agents
 * List all registered agents
 */
app.get('/api/agents', (req, res) => {
  const now = new Date();

  // Mark agents as OFFLINE if no heartbeat for > 60 seconds
  agents.forEach(agent => {
    const lastHeartbeat = new Date(agent.last_heartbeat);
    const secondsSinceHeartbeat = (now - lastHeartbeat) / 1000;

    if (secondsSinceHeartbeat > HEARTBEAT_OFFLINE_THRESHOLD_SEC && agent.status !== 'OFFLINE') {
      agent.status = 'OFFLINE';
    }
  });

  res.json({
    total: agents.length,
    agents: agents
  });
});

/**
 * GET /api/agents/all
 * Get ALL agents including archived, with full history
 * MUST be before /api/agents/:name to avoid route conflict
 */
app.get('/api/agents/all', (req, res) => {
  const now = new Date();

  // Add computed status based on heartbeat
  const agentsWithStatus = agents.map(agent => {
    const lastHeartbeat = new Date(agent.last_heartbeat);
    const secondsSinceHeartbeat = (now - lastHeartbeat) / 1000;

    let computedStatus = agent.status;
    if (secondsSinceHeartbeat > HEARTBEAT_OFFLINE_THRESHOLD_SEC && agent.status !== 'OFFLINE') {
      computedStatus = 'OFFLINE';
    }

    return {
      ...agent,
      computed_status: computedStatus,
      last_seen: secondsSinceHeartbeat < 60 ? 'just now' :
                 secondsSinceHeartbeat < 3600 ? `${Math.floor(secondsSinceHeartbeat / 60)} min ago` :
                 `${Math.floor(secondsSinceHeartbeat / 3600)} hours ago`,
      uptime_seconds: secondsSinceHeartbeat
    };
  });

  res.json({
    total: agentsWithStatus.length,
    online: agentsWithStatus.filter(a => a.computed_status !== 'OFFLINE').length,
    offline: agentsWithStatus.filter(a => a.computed_status === 'OFFLINE').length,
    agents: agentsWithStatus,
    timestamp: now.toISOString()
  });
});

/**
 * GET /api/agents/:name/history
 * Get activity history for specific agent
 * MUST be before /api/agents/:name to avoid route conflict
 */
app.get('/api/agents/:name/history', (req, res) => {
  const agentName = req.params.name;
  const limit = parseInt(req.query.limit) || 100;

  // Gather all agent activities
  const activities = [];

  // Tasks created or completed by agent
  tasks.forEach(task => {
    if (task.assigned_to === agentName || task.created_by === agentName) {
      activities.push({
        type: 'task',
        timestamp: task.completed_at || task.started_at || task.created_at,
        action: task.status === 'DONE' ? 'completed_task' : 'started_task',
        details: {
          task_id: task.id,
          title: task.title,
          status: task.status
        }
      });
    }
  });

  // Chat messages from agent
  chatMessages.forEach(msg => {
    if (msg.from === agentName) {
      activities.push({
        type: 'chat',
        timestamp: msg.timestamp,
        action: 'sent_message',
        details: {
          message_id: msg.id,
          mentions: msg.mentions || [],
          preview: msg.content.substring(0, 100)
        }
      });
    }
  });

  // Logs from agent
  logs.forEach(log => {
    if (log.agent === agentName) {
      activities.push({
        type: 'log',
        timestamp: log.timestamp,
        action: 'logged',
        details: {
          level: log.level,
          message: log.message
        }
      });
    }
  });

  // Sort by timestamp descending and limit
  activities.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  const limited = activities.slice(0, limit);

  res.json({
    agent: agentName,
    total_activities: activities.length,
    showing: limited.length,
    activities: limited
  });
});

/**
 * GET /api/agents/:name
 * Get specific agent details
 */
app.get('/api/agents/:name', (req, res) => {
  const agent = findAgentByName(req.params.name);

  if (!agent) {
    return res.status(404).json({ error: 'Agent not found' });
  }

  res.json(agent);
});

/**
 * GET /api/agents/:name/context
 * Get agent context/token usage for monitoring
 * Returns: { tokens_used, tokens_limit, usage_percent, status }
 */
app.get('/api/agents/:name/context', (req, res) => {
  const agent = findAgentByName(req.params.name);

  if (!agent) {
    return res.status(404).json({ error: 'Agent not found' });
  }

  // Get token usage from agent metadata (if tracked)
  const tokensUsed = agent.context?.tokens_used || 0;
  const tokensLimit = agent.context?.tokens_limit || 200000;
  const usagePercent = Math.round((tokensUsed / tokensLimit) * 100);

  // Determine status based on usage
  let status = 'healthy';
  if (usagePercent >= 95) status = 'critical';
  else if (usagePercent >= 85) status = 'warning';
  else if (usagePercent >= 70) status = 'caution';

  res.json({
    agent: req.params.name,
    tokens_used: tokensUsed,
    tokens_limit: tokensLimit,
    usage_percent: usagePercent,
    status: status,
    last_updated: agent.last_heartbeat,
    timestamp: new Date().toISOString()
  });
});

/**
 * POST /api/agents/:name/restart
 * Restart agent via tmux
 * Body: { reason? }
 */
app.post('/api/agents/:name/restart', async (req, res) => {
  const agentName = req.params.name;
  const agent = findAgentByName(agentName);

  if (!agent) {
    return res.status(404).json({ error: 'Agent not found' });
  }

  const { reason } = req.body;

  try {
    const { execFile } = require('child_process');
    const { promisify } = require('util');
    const execFileAsync = promisify(execFile);

    // Find tmux session for agent. Reject anything that could escape the
    // tmux target into the shell — tmux names are [a-z0-9_-] by convention.
    const sessionName = agentName;
    if (!/^[a-zA-Z0-9._-]+$/.test(sessionName)) {
      return res.status(400).json({
        error: 'Invalid agent name for tmux control',
        agent: agentName,
      });
    }

    // Check if session exists
    try {
      await execFileAsync('tmux', ['has-session', '-t', sessionName]);
    } catch (err) {
      return res.status(404).json({
        error: 'Tmux session not found',
        agent: agentName,
        session: sessionName
      });
    }

    // Send Ctrl+C and restart command. tmux args are passed as argv, so
    // metacharacters in sessionName cannot reach a shell.
    await execFileAsync('tmux', ['send-keys', '-t', sessionName, 'C-c']);
    await new Promise(resolve => setTimeout(resolve, 1000));
    await execFileAsync('tmux', ['send-keys', '-t', sessionName, 'claude', 'Enter']);

    // Update agent status
    agent.status = 'RESTARTING';
    agent.last_restart = new Date().toISOString();
    agent.restart_reason = reason || 'Manual restart';

    // Log the restart
    logs.push({
      timestamp: new Date().toISOString(),
      agent: agentName,
      level: 'INFO',
      message: `Agent restarted via API. Reason: ${reason || 'Manual restart'}`,
      project: 'ecosystem'
    });

    res.json({
      success: true,
      agent: agentName,
      message: 'Agent restart initiated',
      session: sessionName,
      reason: reason || 'Manual restart',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to restart agent',
      message: error.message,
      agent: agentName
    });
  }
});

// ============================================================================
// DASHBOARD V3 - SYSTEM RESOURCES & TRAINING (2026-01-10)
// ============================================================================

/**
 * GET /api/system/resources/remote
 * Get remote-host system resources (GPU, RAM, CPU, disk)
 */
app.get('/api/system/resources/remote', async (req, res) => {
  try {
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);

    // Get GPU info from nvidia-smi
    let gpuData = null;
    try {
      const { stdout } = await execAsync('nvidia-smi --query-gpu=index,name,temperature.gpu,utilization.gpu,utilization.memory,memory.used,memory.total --format=csv,noheader,nounits');
      const gpuLines = stdout.trim().split('\n');
      gpuData = gpuLines.map(line => {
        const [index, name, temp, gpu_util, mem_util, mem_used, mem_total] = line.split(', ');
        return {
          index: parseInt(index),
          name: name.trim(),
          temperature: parseInt(temp),
          gpu_utilization: parseInt(gpu_util),
          memory_utilization: parseInt(mem_util),
          memory_used_mb: parseInt(mem_used),
          memory_total_mb: parseInt(mem_total)
        };
      });
    } catch (err) {
      console.error('nvidia-smi error:', err.message);
    }

    // Get RAM info
    const { stdout: memInfo } = await execAsync('free -m');
    const memLines = memInfo.split('\n')[1].split(/\s+/);
    const ramTotal = parseInt(memLines[1]);
    const ramUsed = parseInt(memLines[2]);

    // Get CPU info
    const { stdout: cpuInfo } = await execAsync('top -bn1 | grep "Cpu(s)"');
    const cpuMatch = cpuInfo.match(/(\d+\.\d+)\s+us/);
    const cpuUsage = cpuMatch ? parseFloat(cpuMatch[1]) : 0;

    // Get disk info
    const { stdout: diskInfo } = await execAsync('df -h / | tail -1');
    const diskParts = diskInfo.split(/\s+/);
    const diskUsage = parseInt(diskParts[4]);

    res.json({
      timestamp: new Date().toISOString(),
      hostname: require('os').hostname(),
      gpu: gpuData,
      ram: {
        total_mb: ramTotal,
        used_mb: ramUsed,
        free_mb: ramTotal - ramUsed,
        usage_percent: Math.round((ramUsed / ramTotal) * 100)
      },
      cpu: {
        usage_percent: cpuUsage,
        cores: require('os').cpus().length
      },
      disk: {
        usage_percent: diskUsage,
        mount: '/'
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get system resources', message: error.message });
  }
});

/**
 * GET /api/ollama/models/loaded
 * Get currently loaded models in Ollama
 */
app.get('/api/ollama/models/loaded', async (req, res) => {
  try {
    const response = await fetch(`${process.env.OLLAMA_URL || 'http://localhost:11434'}/api/tags`);
    const data = await response.json();

    res.json({
      models: data.models || [],
      total: (data.models || []).length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get Ollama models', message: error.message });
  }
});

/**
 * POST /api/training/data
 * Save training data in OpenAI format
 */
app.post('/api/training/data', (req, res) => {
  const { messages, metadata } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array required' });
  }

  const trainingEntry = {
    id: `train_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    messages: messages,
    metadata: {
      ...metadata,
      system_context: 'Ecosystem multi-agent system',
      collected_at: new Date().toISOString()
    },
    created_at: new Date().toISOString()
  };

  trainingData.push(trainingEntry);

  // Broadcast to WebSocket clients
  if (wss) {
    const message = JSON.stringify({
      type: 'training_data_added',
      data: { id: trainingEntry.id, message_count: messages.length }
    });
    wss.clients.forEach(client => {
      if (client.readyState === 1) {
        client.send(message);
      }
    });
  }

  res.json({
    success: true,
    training_id: trainingEntry.id,
    total_training_entries: trainingData.length
  });
});

/**
 * GET /api/training/datasets
 * List all training datasets
 */
app.get('/api/training/datasets', (req, res) => {
  res.json({
    total: trainingData.length,
    datasets: trainingData.map(t => ({
      id: t.id,
      message_count: t.messages.length,
      metadata: t.metadata,
      created_at: t.created_at
    }))
  });
});

/**
 * GET /api/machines
 * Get list of machines in Ecosystem infrastructure
 * Used by Dashboard V3 MachinesPanel
 */
app.get('/api/machines', (req, res) => {
  const machines = [
    {
      id: 'remote-host',
      name: 'remote-host',
      type: 'server',
      hostname: require('os').hostname(),
      ip: '127.0.0.1',
      status: 'online',
      role: 'primary',
      services: ['consciousness', 'ollama', 'redis', 'semantic-search'],
      specs: {
        cpu: 'AMD Ryzen',
        ram_gb: 64,
        gpu: 'NVIDIA GeForce RTX 5070'
      }
    },
    {
      id: 'laptop',
      name: 'Laptop',
      type: 'workstation',
      hostname: 'laptop',
      ip: '10.0.0.1',
      status: 'online',
      role: 'development',
      services: ['dashboard', 'agents'],
      specs: {
        cpu: 'Intel i7',
        ram_gb: 32,
        gpu: 'Integrated'
      }
    }
  ];

  res.json({
    total: machines.length,
    machines: machines,
    timestamp: new Date().toISOString()
  });
});

// ============================================================================
// MEDIA ENDPOINTS
// ============================================================================

/**
 * POST /api/media/youtube
 * Queue YouTube video for transcription
 * Body: { url, title?, priority? }
 */
app.post('/api/media/youtube', (req, res) => {
  const { url, title, priority } = req.body;

  if (!url) {
    return res.status(400).json({
      error: 'Missing required field: url'
    });
  }

  // Extract video ID from URL
  const videoIdMatch = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&?]+)/);
  if (!videoIdMatch) {
    return res.status(400).json({
      error: 'Invalid YouTube URL'
    });
  }

  const videoId = videoIdMatch[1];

  // Create transcription task
  const task = {
    id: uuidv4(),
    project: 'ecosystem',
    assigned_to: 'worker1',
    created_by: 'Dashboard',
    title: title || `YouTube Transcription: ${videoId}`,
    description: `Example job: ${url}\n\nExecute: /opt/ecosystem/scripts/example.sh "${url}"`,
    priority: priority || 'NORMAL',
    metadata: metadata || null,
    status: 'PENDING',
    created_at: getCurrentTimestamp(),
    claimed_at: null,
    started_at: null,
    completed_at: null,
    result: null,
    metadata: {
      type: 'youtube_transcription',
      video_id: videoId,
      url: url
    }
  };

  tasks.push(task);
  saveTask(task); // Redis persist

  // Log creation
  const log = {
    id: logs.length + 1,
    project: 'ecosystem',
    agent: 'Dashboard',
    level: 'INFO',
    message: `YouTube transcription queued: ${videoId}`,
    task_id: task.id,
    timestamp: getCurrentTimestamp()
  };
  logs.push(log);
  saveLog(log); // Redis persist

  res.status(201).json({
    task_id: task.id,
    video_id: videoId,
    status: task.status,
    message: 'Transcription task created successfully'
  });
});

/**
 * GET /api/media/transcripts
 * List available transcriptions
 */
app.get('/api/media/transcripts', (req, res) => {
  // For now, return tasks with type=youtube_transcription
  const transcriptTasks = tasks.filter(t =>
    t.metadata && t.metadata.type === 'youtube_transcription'
  );

  const transcripts = transcriptTasks.map(t => ({
    task_id: t.id,
    video_id: t.metadata.video_id,
    url: t.metadata.url,
    title: t.title,
    status: t.status,
    created_at: t.created_at,
    completed_at: t.completed_at
  }));

  res.json({
    total: transcripts.length,
    transcripts: transcripts
  });
});

// ============================================================================
// LOGS ENDPOINTS
// ============================================================================

/**
 * POST /api/logs/append
 * Append new log entry
 * Body: { project, agent, level?, message, task_id? }
 */
app.post('/api/logs/append', (req, res) => {
  const { project, agent, level, message, task_id, metadata } = req.body;

  if (!project || !agent || !message) {
    return res.status(400).json({
      error: 'Missing required fields',
      required: ['project', 'agent', 'message']
    });
  }

  const validLevels = ['DEBUG', 'INFO', 'WARN', 'ERROR'];
  const logLevel = level && validLevels.includes(level) ? level : 'INFO';

  const log = {
    id: logs.length + 1,
    project: project,
    agent: agent,
    level: logLevel,
    message: message,
    task_id: task_id || null,
    metadata: metadata || null,
    timestamp: getCurrentTimestamp()
  };

  logs.push(log);
  saveLog(log); // Redis persist

  // Broadcast log to WebSocket
  redisClient.publish('cs:logs', JSON.stringify({
    type: 'log_added',
    data: log
  })).catch(err => console.error('Redis publish error:', err));

  res.status(201).json({
    log_id: log.id,
    timestamp: log.timestamp
  });
});

/**
 * GET /api/logs/recent
 * Get recent logs
 * Query params: limit (default 20), project?, agent?, level?
 */
app.get('/api/logs/recent', (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  const project = req.query.project;
  const agent = req.query.agent;
  const level = req.query.level;

  let filteredLogs = [...logs];

  // Apply filters
  if (project) {
    filteredLogs = filteredLogs.filter(l => l.project === project);
  }
  if (agent) {
    filteredLogs = filteredLogs.filter(l => l.agent === agent);
  }
  if (level) {
    filteredLogs = filteredLogs.filter(l => l.level === level);
  }

  // Sort by timestamp descending (newest first)
  filteredLogs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  // Limit results
  const recentLogs = filteredLogs.slice(0, limit);

  res.json(recentLogs);
});

// ============================================================================
// BRAINSTORM API (Quick Ideas)
// ============================================================================

/**
 * GET /api/brainstorm
 * Get all brainstorm ideas
 * Query params: project?, status?
 */
app.get('/api/brainstorm', (req, res) => {
  const project = req.query.project;
  const status = req.query.status;

  let filtered = [...brainstorms];

  if (project) {
    filtered = filtered.filter(b => b.project === project);
  }
  if (status) {
    filtered = filtered.filter(b => b.status === status);
  }

  // Sort by created_at descending (newest first)
  filtered.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  res.json({
    total: filtered.length,
    brainstorms: filtered
  });
});

/**
 * POST /api/brainstorm
 * Create new brainstorm idea
 * Body: { title, description?, project? }
 */
app.post('/api/brainstorm', (req, res) => {
  const { title, description, project } = req.body;

  if (!title) {
    return res.status(400).json({
      error: 'Missing required fields',
      required: ['title']
    });
  }

  const brainstorm = {
    id: uuidv4(),
    title: title,
    description: description || '',
    project: project || 'ecosystem',
    status: 'NEW',
    created_at: getCurrentTimestamp()
  };

  brainstorms.push(brainstorm);
  saveBrainstorm(brainstorm); // Redis persist

  res.status(201).json({
    brainstorm_id: brainstorm.id,
    created_at: brainstorm.created_at
  });
});

/**
 * DELETE /api/brainstorm/:id
 * Delete brainstorm idea
 */
app.delete('/api/brainstorm/:id', (req, res) => {
  const brainstormId = req.params.id;
  const brainstorm = findBrainstormById(brainstormId);

  if (!brainstorm) {
    return res.status(404).json({ error: 'Brainstorm not found' });
  }

  // Remove from memory
  brainstorms = brainstorms.filter(b => b.id !== brainstormId);

  // Remove from Redis
  deleteBrainstorm(brainstormId);

  res.json({
    success: true,
    message: 'Brainstorm deleted',
    brainstorm_id: brainstormId
  });
});

/**
 * POST /api/brainstorm/:id/promote
 * Promote brainstorm to task
 * Body: { assigned_to?, priority? }
 */
app.post('/api/brainstorm/:id/promote', (req, res) => {
  const brainstormId = req.params.id;
  const brainstorm = findBrainstormById(brainstormId);

  if (!brainstorm) {
    return res.status(404).json({ error: 'Brainstorm not found' });
  }

  const { assigned_to, priority } = req.body;

  // Create task from brainstorm
  const task = {
    id: uuidv4(),
    project: brainstorm.project,
    assigned_to: assigned_to || 'worker1',
    created_by: 'Brainstorm',
    title: brainstorm.title,
    description: brainstorm.description,
    priority: priority || 'NORMAL',
    metadata: metadata || null,
    status: 'PENDING',
    created_at: getCurrentTimestamp(),
    claimed_at: null,
    started_at: null,
    completed_at: null,
    result: null,
    metadata: {
      promoted_from_brainstorm: brainstormId,
      brainstorm_created_at: brainstorm.created_at
    }
  };

  tasks.push(task);
  saveTask(task); // Redis persist

  emitTaskEvent('task_created', task);

  // Delete brainstorm after promotion
  brainstorms = brainstorms.filter(b => b.id !== brainstormId);
  deleteBrainstorm(brainstormId);

  res.status(201).json({
    success: true,
    message: 'Brainstorm promoted to task',
    task: task,
    brainstorm_id: brainstormId
  });
});

// ============================================================================
// ADDITIONAL HELPER ENDPOINTS (bonus for debugging)
// ============================================================================

/**
 * GET /api/tasks/:id
 * Get task details by ID
 */
app.get('/api/tasks/:id', (req, res) => {
  const task = findTaskById(req.params.id);
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }
  res.json(task);
});

/**
 * GET /api/tasks
 * Get all tasks (for debugging)
 */
app.get('/api/tasks', (req, res) => {
  res.json({
    total: tasks.length,
    tasks: tasks
  });
});

/**
 * GET /api/system/architecture
 * Get Ecosystem architecture tree (file structure + descriptions)
 */
app.get('/api/system/architecture', (req, res) => {
  const architecture = {
    name: "Ecosystem Ecosystem",
    type: "root",
    description: "Multi-agent AI development platform",
    children: [
      {
        name: "Consciousness Server",
        type: "server",
        port: 3032,
        path: "/opt/ecosystem/memory-server",
        description: "Central coordination - Tasks, Logs, Agent Registry",
        status: "running",
        children: [
          { name: "Agent Registry", type: "api", description: "Track agent status & heartbeat" },
          { name: "Task Queue", type: "api", description: "Distribute work to agents" },
          { name: "Logging System", type: "api", description: "Centralized logs from all agents" },
          { name: "Media API", type: "api", description: "YouTube transcriptions" }
        ]
      },
      {
        name: "Skills Server",
        type: "server",
        port: 3031,
        path: "/opt/ecosystem/skills-server",
        description: "Skills repository - templates, agents, tools",
        status: "running"
      },
      {
        name: "Dashboard",
        type: "frontend",
        port: 3033,
        path: "laptop",
        description: "Web UI for monitoring & control",
        status: "running",
        managed_by: "agent2"
      },
      {
        name: "Agents",
        type: "group",
        description: "AI workers in the ecosystem",
        children: [
          {
            name: "coord (Claude Desktop)",
            type: "agent",
            role: "Coordinator",
            location: "Laptop",
            description: "Creates tasks, monitors system, makes decisions"
          },
          {
            name: "worker1 (Claude Code on a remote host)",
            type: "agent",
            role: "Backend Worker",
            location: "remote-host",
            description: "Servers, APIs, databases, GPU tasks"
          },
          {
            name: "agent2 (Claude Code on a local host)",
            type: "agent",
            role: "Frontend Worker",
            location: "Laptop",
            description: "UI, Dashboard, docs, testing"
          }
        ]
      },
      {
        name: "Workers",
        type: "group",
        description: "Background daemons",
        children: [
          {
            name: "cca-worker",
            type: "daemon",
            description: "Polls tasks, sends heartbeat, notifies workers"
          }
        ]
      }
    ],
    ports: [
      { port: 3031, service: "Skills Server", status: "active" },
      { port: 3032, service: "Consciousness Server", status: "active" },
      { port: 3033, service: "Dashboard", status: "active" }
    ],
    communication: {
      "coord ↔ Consciousness": "MCP over stdio",
      "worker/agent ↔ Consciousness": "HTTP REST API",
      "Dashboard ↔ Consciousness": "HTTP REST API",
      "Worker ↔ Consciousness": "HTTP polling (10s tasks, 30s heartbeat)"
    }
  };

  res.json(architecture);
});

/**
 * GET /api/stats
 * Get server statistics
 */
app.get('/api/stats', (req, res) => {
  const stats = {
    tasks: {
      total: tasks.length,
      pending: tasks.filter(t => t.status === 'PENDING').length,
      in_progress: tasks.filter(t => t.status === 'IN_PROGRESS').length,
      done: tasks.filter(t => t.status === 'DONE').length,
      failed: tasks.filter(t => t.status === 'FAILED').length
    },
    logs: {
      total: logs.length,
      by_level: {
        debug: logs.filter(l => l.level === 'DEBUG').length,
        info: logs.filter(l => l.level === 'INFO').length,
        warn: logs.filter(l => l.level === 'WARN').length,
        error: logs.filter(l => l.level === 'ERROR').length
      }
    },
    agents: {
      total: agents.length
    },
    uptime: Math.floor(process.uptime()),
    memory_usage: process.memoryUsage()
  };

  res.json(stats);
});

/**
 * GET /api/services
 * Dynamically discover available Ecosystem services
 */
app.get('/api/services', async (req, res) => {
  const http = require('http');

  // List of known services to check.
  // Keep in sync with services.yaml at repo root.
  const servicesToCheck = [
    { name: 'consciousness', port: 3032, path: '/health', description: 'Core — tasks, notes, agents, skills, chat, memory' },
    { name: 'semantic-search', port: 3037, path: '/health', description: 'Flask + ChromaDB; embeddings via Ollama' },
    { name: 'machines', port: 3038, path: '/health', description: 'Infrastructure awareness + realtime telemetry' },
    { name: 'key-server', port: 3040, path: '/health', description: 'ed25519 signed-request verification' },
    { name: 'test-runner', port: 3041, path: '/health', description: 'Async test execution' },
    { name: 'git-workflow', port: 3042, path: '/health', description: 'Commit hook receiver' },
    { name: 'ollama', port: 11434, path: '/api/tags', description: 'Local LLM inference + embeddings (host)' }
  ];

  // Check each service
  const checkService = (service) => {
    return new Promise((resolve) => {
      const req = http.get(`http://localhost:${service.port}${service.path}`, { timeout: 1000 }, (res) => {
        // Accept 200 OK, 426 Upgrade Required (WebSocket), and other 2xx/4xx codes as "active"
        if (res.statusCode === 200 || res.statusCode === 426 || (res.statusCode >= 200 && res.statusCode < 500)) {
          resolve({ ...service, status: 'active' });
        } else {
          resolve({ ...service, status: 'inactive' });
        }
      });

      req.on('error', () => {
        resolve({ ...service, status: 'inactive' });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({ ...service, status: 'timeout' });
      });
    });
  };

  const results = await Promise.all(servicesToCheck.map(checkService));

  // Separate active and inactive services
  const active = {};
  const inactive = {};

  results.forEach(service => {
    const { name, status, ...rest } = service;
    if (status === 'active') {
      active[name] = { ...rest, status };
    } else {
      inactive[name] = { ...rest, status };
    }
  });

  res.json({
    services: active,
    inactive: inactive,
    checked_at: getCurrentTimestamp()
  });
});

// ============================================================================
// ============================================================================
// NOTES API (Agent observations, decisions, blockers)
// ============================================================================

let notes = [];

async function saveNote(note) {
  // Notes persist for 30 days by default, or until expires_at
  const TTL_30_DAYS = 30 * 24 * 3600;
  await redisClient.set(`note:${note.id}`, JSON.stringify(note));
  if (!note.expires_at) {
    await redisClient.expire(`note:${note.id}`, TTL_30_DAYS);
  }
}

async function deleteNote(id) {
  await redisClient.del(`note:${id}`);
}

async function loadNotesFromRedis() {
  try {
    const noteKeys = await redisClient.keys('note:*');
    notes = [];
    for (const key of noteKeys) {
      const data = await redisClient.get(key);
      if (data) notes.push(JSON.parse(data));
    }
    notes.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    console.log(`📝 Loaded ${notes.length} notes from Redis`);
  } catch (error) {
    console.error('Failed to load notes from Redis:', error);
  }
}

// ============================================================================
// MEMORY & LEARNING API (2026-01-07)
// Automatyczny zapis konwersacji i danych treningowych z reasoning steps
// ============================================================================

/**
 * POST /api/memory/conversations
 * Zapisz pełną konwersację z reasoning steps
 * Body: { agent, session_id?, messages, reasoning_chain?, metadata? }
 */
app.post('/api/memory/conversations', async (req, res) => {
  const { agent, session_id, messages, reasoning_chain, metadata, summary } = req.body;

  if (!agent || !messages || !Array.isArray(messages)) {
    return res.status(400).json({
      error: 'Missing required fields',
      required: ['agent', 'messages (array)']
    });
  }

  const conv = {
    id: uuidv4(),
    agent: agent,
    session_id: session_id || uuidv4(),
    messages: messages,
    reasoning_chain: reasoning_chain || [],
    summary: summary || null,
    metadata: {
      ...metadata,
      message_count: messages.length,
      reasoning_steps: reasoning_chain ? reasoning_chain.length : 0
    },
    created_at: getCurrentTimestamp()
  };

  conversations.push(conv);
  await saveConversation(conv);

  // Broadcast to 'system' channel
  broadcastToChannel('system', {
    type: 'conversation_saved',
    data: { id: conv.id, agent: conv.agent, message_count: conv.messages.length }
  });

  // Log
  const log = {
    id: uuidv4(),
    project: 'ecosystem',
    agent: agent,
    level: 'INFO',
    message: `Conversation saved: ${conv.messages.length} messages, ${conv.reasoning_chain.length} reasoning steps`,
    timestamp: getCurrentTimestamp()
  };
  logs.push(log);
  await saveLog(log);

  res.status(201).json({
    id: conv.id,
    session_id: conv.session_id,
    message_count: conv.messages.length,
    reasoning_steps: conv.reasoning_chain.length,
    created_at: conv.created_at
  });
});

/**
 * GET /api/memory/conversations
 * Pobierz konwersacje
 * Query: agent?, limit?, offset?
 */
app.get('/api/memory/conversations', (req, res) => {
  const { agent, limit = 20, offset = 0 } = req.query;

  let filtered = conversations;
  if (agent) {
    filtered = filtered.filter(c => c.agent === agent);
  }

  const total = filtered.length;
  const items = filtered.slice(Number(offset), Number(offset) + Number(limit));

  res.json({
    total: total,
    limit: Number(limit),
    offset: Number(offset),
    conversations: items
  });
});

/**
 * GET /api/memory/conversations/:id
 * Pobierz pojedynczą konwersację
 */
app.get('/api/memory/conversations/:id', (req, res) => {
  const conv = conversations.find(c => c.id === req.params.id);
  if (!conv) {
    return res.status(404).json({ error: 'Conversation not found' });
  }
  res.json(conv);
});

/**
 * PATCH /api/memory/conversations/:id
 * Append messages (and optional reasoning steps) to an existing conversation.
 * Body: { messages, reasoning_chain? }
 */
app.patch('/api/memory/conversations/:id', async (req, res) => {
  const conv = conversations.find(c => c.id === req.params.id);
  if (!conv) {
    return res.status(404).json({ error: 'Conversation not found' });
  }

  const { messages, reasoning_chain } = req.body;
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({
      error: 'Missing required field',
      required: ['messages (non-empty array)']
    });
  }

  conv.messages.push(...messages);
  if (Array.isArray(reasoning_chain) && reasoning_chain.length > 0) {
    conv.reasoning_chain = conv.reasoning_chain || [];
    conv.reasoning_chain.push(...reasoning_chain);
  }
  conv.metadata = {
    ...conv.metadata,
    message_count: conv.messages.length,
    reasoning_steps: (conv.reasoning_chain || []).length,
    last_appended_at: getCurrentTimestamp(),
  };

  await saveConversation(conv);

  broadcastToChannel('system', {
    type: 'conversation_appended',
    data: { id: conv.id, agent: conv.agent, message_count: conv.messages.length }
  });

  res.json({
    id: conv.id,
    session_id: conv.session_id,
    message_count: conv.messages.length,
    reasoning_steps: (conv.reasoning_chain || []).length,
    last_appended_at: conv.metadata.last_appended_at
  });
});

/**
 * GET /api/memory/conversations/search
 * Szukaj w konwersacjach (prosty text search)
 * Query: q (required), agent?, limit?
 */
app.get('/api/memory/search', (req, res) => {
  const { q, agent, limit = 10 } = req.query;

  if (!q) {
    return res.status(400).json({ error: 'Missing required query parameter: q' });
  }

  const searchTerm = q.toLowerCase();

  let results = [];

  // Search in conversations
  for (const conv of conversations) {
    if (agent && conv.agent !== agent) continue;

    // Search in messages
    for (const msg of conv.messages) {
      if (msg.content && msg.content.toLowerCase().includes(searchTerm)) {
        results.push({
          type: 'conversation',
          conversation_id: conv.id,
          agent: conv.agent,
          match: msg.content.substring(0, 200),
          created_at: conv.created_at
        });
        break; // One match per conversation
      }
    }

    // Search in reasoning chain
    for (const step of conv.reasoning_chain || []) {
      if ((step.thought && step.thought.toLowerCase().includes(searchTerm)) ||
          (step.conclusion && step.conclusion.toLowerCase().includes(searchTerm))) {
        results.push({
          type: 'reasoning',
          conversation_id: conv.id,
          agent: conv.agent,
          step: step.step,
          match: step.thought || step.conclusion,
          created_at: conv.created_at
        });
        break;
      }
    }
  }

  // Search in training data
  for (const data of trainingData) {
    if (agent && data.metadata?.agent !== agent) continue;

    if ((data.input && data.input.toLowerCase().includes(searchTerm)) ||
        (data.output && data.output.toLowerCase().includes(searchTerm))) {
      results.push({
        type: 'training',
        training_id: data.id,
        data_type: data.type,
        match: (data.input + ' ' + data.output).substring(0, 200),
        created_at: data.created_at
      });
    }
  }

  // Sort by date, limit
  results.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  results = results.slice(0, Number(limit));

  res.json({
    query: q,
    total: results.length,
    results: results
  });
});

/**
 * POST /api/memory/training
 * Zapisz dane treningowe z reasoning
 * Body: { type, goal, reasoning_chain, final_answer, metadata? }
 */
app.post('/api/memory/training', async (req, res) => {
  const { type, goal, instruction, input, output, reasoning_chain, final_answer, metadata, quality } = req.body;

  // Support both simple format (instruction/input/output) and rich format (reasoning_chain)
  if (!type) {
    return res.status(400).json({
      error: 'Missing required field: type',
      valid_types: ['troubleshooting', 'exploration', 'implementation', 'explanation', 'architecture', 'ui_mapping']
    });
  }

  const data = {
    id: uuidv4(),
    type: type,
    goal: goal || instruction,
    instruction: instruction,
    input: input,
    output: output || final_answer,
    reasoning_chain: reasoning_chain || [],
    final_answer: final_answer || output,
    quality: quality || 'draft',  // draft | verified | exported
    metadata: {
      ...metadata,
      reasoning_steps: reasoning_chain ? reasoning_chain.length : 0
    },
    created_at: getCurrentTimestamp()
  };

  trainingData.push(data);
  await saveTrainingData(data);

  // Broadcast
  broadcastToChannel('system', {
    type: 'training_data_saved',
    data: { id: data.id, type: data.type, quality: data.quality }
  });

  res.status(201).json({
    id: data.id,
    type: data.type,
    quality: data.quality,
    reasoning_steps: data.reasoning_chain.length,
    created_at: data.created_at
  });
});

/**
 * GET /api/memory/training
 * Pobierz dane treningowe
 * Query: type?, quality?, limit?, format?
 */
app.get('/api/memory/training', (req, res) => {
  const { type, quality, limit = 50, offset = 0, format } = req.query;

  let filtered = trainingData;

  if (type) {
    filtered = filtered.filter(d => d.type === type);
  }
  if (quality) {
    filtered = filtered.filter(d => d.quality === quality);
  }

  const total = filtered.length;
  const items = filtered.slice(Number(offset), Number(offset) + Number(limit));

  // Export format for fine-tuning
  if (format === 'jsonl') {
    const jsonl = items.map(d => {
      // Format for instruction fine-tuning
      return JSON.stringify({
        instruction: d.instruction || d.goal,
        input: d.input || '',
        output: d.output || d.final_answer,
        reasoning: d.reasoning_chain
      });
    }).join('\n');

    res.setHeader('Content-Type', 'application/jsonl');
    res.setHeader('Content-Disposition', 'attachment; filename=training-data.jsonl');
    return res.send(jsonl);
  }

  res.json({
    total: total,
    limit: Number(limit),
    offset: Number(offset),
    training_data: items
  });
});

/**
 * PATCH /api/memory/training/:id
 * Aktualizuj quality lub inne pola
 */
app.patch('/api/memory/training/:id', async (req, res) => {
  const { quality, tags } = req.body;
  const data = trainingData.find(d => d.id === req.params.id);

  if (!data) {
    return res.status(404).json({ error: 'Training data not found' });
  }

  if (quality) {
    const validQualities = ['draft', 'verified', 'exported', 'rejected'];
    if (!validQualities.includes(quality)) {
      return res.status(400).json({ error: 'Invalid quality', valid: validQualities });
    }
    data.quality = quality;
  }
  if (tags) {
    data.metadata = { ...data.metadata, tags: tags };
  }
  data.updated_at = getCurrentTimestamp();

  await saveTrainingData(data);

  res.json({
    id: data.id,
    quality: data.quality,
    updated_at: data.updated_at
  });
});

/**
 * POST /api/memory/summaries
 * Zapisz session summary
 * Body: { agent, session_id, summary, key_actions?, blockers?, todos?, sentiment? }
 */
app.post('/api/memory/summaries', async (req, res) => {
  const { agent, session_id, summary, key_actions, blockers, todos, sentiment, metadata } = req.body;

  if (!agent || !session_id || !summary) {
    return res.status(400).json({
      error: 'Missing required fields',
      required: ['agent', 'session_id', 'summary']
    });
  }

  const summaryDoc = {
    id: uuidv4(),
    agent: agent,
    session_id: session_id,
    summary: summary,
    key_actions: key_actions || [],
    blockers: blockers || [],
    todos: todos || [],
    sentiment: sentiment || 'neutral',
    metadata: metadata || {},
    timestamp: getCurrentTimestamp()
  };

  summaries.push(summaryDoc);
  await saveSummary(summaryDoc);

  // Auto-embed to ChromaDB (semantic-search)
  try {
    const embedText = `Agent: ${agent}\nSummary: ${summary}\nActions: ${(key_actions || []).join(', ')}`;
    const response = await fetch(`${process.env.SEMANTIC_SEARCH_URL || 'http://localhost:3037'}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        collection: 'session_summaries',
        id: summaryDoc.id,
        text: embedText,
        metadata: {
          agent: agent,
          session_id: session_id,
          timestamp: summaryDoc.timestamp,
          sentiment: sentiment || 'neutral'
        }
      })
    });

    if (!response.ok) {
      console.error('Failed to embed summary to ChromaDB:', await response.text());
    } else {
      console.log(`✅ Summary embedded to ChromaDB: ${summaryDoc.id}`);
    }
  } catch (error) {
    console.error('Error embedding summary:', error);
  }

  // Broadcast
  broadcastToChannel('system', {
    type: 'summary_saved',
    data: { id: summaryDoc.id, agent: summaryDoc.agent, session_id: summaryDoc.session_id }
  });

  // Log
  const log = {
    id: uuidv4(),
    project: 'ecosystem',
    agent: agent,
    level: 'INFO',
    message: `Summary saved for session ${session_id.substring(0, 8)}...`,
    timestamp: getCurrentTimestamp()
  };
  logs.push(log);
  await saveLog(log);

  res.status(201).json({
    id: summaryDoc.id,
    agent: summaryDoc.agent,
    session_id: summaryDoc.session_id,
    timestamp: summaryDoc.timestamp,
    embedded: true
  });
});

/**
 * GET /api/memory/summaries
 * Pobierz session summaries
 * Query: agent?, session_id?, limit?, offset?
 */
app.get('/api/memory/summaries', (req, res) => {
  const { agent, session_id, limit = 20, offset = 0 } = req.query;

  let filtered = summaries;

  if (agent) {
    filtered = filtered.filter(s => s.agent === agent);
  }
  if (session_id) {
    filtered = filtered.filter(s => s.session_id === session_id);
  }

  const total = filtered.length;
  const items = filtered.slice(Number(offset), Number(offset) + Number(limit));

  res.json({
    total: total,
    limit: Number(limit),
    offset: Number(offset),
    summaries: items
  });
});

/**
 * GET /api/memory/summaries/:id
 * Pobierz pojedynczy summary
 */
app.get('/api/memory/summaries/:id', (req, res) => {
  const summary = summaries.find(s => s.id === req.params.id);
  if (!summary) {
    return res.status(404).json({ error: 'Summary not found' });
  }
  res.json(summary);
});

/**
 * GET /api/memory/stats
 * Statystyki pamięci i danych treningowych
 */
app.get('/api/memory/stats', (req, res) => {
  const convsByAgent = {};
  for (const c of conversations) {
    convsByAgent[c.agent] = (convsByAgent[c.agent] || 0) + 1;
  }

  const trainingByType = {};
  const trainingByQuality = {};
  let totalReasoningSteps = 0;

  for (const d of trainingData) {
    trainingByType[d.type] = (trainingByType[d.type] || 0) + 1;
    trainingByQuality[d.quality] = (trainingByQuality[d.quality] || 0) + 1;
    totalReasoningSteps += d.reasoning_chain?.length || 0;
  }

  res.json({
    conversations: {
      total: conversations.length,
      by_agent: convsByAgent,
      total_messages: conversations.reduce((sum, c) => sum + c.messages.length, 0)
    },
    training_data: {
      total: trainingData.length,
      by_type: trainingByType,
      by_quality: trainingByQuality,
      total_reasoning_steps: totalReasoningSteps,
      ready_for_export: trainingData.filter(d => d.quality === 'verified').length
    }
  });
});


/**
 * POST /api/notes
 * Create new note
 * Body: { agent, type, title, content, tags?, visibility?, expires_at? }
 * type: observation | decision | blocker | idea | handoff
 */
app.post('/api/notes', async (req, res) => {
  const { agent, type, title, content, tags, visibility, expires_at, metadata } = req.body;

  if (!agent || !type || !title) {
    return res.status(400).json({
      error: 'Missing required fields',
      required: ['agent', 'type', 'title']
    });
  }

  const validTypes = ['observation', 'decision', 'blocker', 'idea', 'handoff', 'session_end'];
  if (!validTypes.includes(type)) {
    return res.status(400).json({
      error: 'Invalid type',
      valid_types: validTypes
    });
  }

  const note = {
    id: uuidv4(),
    agent: agent,
    type: type,
    title: title,
    content: content || '',
    tags: tags || [],
    visibility: visibility || 'all', // all, agents, operator
    metadata: metadata || null,
    expires_at: expires_at || null,
    created_at: getCurrentTimestamp(),
    updated_at: getCurrentTimestamp()
  };

  notes.push(note);
  await saveNote(note);

  // Broadcast to WebSocket
  broadcastToWs({ type: 'note_created', data: note });

  res.status(201).json({
    note_id: note.id,
    created_at: note.created_at
  });
});

/**
 * GET /api/notes
 * Get notes with filters
 * Query: agent?, type?, tag?, limit?, since?
 */
app.get('/api/notes', (req, res) => {
  const { agent, type, tag, limit, since } = req.query;
  const maxLimit = parseInt(limit) || 50;

  let filtered = [...notes];

  if (agent) {
    filtered = filtered.filter(n => n.agent === agent);
  }
  if (type) {
    filtered = filtered.filter(n => n.type === type);
  }
  if (tag) {
    filtered = filtered.filter(n => n.tags && n.tags.includes(tag));
  }
  if (since) {
    const sinceDate = new Date(since);
    filtered = filtered.filter(n => new Date(n.created_at) > sinceDate);
  }

  // Filter out expired notes
  const now = new Date();
  filtered = filtered.filter(n => !n.expires_at || new Date(n.expires_at) > now);

  // Sort by created_at descending (newest first)
  filtered.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  res.json({
    total: filtered.length,
    notes: filtered.slice(0, maxLimit)
  });
});

/**
 * GET /api/notes/recent
 * Get notes from last 24 hours
 */
app.get('/api/notes/recent', (req, res) => {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  
  const recentNotes = notes.filter(n => 
    new Date(n.created_at) > yesterday &&
    (!n.expires_at || new Date(n.expires_at) > new Date())
  );

  res.json({
    total: recentNotes.length,
    notes: recentNotes
  });
});

/**
 * GET /api/notes/:id
 * Get specific note
 */
app.get('/api/notes/:id', (req, res) => {
  const note = notes.find(n => n.id === req.params.id);
  if (!note) {
    return res.status(404).json({ error: 'Note not found' });
  }
  res.json(note);
});

/**
 * DELETE /api/notes/:id
 * Delete note
 */
app.delete('/api/notes/:id', async (req, res) => {
  const noteId = req.params.id;
  const note = notes.find(n => n.id === noteId);

  if (!note) {
    return res.status(404).json({ error: 'Note not found' });
  }

  notes = notes.filter(n => n.id !== noteId);
  await deleteNote(noteId);

  res.json({
    success: true,
    message: 'Note deleted',
    note_id: noteId
  });
});

// ============================================================================
// BRIEFING API (What happened while agent was offline)
// ============================================================================

/**
 * GET /api/briefing/:agent
 * Get briefing for agent - what happened while they were offline
 */
app.get('/api/briefing/:agent', (req, res) => {
  const agentName = req.params.agent.toUpperCase();
  const hours = parseInt(req.query.hours) || 24;
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);

  // Find agent's last heartbeat
  const agent = findAgentByName(agentName);
  const lastSeen = agent ? new Date(agent.last_heartbeat) : since;
  const hoursOffline = agent ? Math.floor((Date.now() - lastSeen) / (1000 * 60 * 60)) : hours;

  // Tasks created for this agent while offline
  const tasksForAgent = tasks.filter(t =>
    t.assigned_to === agentName &&
    new Date(t.created_at) > lastSeen
  );

  // Tasks completed by other agents
  const tasksCompletedByOthers = tasks.filter(t =>
    t.assigned_to !== agentName &&
    t.status === 'DONE' &&
    t.completed_at &&
    new Date(t.completed_at) > lastSeen
  );

  // Chat mentions for this agent
  const chatMentions = chatMessages.filter(m =>
    (m.mentions.includes(agentName) || m.mentions.includes('ALL')) &&
    m.from !== agentName &&
    new Date(m.timestamp) > lastSeen
  );

  // Notes created while offline
  const recentNotes = notes.filter(n =>
    new Date(n.created_at) > lastSeen &&
    (!n.expires_at || new Date(n.expires_at) > new Date())
  );

  // Session summaries (handoff notes)
  const handoffs = notes.filter(n =>
    n.type === 'session_end' || n.type === 'handoff' &&
    new Date(n.created_at) > lastSeen
  );

  // Active agents right now
  const now = new Date();
  const activeAgents = agents
    .filter(a => {
      const lastHB = new Date(a.last_heartbeat);
      return (now - lastHB) / 1000 < 120 && a.name !== agentName;
    })
    .map(a => a.name);

  // Pending tasks for this agent
  const pendingTasks = tasks.filter(t =>
    t.assigned_to === agentName && t.status === 'PENDING'
  );

  // Build priorities list
  const priorities = [];
  
  // Urgent tasks first
  pendingTasks
    .filter(t => t.priority === 'URGENT' || t.priority === 'HIGH')
    .forEach(t => priorities.push(`[${t.priority}] Task: ${t.title}`));
  
  // Important notes
  recentNotes
    .filter(n => n.type === 'blocker' || n.type === 'decision')
    .forEach(n => priorities.push(`[${n.type.toUpperCase()}] ${n.title}`));
  
  // Chat mentions
  if (chatMentions.length > 0) {
    priorities.push(`${chatMentions.length} unread chat mention(s)`);
  }

  res.json({
    agent: agentName,
    last_seen: lastSeen.toISOString(),
    hours_offline: hoursOffline,
    generated_at: getCurrentTimestamp(),

    while_you_were_away: {
      tasks_created_for_you: tasksForAgent.length,
      tasks_completed_by_others: tasksCompletedByOthers.length,
      chat_mentions: chatMentions.length,
      notes_created: recentNotes.length,
      handoffs: handoffs.length
    },

    current_state: {
      your_pending_tasks: pendingTasks.length,
      active_agents: activeAgents,
      system_health: 'ok'
    },

    priorities: priorities.slice(0, 10),

    details: {
      new_tasks: tasksForAgent.map(t => ({
        id: t.id,
        title: t.title,
        priority: t.priority,
        created_by: t.created_by
      })),
      chat_mentions: chatMentions.slice(-10).map(m => ({
        from: m.from,
        content: m.content.substring(0, 100),
        timestamp: m.timestamp
      })),
      recent_notes: recentNotes.slice(0, 5).map(n => ({
        agent: n.agent,
        type: n.type,
        title: n.title,
        created_at: n.created_at
      })),
      handoffs: handoffs.map(h => ({
        agent: h.agent,
        title: h.title,
        content: h.content,
        created_at: h.created_at
      }))
    }
  });
});

// ============================================================================
// SESSIONS API (Session summaries for handoff)
// ============================================================================

/**
 * POST /api/sessions/end
 * Record session end summary (creates a note of type session_end)
 * Body: { agent, summary, blockers?, next_steps?, handoff_to? }
 */
app.post('/api/sessions/end', async (req, res) => {
  const { agent, summary, blockers, next_steps, handoff_to } = req.body;

  if (!agent || !summary) {
    return res.status(400).json({
      error: 'Missing required fields',
      required: ['agent', 'summary']
    });
  }

  const note = {
    id: uuidv4(),
    agent: agent,
    type: 'session_end',
    title: `${agent} session ended`,
    content: summary,
    tags: ['session', 'handoff'],
    visibility: 'all',
    metadata: {
      blockers: blockers || [],
      next_steps: next_steps || [],
      handoff_to: handoff_to || null
    },
    expires_at: null, // Session summaries don't expire
    created_at: getCurrentTimestamp(),
    updated_at: getCurrentTimestamp()
  };

  notes.push(note);
  await saveNote(note);

  // Broadcast to WebSocket
  broadcastToWs({ type: 'session_ended', data: note });

  // If handoff specified, create a task notification
  if (handoff_to) {
    broadcastToWs({
      type: 'handoff',
      data: {
        from: agent,
        to: handoff_to,
        summary: summary,
        next_steps: next_steps
      }
    });
  }

  res.status(201).json({
    success: true,
    note_id: note.id,
    message: `Session summary recorded for ${agent}`
  });
});

/**
 * GET /api/sessions/latest
 * Get latest session summaries from all agents
 */
app.get('/api/sessions/latest', (req, res) => {
  const sessionNotes = notes.filter(n => n.type === 'session_end');
  
  // Get latest session for each agent
  const latestByAgent = {};
  sessionNotes.forEach(n => {
    if (!latestByAgent[n.agent] || 
        new Date(n.created_at) > new Date(latestByAgent[n.agent].created_at)) {
      latestByAgent[n.agent] = n;
    }
  });

  res.json({
    sessions: Object.values(latestByAgent)
  });
});

// ERROR HANDLING
// ============================================================================


// ============================================================================
// TRANSCRIPTS API
// ============================================================================

/**
 * GET /api/transcripts
 * List all transcripts
 */
app.get("/api/transcripts", (req, res) => {
  const transcriptsDir = path.join(process.env.HOME, "project-memory/transcripts");
  
  try {
    if (!fs.existsSync(transcriptsDir)) {
      return res.json({ transcripts: [] });
    }
    
    const files = fs.readdirSync(transcriptsDir)
      .filter(f => f.endsWith(".md"))
      .map(f => ({
        filename: f,
        path: path.join(transcriptsDir, f),
        size: fs.statSync(path.join(transcriptsDir, f)).size,
        modified: fs.statSync(path.join(transcriptsDir, f)).mtime
      }))
      .sort((a, b) => new Date(b.modified) - new Date(a.modified));
    
    res.json({ transcripts: files });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/transcripts/:filename
 * Get transcript content
 */
app.get("/api/transcripts/:filename", (req, res) => {
  const { filename } = req.params;
  const transcriptsDir = path.join(process.env.HOME, "project-memory/transcripts");
  const filepath = path.join(transcriptsDir, filename);
  
  // Security: prevent path traversal
  if (!filepath.startsWith(transcriptsDir)) {
    return res.status(403).json({ error: "Access denied" });
  }
  
  try {
    if (!fs.existsSync(filepath)) {
      return res.status(404).json({ error: "Transcript not found" });
    }
    
    const content = fs.readFileSync(filepath, "utf-8");
    res.json({ 
      filename,
      content,
      size: content.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ============================================================================
// DAEMONS API (Workers & Watchers)
// ============================================================================

let daemons = [];

/**
 * POST /api/daemons/heartbeat
 * Register/update daemon heartbeat
 * Body: { name, type, agent, status?, metadata? }
 * type: "worker" | "watcher"
 */
app.post("/api/daemons/heartbeat", (req, res) => {
  const { name, type, agent, status, metadata } = req.body;
  
  if (!name || !type || !agent) {
    return res.status(400).json({ error: "Missing required fields: name, type, agent" });
  }
  
  const validTypes = ["worker", "watcher"];
  if (!validTypes.includes(type)) {
    return res.status(400).json({ error: "Invalid type. Use: worker or watcher" });
  }
  
  const existing = daemons.find(d => d.name === name);
  const now = getCurrentTimestamp();
  
  if (existing) {
    existing.last_heartbeat = now;
    existing.status = status || existing.status || "running";
    if (metadata) existing.metadata = { ...existing.metadata, ...metadata };
  } else {
    daemons.push({
      name,
      type,
      agent,
      status: status || "running",
      metadata: metadata || {},
      registered_at: now,
      last_heartbeat: now
    });
  }
  
  res.json({ success: true, daemon: name, heartbeat: now });
});

/**
 * GET /api/daemons
 * List all daemons with online status
 */
app.get("/api/daemons", (req, res) => {
  const now = new Date();
  const TIMEOUT_SECONDS = 120; // 2 minutes
  
  const result = daemons.map(d => {
    const lastHB = new Date(d.last_heartbeat);
    const secondsAgo = Math.floor((now - lastHB) / 1000);
    const online = secondsAgo < TIMEOUT_SECONDS;
    
    return {
      ...d,
      online,
      seconds_since_heartbeat: secondsAgo
    };
  });
  
  res.json({ daemons: result });
});

/**
 * GET /api/daemons/:agent
 * Get daemons for specific agent
 */
app.get("/api/daemons/:agent", (req, res) => {
  const { agent } = req.params;
  const now = new Date();
  const TIMEOUT_SECONDS = 120;
  
  const agentDaemons = daemons
    .filter(d => d.agent === agent)
    .map(d => {
      const lastHB = new Date(d.last_heartbeat);
      const secondsAgo = Math.floor((now - lastHB) / 1000);
      return {
        ...d,
        online: secondsAgo < TIMEOUT_SECONDS,
        seconds_since_heartbeat: secondsAgo
      };
    });
  
  res.json({ agent, daemons: agentDaemons });
});

// ============================================================================
// CHAT API (Real-time messaging between agents)
// ============================================================================

async function saveChatMessage(msg) {
  const TTL_1_DAY = 24 * 3600;
  await redisClient.setEx(`chat:${msg.id}`, TTL_1_DAY, JSON.stringify(msg));
}

async function loadChatFromRedis() {
  const chatKeys = await redisClient.keys("chat:*");
  chatMessages = [];
  for (const key of chatKeys) {
    const data = await redisClient.get(key);
    if (data) chatMessages.push(JSON.parse(data));
  }
  chatMessages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  console.log(`📨 Loaded ${chatMessages.length} chat messages from Redis`);
}

function extractMentions(content) {
  const matches = content.match(/@(worker1|agent2|coord|all)/gi) || [];
  return [...new Set(matches.map(m => m.toUpperCase().replace("@", "")))];
}

/**
 * GET /api/chat
 * Get recent chat messages
 * Query: limit (default 50), since (ISO timestamp)
 */
app.get("/api/chat", (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const since = req.query.since;
  
  let messages = [...chatMessages];
  
  if (since) {
    const sinceDate = new Date(since);
    messages = messages.filter(m => new Date(m.timestamp) > sinceDate);
  }
  
  // Return latest messages
  messages = messages.slice(-limit);
  
  res.json({ 
    messages,
    total: messages.length
  });
});

/**
 * POST /api/chat
 * Send chat message
 * Body: { from, content }
 */
app.post("/api/chat", async (req, res) => {
  const { from, content } = req.body;

  // Rate limit check for chat messages (2026-01-14)
  const chatRateLimitError = checkRateLimit(from || req.agentName, 'chatMessages');
  if (chatRateLimitError) {
    console.log(`[RATE-LIMIT] Agent ${from || req.agentName} exceeded chat message limit`);
    return res.status(429).json(chatRateLimitError);
  }
  
  if (!from || !content) {
    return res.status(400).json({ error: "Missing required fields: from, content" });
  }
  
  const msg = {
    id: uuidv4(),
    from: from,
    content: content,
    mentions: extractMentions(content),
    timestamp: getCurrentTimestamp()
  };
  
  chatMessages.push(msg);
  await saveChatMessage(msg);
  recordRateLimitAction(msg.from || req.agentName, 'chatMessages'); // Rate limit tracking
  
  // Broadcast to WebSocket clients
  broadcastToWs({ type: "chat", data: msg });
  
  // Also publish to Redis for external subscribers
  redisClient.publish("cs:chat", JSON.stringify({
    type: "chat_message",
    data: msg
  })).catch(err => console.error("Redis publish error:", err));
  
  // Redis Agent Bus - notify mentioned agents
  notifyMentionedAgents(msg);
  res.status(201).json({ 
    message_id: msg.id,
    timestamp: msg.timestamp,
    mentions: msg.mentions
  });
});

/**
 * GET /api/chat/mentions/:agent
 * Get messages mentioning specific agent
 */
app.get("/api/chat/mentions/:agent", (req, res) => {
  const agent = req.params.agent.toUpperCase();
  const limit = parseInt(req.query.limit) || 20;
  const unread = req.query.unread === "true";
  
  let messages = chatMessages.filter(m => 
    m.mentions.includes(agent) || m.mentions.includes("ALL")
  );
  
  // Return latest
  messages = messages.slice(-limit);
  
  res.json({
    agent,
    messages,
    total: messages.length
  });
});


/**
 * GET /api/ws/clients
 * Get connected WebSocket clients
 */
app.get("/api/ws/clients-status", (req, res) => {
  const clients = [];
  wsClients.forEach((info, ws) => {
    clients.push({
      agent: info.agent,
      connected_at: info.connected_at,
      state: ws.readyState === 1 ? "open" : "closed"
    });
  });
  res.json({ clients, total: clients.length });
});

// ============================================================================
// SYSTEM API (File tree, systemd services, ports)
// ============================================================================

const { exec, execFile } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const execFilePromise = util.promisify(execFile);

// systemd unit names: letters, digits, and the small set of separators
// that systemctl considers part of a valid unit identifier. Anything
// outside this set is refused rather than passed to execFile.
const SYSTEMD_UNIT_RE = /^[a-zA-Z0-9._@:-]+$/;

/**
 * GET /api/system/tree
 * Scan /opt/ecosystem/ directory tree
 */
app.get("/api/system/tree", async (req, res) => {
  try {
    const basePath = '/opt/ecosystem';

    function scanDirectory(dirPath) {
      const entries = [];
      const items = fs.readdirSync(dirPath, { withFileTypes: true });

      for (const item of items) {
        if (item.name === 'node_modules' || item.name === '.git') continue;

        const fullPath = path.join(dirPath, item.name);
        const relativePath = fullPath.replace(basePath, '');

        if (item.isDirectory()) {
          entries.push({
            name: item.name,
            type: 'directory',
            path: relativePath,
            children: scanDirectory(fullPath)
          });
        } else {
          const ext = path.extname(item.name);
          entries.push({
            name: item.name,
            type: 'file',
            path: relativePath,
            extension: ext,
            size: fs.statSync(fullPath).size
          });
        }
      }

      return entries.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    }

    const tree = {
      name: 'mcp',
      type: 'directory',
      path: '/',
      children: scanDirectory(basePath)
    };

    res.json({ tree });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/system/services
 * Get all systemd user services status
 */
app.get("/api/system/services", async (req, res) => {
  try {
    const { stdout } = await execPromise('systemctl --user list-units --type=service --all --no-pager --output=json');
    const services = JSON.parse(stdout);

    const ecosystemServices = services.filter(s =>
      s.unit.includes('consciousness') ||
      s.unit.includes('websocket') ||
      s.unit.includes('dashboard') ||
      s.unit.includes('cleanup') ||
      s.unit.includes('skills')
    );

    const detailedServices = [];
    for (const svc of ecosystemServices) {
      const name = svc.unit;

      if (!SYSTEMD_UNIT_RE.test(name)) {
        // Skip units with names we consider unsafe to shell out for.
        continue;
      }
      let enabled = 'disabled';
      try {
        const { stdout: statusOut } = await execFilePromise('systemctl', ['--user', 'is-enabled', name]);
        enabled = statusOut.trim();
      } catch (err) {
        // systemctl exits non-zero for disabled/static/masked — that is
        // expected, the catch keeps `enabled = 'disabled'`.
      }

      detailedServices.push({
        name: name,
        active: svc.active === 'active',
        enabled: enabled === 'enabled',
        state: svc.sub,
        description: svc.description
      });
    }

    res.json({ services: detailedServices });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/system/services/:name/:action
 * Control systemd service (start/stop/restart/enable/disable)
 */
app.post("/api/system/services/:name/:action", async (req, res) => {
  const { name, action } = req.params;

  const validActions = ['start', 'stop', 'restart', 'enable', 'disable'];
  if (!validActions.includes(action)) {
    return res.status(400).json({ error: `Invalid action. Must be one of: ${validActions.join(', ')}` });
  }

  if (!SYSTEMD_UNIT_RE.test(name)) {
    return res.status(400).json({ error: 'Invalid service name' });
  }

  try {
    const { stdout, stderr } = await execFilePromise('systemctl', ['--user', action, name]);

    res.json({
      success: true,
      service: name,
      action: action,
      output: stdout || stderr
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      service: name,
      action: action,
      error: error.message
    });
  }
});

/**
 * GET /api/system/ports
 * Get ports configuration from ports.json
 */
app.get("/api/system/ports", (req, res) => {
  try {
    const portsPath = '/opt/ecosystem/config/ports.json';
    const portsData = fs.readFileSync(portsPath, 'utf8');
    const ports = JSON.parse(portsData);

    res.json(ports);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/system/services/:name/logs
 * Get logs for a specific systemd service
 * Query params: lines (default 50)
 */
app.get("/api/system/services/:name/logs", async (req, res) => {
  const { name } = req.params;
  const lines = parseInt(req.query.lines) || 50;

  try {
    const { stdout } = await execPromise(
      `journalctl --user -u ${name} -n ${lines} --no-pager --output=short-iso`
    );

    const logLines = stdout.split('\n').filter(line => line.trim());

    res.json({
      service: name,
      lines: logLines,
      count: logLines.length,
      requested: lines
    });
  } catch (error) {
    res.status(500).json({
      error: error.message,
      service: name
    });
  }
});

/**
 * GET /api/ws/clients
 * Get connected WebSocket clients with their subscriptions
 */
app.get("/api/ws/clients", (req, res) => {
  const clients = [];
  wsClients.forEach((info, ws) => {
    clients.push({
      agent: info.agent,
      connected_at: info.connected_at,
      channels: Array.from(info.channels),
      state: ws.readyState === 1 ? "open" : "closed"
    });
  });
  res.json({
    clients,
    total: clients.length,
    available_channels: WS_CHANNELS
  });
});


// ============================================================================
// IDENTITY SERVER
// ============================================================================

let agentTokens = {};
let agentIdentities = {};

app.post("/api/identity/login", (req, res) => {
  const { agent_id, agent_name, machine_id, capabilities, role, style, allowed_machines } = req.body;
  if (!agent_id) return res.status(400).json({ error: "agent_id required" });
  const token = "token-" + agent_id + "-" + Date.now();
  agentTokens[token] = { agent_id, agent_name: agent_name || agent_id, machine_id: machine_id || "unknown", created_at: new Date().toISOString(), last_used: new Date().toISOString() };
  agentIdentities[agent_id] = { name: agent_name || agent_id, machine_id: machine_id || "unknown", capabilities: capabilities || [], role: role || "worker", style: style || "", allowed_machines: allowed_machines || [], created_at: agentIdentities[agent_id]?.created_at || new Date().toISOString(), last_login: new Date().toISOString() };
  res.json({ success: true, token, agent_id, message: "Agent logged in", session: agentTokens[token] });
});

app.get("/api/identity/agents", (req, res) => {
  const agents = Object.entries(agentIdentities).map(([id, data]) => ({ agent_id: id, ...data }));
  res.json({ total: agents.length, agents });
});

app.get("/api/identity/:agent_id", (req, res) => {
  const agent_id = req.params.agent_id;
  const identity = agentIdentities[agent_id];
  if (!identity) return res.status(404).json({ error: "Agent not found" });
  res.json({ agent_id, ...identity });
});

app.post("/api/identity/whoami", (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: "Token required" });
  const session = agentTokens[token];
  if (!session) return res.status(401).json({ error: "Invalid token" });
  agentTokens[token].last_used = new Date().toISOString();
  res.json({ agent_id: session.agent_id, identity: agentIdentities[session.agent_id], session });
});

// A2A Protocol
let a2aMessages = [];

app.post("/api/a2a/send", (req, res) => {
  const { from_agent, to_agent, message_type, payload, priority, requires_ack } = req.body;
  if (!from_agent || !to_agent || !message_type) return res.status(400).json({ error: "Missing required fields" });
  const message = { id: require("crypto").randomUUID(), from_agent, to_agent, message_type, payload: payload || {}, priority: priority || "normal", requires_ack: requires_ack || false, status: "pending", created_at: new Date().toISOString() };
  a2aMessages.push(message);
  res.json({ success: true, message_id: message.id, status: "queued" });
});

app.get("/api/a2a/inbox/:agent", (req, res) => {
  const agent = req.params.agent.toUpperCase();
  let messages = a2aMessages.filter(m => m.to_agent.toUpperCase() === agent && m.status === "pending");
  messages.forEach(m => { m.status = "delivered"; m.delivered_at = new Date().toISOString(); });
  res.json({ agent, messages, count: messages.length });
});

app.post("/api/a2a/ack/:message_id", (req, res) => {
  const msg = a2aMessages.find(m => m.id === req.params.message_id);
  if (!msg) return res.status(404).json({ error: "Message not found" });
  const { agent } = req.body;
  if (agent && msg.to_agent.toUpperCase() !== agent.toUpperCase()) return res.status(403).json({ error: "Not authorized" });
  msg.status = "acked"; msg.acked_at = new Date().toISOString();
  res.json({ success: true, message_id: msg.id, status: "acked" });
});

app.get("/api/a2a/stats", (req, res) => {
  res.json({ total_messages: a2aMessages.length, by_status: { pending: a2aMessages.filter(m => m.status === "pending").length, delivered: a2aMessages.filter(m => m.status === "delivered").length, acked: a2aMessages.filter(m => m.status === "acked").length } });
});


// ============================================================================
// AGENTS + SKILLS — loaded from repo-root /agents/*.md and /skills/*.md
// (bind-mounted read-only into the container at /data/agents and /data/skills).
// Single source of truth. Operator edits via git, not HTTP.
// ============================================================================

const AGENTS_DIR = process.env.AGENTS_DIR || "/opt/ecosystem/agents";
const SKILLS_DIR = process.env.SKILLS_DIR || "/opt/ecosystem/skills";

// Identifiers safe to interpolate into a file path: lowercase/uppercase
// letters, digits, underscore, dash. Rejects dots, slashes, anything exotic.
const RESOURCE_NAME_RE = /^[a-zA-Z0-9_-]+$/;

// Load all agent character profiles from AGENTS_DIR. Each *.md is one
// agent. The filename (without extension) is the agent id, uppercased;
// the file body is the claude_md served verbatim.
function loadAgentsFromDir() {
  const configs = {};
  try {
    const files = fs.readdirSync(AGENTS_DIR).filter(f => f.endsWith(".md"));
    for (const file of files) {
      try {
        const agent = path.basename(file, ".md").toUpperCase();
        const claude_md = fs.readFileSync(path.join(AGENTS_DIR, file), "utf8");
        if (claude_md.trim().length > 0) {
          configs[agent] = claude_md;
        }
      } catch (e) {
        console.error(`Error loading agent ${file}:`, e.message);
      }
    }
    console.log(`Loaded ${Object.keys(configs).length} agents from ${AGENTS_DIR}`);
  } catch (e) {
    console.error("Error reading agents directory:", e.message);
  }
  return configs;
}

let claudeMdConfigs = loadAgentsFromDir();

// NOTE: list route MUST be registered before the :agent route.
// Express matches in registration order; with :agent first, a GET on
// `/api/identity/claude-md` would fall through to the :agent handler
// with an undefined param and return 404 instead of the list.
app.get("/api/identity/claude-md", (req, res) => {
  claudeMdConfigs = loadAgentsFromDir(); // Reload — operator may have dropped new profiles.
  res.json({ agents: Object.keys(claudeMdConfigs), total: Object.keys(claudeMdConfigs).length });
});

app.get("/api/identity/claude-md/:agent", (req, res) => {
  const agent = req.params.agent.toUpperCase();
  const config = claudeMdConfigs[agent];
  if (!config) {
    // Try reload from disk — operator may have dropped a new profile.
    claudeMdConfigs = loadAgentsFromDir();
    const reloaded = claudeMdConfigs[agent];
    if (!reloaded) {
      return res.status(404).json({ error: "Agent not found", available: Object.keys(claudeMdConfigs) });
    }
    return res.json({ agent, claude_md: reloaded, updated_at: new Date().toISOString() });
  }
  res.json({ agent, claude_md: config, updated_at: new Date().toISOString() });
});

// ----------------------------------------------------------------------------
// Skills — served from SKILLS_DIR (bind mount of repo-root /skills/*.md).
// ----------------------------------------------------------------------------

app.get("/api/skills", (req, res) => {
  try {
    const files = fs.readdirSync(SKILLS_DIR).filter(f => f.endsWith(".md"));
    const skills = files.map(f => ({ name: path.basename(f, ".md") }));
    res.json({ skills, count: skills.length });
  } catch (err) {
    res.status(500).json({ error: "skills_dir_unreadable", detail: err.message });
  }
});

app.get("/api/skills/:name", (req, res) => {
  const name = req.params.name;
  if (!RESOURCE_NAME_RE.test(name)) {
    return res.status(400).json({ error: "invalid_skill_name" });
  }
  const filePath = path.join(SKILLS_DIR, `${name}.md`);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "skill_not_found", name });
  }
  res.json({ name, content: fs.readFileSync(filePath, "utf8") });
});

// Global agent card
app.get("/.well-known/agent.json", (req, res) => {
  res.json({
    name: "Ecosystem Agent Network",
    description: "Multi-agent AI development system",
    url: "http://127.0.0.1:3032",
    version: "1.0.0",
    capabilities: ["task-management", "chat", "notes", "a2a-protocol"],
    agents: Object.keys(claudeMdConfigs),
    endpoints: { health: "/health", agents: "/api/identity/agents", tasks: "/api/tasks", chat: "/api/chat" }
  });
});


// A2A Card per agent
app.get("/api/identity/card/:agent", (req, res) => {
  const agentId = req.params.agent.toUpperCase();
  const identity = agentIdentities[agentId] || {};
  const claudeMd = claudeMdConfigs[agentId] || "";
  
  res.json({
    name: agentId,
    description: identity.description || identity.role || "AI Agent",
    identifier: agentId,
    version: "1.0.0",
    capabilities: identity.capabilities || [],
    role: identity.role || "worker",
    machine: identity.machine_id || "unknown",
    status: identity.last_login ? "registered" : "unregistered",
    endpoints: { chat: "/api/chat", tasks: "/api/tasks", a2a: "/api/a2a/send" },
    claude_md_preview: claudeMd.substring(0, 200),
    registered_at: identity.created_at || null,
    last_seen: identity.last_login || null
  });
});

app.put("/api/identity/card/:agent", (req, res) => {
  const agentId = req.params.agent.toUpperCase();
  const { description, capabilities } = req.body;
  if (agentIdentities[agentId]) {
    if (description) agentIdentities[agentId].description = description;
    if (capabilities) agentIdentities[agentId].capabilities = capabilities;
  }
  res.json({ success: true, agent: agentId });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    path: req.path,
    message: 'Endpoint does not exist. Check /health for server status.'
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({
    error: 'Internal Server Error',
    message: err.message
  });
});

// ============================================================================

// ============================================================================
// WEBSOCKET SERVER (with CHANNELS support)
// ============================================================================

// Available channels for pub/sub
const WS_CHANNELS = ['chat', 'notes', 'tasks', 'system', 'agents'];

const wsClients = new Map(); // ws -> { agent, connected_at, channels: Set }

/**
 * Broadcast to WebSocket clients subscribed to specific channel
 * @param {string} channel - Channel name (chat, notes, tasks, system, agents)
 * @param {object} data - Data to send (will be wrapped with channel info)
 * @param {WebSocket} exceptWs - Optional: exclude this client
 */
function broadcastToChannel(channel, data, exceptWs = null) {
  const msg = JSON.stringify({
    channel: channel,
    ...data
  });

  let sent = 0;
  wsClients.forEach((info, ws) => {
    if (ws !== exceptWs && ws.readyState === 1) {
      // Send if subscribed to this channel OR subscribed to '*' (all)
      if (info.channels.has(channel) || info.channels.has('*')) {
        ws.send(msg);
        sent++;
      }
    }
  });

  if (sent > 0) {
    console.log(`[WS] Broadcast to '${channel}': ${sent} client(s)`);
  }
}

// Legacy function for backward compatibility - auto-detects channel from data type
function broadcastToWs(data, exceptWs = null) {
  let channel = 'system';
  if (data.type && data.type.includes('chat')) channel = 'chat';
  else if (data.type && data.type.includes('note')) channel = 'notes';
  else if (data.type && data.type.includes('task')) channel = 'tasks';
  else if (data.type && data.type.includes('agent')) channel = 'agents';

  broadcastToChannel(channel, data, exceptWs);
}

function setupWebSocket(server) {
  const wss = new WebSocketServer({ server });

  wss.on("connection", (ws, req) => {
    // Agent connects with ws://host:3032/<agent-name>
    const agent = req.url.replace("/", "") || "Dashboard";

    // Default: subscribe to all channels (*)
    wsClients.set(ws, {
      agent,
      connected_at: getCurrentTimestamp(),
      channels: new Set(['*'])
    });
    console.log(`[WS] ${agent} connected (${wsClients.size} total clients)`);

    // Send welcome message with available channels
    ws.send(JSON.stringify({
      type: "connected",
      agent,
      message: "Connected to Consciousness Server",
      available_channels: WS_CHANNELS,
      subscribed: ['*']
    }));

    ws.on("message", async (data) => {
      try {
        const msg = JSON.parse(data);
        await handleWsMessage(ws, msg);
      } catch (e) {
        ws.send(JSON.stringify({ type: "error", error: "Invalid JSON" }));
      }
    });

    ws.on("close", () => {
      const info = wsClients.get(ws);
      wsClients.delete(ws);
      console.log(`[WS] ${info ? info.agent : "unknown"} disconnected`);
    });

    ws.on("error", (err) => {
      const info = wsClients.get(ws);
      console.error(`[WS] Error for ${info ? info.agent : 'unknown'}:`, err.message);
    });
  });

  return wss;
}

async function handleWsMessage(ws, msg) {
  const clientInfo = wsClients.get(ws);
  const agent = clientInfo ? clientInfo.agent : "unknown";

  // Handle channel subscription
  if (msg.action === 'subscribe') {
    const channels = Array.isArray(msg.channels) ? msg.channels : [msg.channels || msg.channel];
    channels.forEach(ch => {
      if (WS_CHANNELS.includes(ch) || ch === '*') {
        clientInfo.channels.add(ch);
      }
    });
    ws.send(JSON.stringify({
      type: 'subscribed',
      channels: Array.from(clientInfo.channels)
    }));
    console.log(`[WS] ${agent} subscribed to: ${channels.join(', ')}`);
    return;
  }

  // Handle channel unsubscription
  if (msg.action === 'unsubscribe') {
    const channels = Array.isArray(msg.channels) ? msg.channels : [msg.channels || msg.channel];
    channels.forEach(ch => clientInfo.channels.delete(ch));
    ws.send(JSON.stringify({
      type: 'unsubscribed',
      channels: Array.from(clientInfo.channels)
    }));
    console.log(`[WS] ${agent} unsubscribed from: ${channels.join(', ')}`);
    return;
  }

  if (msg.type === "chat") {
    const chatMsg = {
      id: uuidv4(),
      from: msg.from || agent,
      content: msg.content,
      mentions: extractMentions(msg.content),
      timestamp: getCurrentTimestamp()
    };
    chatMessages.push(chatMsg);
    await saveChatMessage(chatMsg);

    // Broadcast to 'chat' channel
    broadcastToChannel('chat', { type: "chat", data: chatMsg });

    // Also publish to Redis
    redisClient.publish("cs:chat", JSON.stringify({
      type: "chat_message",
      data: chatMsg
    })).catch(err => console.error("Redis publish error:", err));

  } else if (msg.type === "ping") {
    ws.send(JSON.stringify({ type: "pong", timestamp: getCurrentTimestamp() }));
  }
}


// SERVER START
// ============================================================================

const HOST = process.env.CONSCIOUSNESS_HOST || '0.0.0.0';

// Gate every HTTP request through the shared middleware.
// WebSocket upgrade requests bypass the gate — the WS layer
// authenticates separately via X-Agent-Name during setup.
const { attachToServer } = require('./middleware/verify-signed');
const server = http.createServer(attachToServer(null, app));
const wss = setupWebSocket(server);


// ============================================================================
// REDIS AGENT BUS - Direct agent-to-agent messaging via Redis PubSub
// ============================================================================

function publishToAgentChannel(agentName, message) {
  const channel = `agent:${agentName.toUpperCase()}`;
  redisClient.publish(channel, JSON.stringify(message))
    .then(() => console.log(`[AGENT-BUS] Published to ${channel}`))
    .catch(err => console.error(`[AGENT-BUS] Error:`, err));
}

function notifyMentionedAgents(chatMessage) {
  if (!chatMessage.mentions || chatMessage.mentions.length === 0) return;
  chatMessage.mentions.forEach(agent => {
    if (agent.toUpperCase() === "ALL") {
      agents.forEach(a => publishToAgentChannel(a.name, chatMessage));
    } else {
      publishToAgentChannel(agent, chatMessage);
    }
  });
}

server.listen(PORT, HOST, () => {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║         CONSCIOUSNESS SERVER (Memory Server)               ║');
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log(`║  Port:        ${PORT}                                        ║`);
  console.log('║  Mode:        MVP (in-memory)                              ║');
  console.log(`║  Listening:   ${HOST}                                  ║`);
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log('║  Endpoints:                                                ║');
  console.log('║    GET  /health                                            ║');
  console.log('║    POST /api/agents/register                               ║');
  console.log('║    GET  /api/agents                                        ║');
  console.log('║    POST /api/tasks/create                                  ║');
  console.log('║    PATCH /api/tasks/:id/status                             ║');
  console.log('║    GET  /api/chat                                          ║');
  console.log('║    POST /api/chat                                          ║');
  console.log('║    GET  /api/system/tree                                   ║');
  console.log('║    GET  /api/system/services                               ║');
  console.log('║    POST /api/system/services/:name/:action                 ║');
  console.log('║    GET  /api/system/services/:name/logs                    ║');
  console.log('║    GET  /api/system/ports                                  ║');
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log('║  Status: READY ✅                                          ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`Test with: curl http://localhost:${PORT}/health`);
  console.log('');
});

// ============================================================================
// DASHBOARD V3 - MONITORING (2026-01-11)
// ============================================================================

/**
 * Monitor context usage and disk space
 * Broadcasts WebSocket warnings when thresholds exceeded
 */
function startSystemMonitoring() {
  setInterval(async () => {
    try {
      // Check context usage for all agents
      agents.forEach(agent => {
        const tokensUsed = agent.context?.tokens_used || 0;
        const tokensLimit = agent.context?.tokens_limit || 200000;
        const usagePercent = Math.round((tokensUsed / tokensLimit) * 100);

        // Send warning if usage > 85%
        if (usagePercent >= 85) {
          broadcastToChannel('system', {
            type: 'context_warning',
            data: {
              agent: agent.name,
              tokens_used: tokensUsed,
              tokens_limit: tokensLimit,
              usage_percent: usagePercent,
              level: usagePercent >= 95 ? 'critical' : 'warning',
              timestamp: new Date().toISOString()
            }
          });
        }
      });

      // Check disk usage
      const { exec } = require('child_process');
      const { promisify } = require('util');
      const execAsync = promisify(exec);

      const { stdout: diskInfo } = await execAsync('df -h / | tail -1');
      const diskParts = diskInfo.split(/\s+/);
      const diskUsage = parseInt(diskParts[4]);

      // Send warning if disk usage > 80%
      if (diskUsage >= 80) {
        broadcastToChannel('system', {
          type: 'disk_warning',
          data: {
            usage_percent: diskUsage,
            mount: '/',
            level: diskUsage >= 90 ? 'critical' : 'warning',
            timestamp: new Date().toISOString()
          }
        });
      }
    } catch (error) {
      console.error('[MONITORING] Error:', error.message);
    }
  }, 30000); // Check every 30 seconds

  console.log('[MONITORING] System monitoring started (30s interval)');
}

// Start monitoring after server is ready
setTimeout(startSystemMonitoring, 5000);

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\nShutting down Consciousness Server...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n\nShutting down Consciousness Server...');
  process.exit(0);
});
