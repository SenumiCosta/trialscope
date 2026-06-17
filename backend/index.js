const express = require('express')
const cors = require('cors')
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const multer = require('multer')
const jwt = require('jsonwebtoken')
const bcrypt = require('bcryptjs')
require('dotenv').config({ quiet: true })

const db = require('./db')
const parser = require('./protocol_parser')

const app = express()
const startedAt = new Date()
const port = Number(process.env.PORT || 4000)

const JWT_SECRET = process.env.JWT_SECRET || 'trialscope-jwt-secret-key-super-secure'

// Ensure uploads folder exists
const uploadsDir = path.join(__dirname, 'uploads')
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true })
}

// Multer Config
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir)
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`)
  }
})
const upload = multer({ storage })

app.use(cors())
app.use(express.json({ limit: '10mb' }))

// Active scraper run instances stored in memory
const activeScrapers = []

function triggerScraper(registry, proxyNodeId) {
  // Check if a scraper for this registry is already running
  if (activeScrapers.some(s => s.registry === registry && s.status === 'running')) {
    console.log(`Scraper for registry ${registry} is already running. Skip spawn.`)
    return
  }

  console.log(`Spawning scraper for registry ${registry} using proxy ${proxyNodeId}`)
  const pythonBinary = process.platform === 'win32' ? 'python' : 'python3'
  const scriptPath = path.join(__dirname, 'scraper_worker.py')
  const dbUri = process.env.DATABASE_URL || 'postgresql://postgres:1234@localhost:5432/trialscope'

  const child = spawn(pythonBinary, [
    scriptPath,
    '--registry', registry,
    '--proxy', proxyNodeId,
    '--database', dbUri
  ], {
    cwd: __dirname
  })

  const scraperRun = {
    id: `run-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
    registry,
    proxyNodeId,
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    logs: [],
    exitCode: null
  }

  activeScrapers.unshift(scraperRun)
  if (activeScrapers.length > 30) {
    activeScrapers.pop()
  }

  child.stdout.on('data', (data) => {
    const lines = data.toString().split('\n')
    lines.forEach(line => {
      if (line.trim()) {
        scraperRun.logs.push(line.trim())
      }
    })
  })

  child.stderr.on('data', (data) => {
    scraperRun.logs.push(`[stderr] ${data.toString().trim()}`)
  })

  child.on('close', (code) => {
    scraperRun.status = code === 0 ? 'completed' : 'failed'
    scraperRun.exitCode = code
    scraperRun.finishedAt = new Date().toISOString()
    console.log(`Scraper run for registry ${registry} exited with code ${code}`)
  })

  return scraperRun
}

// Background Ingestion Loop Manager
let ingestionTimer = null

function restartIngestionLoop(intervalMinutes) {
  if (ingestionTimer) {
    clearInterval(ingestionTimer)
  }

  const runTick = async () => {
    console.log('Background ingestion check running...')
    try {
      const config = await db.getConfig()
      const registries = config.registries || []
      const proxies = await db.getProxies()

      if (registries.length === 0 || proxies.length === 0) {
        console.log('Ingestion check skipped: no registries or proxies configured.')
        return
      }

      // Choose a random registry
      const targetRegistry = registries[Math.floor(Math.random() * registries.length)]

      // Find a proxy that covers this registry
      const viableProxies = proxies.filter(p => p.registryTargets.includes(targetRegistry) && p.status !== 'blocked')
      const targetProxy = viableProxies.length > 0
        ? viableProxies[Math.floor(Math.random() * viableProxies.length)]
        : proxies[Math.floor(Math.random() * proxies.length)]

      if (targetProxy) {
        triggerScraper(targetRegistry, targetProxy.id)
      }
    } catch (e) {
      console.error('Error running background scraper ingestion check:', e)
    }
  }

  const ms = Math.max(1, intervalMinutes) * 60 * 1000
  ingestionTimer = setInterval(runTick, ms)
  console.log(`Background ingestion loop started with interval of ${intervalMinutes} minutes.`)
}

// Helper functions for scoring and matching
function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

function hashString(value) {
  return String(value).split('').reduce((hash, char) => {
    return (hash * 31 + char.charCodeAt(0)) >>> 0
  }, 7)
}

function nodeTelemetry(node, index) {
  const minute = Math.floor(Date.now() / 60000)
  const hash = hashString(`${node.id}:${minute}`)
  const wave = Math.sin(minute / 3 + index)
  
  const latencyMs = Math.round((node.baseLatencyMs || 180) + (hash % 34) + wave * 18)
  const blockRatio = clamp((node.baseBlockRatio || 0.08) + Math.cos(minute / 5 + index) * 0.018, 0.02, 0.42)
  const successRate = clamp(1 - blockRatio - 0.035 + Math.sin(minute / 7 + index) * 0.014, 0.5, 0.99)

  return {
    ...node,
    latencyMs: Math.max(40, latencyMs),
    successRate: Number(successRate.toFixed(3)),
    blockRatio: Number(blockRatio.toFixed(3)),
    status: successRate >= 0.86 ? 'healthy' : successRate >= 0.72 ? 'degraded' : 'blocked',
    lastCheckedAt: new Date().toISOString(),
  }
}

function getTelemetryNodes(dbNodes) {
  return dbNodes.map((node, index) => nodeTelemetry(node, index))
}

function tokenize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s+-]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 2)
}

function scoreTrial(trial, condition) {
  const tokens = tokenize(condition)
  const haystack = [trial.title, trial.sponsor, trial.registry, ...(trial.conditionTags || [])].join(' ').toLowerCase()
  const directHits = tokens.filter((token) => haystack.includes(token)).length
  const cancerBoost = tokens.includes('cancer') && (trial.conditionTags || []).includes('cancer') ? 2 : 0
  const rareBoost = tokens.includes('rare') && (trial.conditionTags || []).includes('rare disease') ? 2 : 0
  const diabetesBoost = tokens.includes('diabetes') && (trial.conditionTags || []).includes('diabetes') ? 2 : 0
  
  return directHits + cancerBoost + rareBoost + diabetesBoost
}

function homeCanSeeTrial(trial, homeCountry) {
  const normalizedHome = String(homeCountry || '').toLowerCase()
  return [...(trial.homeVisibleCountries || []), ...(trial.siteCountries || [])].some((country) => {
    return country.toLowerCase() === normalizedHome
  })
}

function trialIsAgeEligible(trial, age) {
  if (!age) {
    return true
  }
  return Number(age) >= trial.minAge && Number(age) <= trial.maxAge
}

async function buildLookupResponse(payload = {}) {
  const condition = String(payload.condition || 'non-small cell lung cancer').trim()
  const age = payload.age ? Number(payload.age) : null
  const homeCountry = String(payload.homeCountry || 'Sri Lanka').trim()

  const trialCatalog = await db.getTrialsCatalog()
  const dbNodes = await db.getProxies()
  const config = await db.getConfig()
  
  const telemetryNodes = getTelemetryNodes(dbNodes)

  const scoredTrials = trialCatalog
    .map((trial) => ({ trial, score: scoreTrial(trial, condition) }))
    .filter(({ trial, score }) => score > 0 && trialIsAgeEligible(trial, age))
    .sort((a, b) => b.score - a.score || a.trial.title.localeCompare(b.trial.title))

  const fallbackTrials = trialCatalog
    .filter((trial) => trialIsAgeEligible(trial, age))
    .slice(0, 5)
    .map((trial) => ({ trial, score: 1 }))

  const selectedTrials = scoredTrials.length > 0 ? scoredTrials : fallbackTrials
  const homeVisibleIds = new Set(
    selectedTrials.filter(({ trial }) => homeCanSeeTrial(trial, homeCountry)).map(({ trial }) => trial.id),
  )

  const proxyNodes = telemetryNodes.map((node) => {
    const visibleTrials = selectedTrials.filter(({ trial }) => (trial.visibleVia || []).includes(node.id))
    const hiddenFromHome = visibleTrials.filter(({ trial }) => !homeVisibleIds.has(trial.id))

    return {
      ...node,
      visibleCount: visibleTrials.length,
      hiddenVsHome: hiddenFromHome.length,
      crossBorderAccepting: visibleTrials.filter(({ trial }) => trial.acceptsCrossBorder).length,
      registriesHit: [...new Set(visibleTrials.map(({ trial }) => trial.registry))],
    }
  })

  const visibleByProxy = new Map()
  selectedTrials.forEach(({ trial, score }) => {
    const visibleNodeIds = proxyNodes.filter((node) => (trial.visibleVia || []).includes(node.id)).map((node) => node.id)
    if (visibleNodeIds.length > 0 || homeVisibleIds.has(trial.id)) {
      visibleByProxy.set(trial.id, { trial, score, visibleNodeIds })
    }
  })

  const trials = [...visibleByProxy.values()].map(({ trial, score, visibleNodeIds }) => ({
    id: trial.id,
    title: trial.title,
    sponsor: trial.sponsor,
    phase: trial.phase,
    status: trial.status,
    registry: trial.registry,
    siteCountries: trial.siteCountries,
    acceptsCrossBorder: trial.acceptsCrossBorder,
    hiddenFromHome: !homeVisibleIds.has(trial.id),
    visibleVia: visibleNodeIds,
    diversityNeed: trial.diversityNeed,
    criteriaSummary: trial.criteriaSummary,
    eligibility: `${trial.minAge}-${trial.maxAge} years`,
    matchScore: Math.min(98, 68 + score * 9 + (trial.acceptsCrossBorder ? 6 : 0)),
  }))

  const alerts = trials
    .filter((trial) => trial.hiddenFromHome && trial.acceptsCrossBorder && trial.diversityNeed !== 'Low')
    .slice(0, 5)
    .map((trial, index) => ({
      id: `alert-${trial.id}`,
      sponsor: trial.sponsor,
      trialId: trial.id,
      severity: trial.diversityNeed === 'High' ? 'high' : 'medium',
      message: `${trial.sponsor} can review ${homeCountry} cohort interest for ${trial.title}.`,
      estimatedCohort: 12 + index * 7 + (trial.diversityNeed === 'High' ? 11 : 4),
    }))

  const uniqueHidden = trials.filter((trial) => trial.hiddenFromHome).length
  const crossBorderAccepting = trials.filter((trial) => trial.acceptsCrossBorder).length
  const visibleFromHome = trials.length - uniqueHidden

  const responseSummary = {
    totalUniqueTrials: trials.length,
    visibleFromHome,
    hiddenOpportunities: uniqueHidden,
    crossBorderAccepting,
    sponsorAlerts: alerts.length,
    registriesSearched: config.registries.length,
  }

  // Log search query telemetry
  db.logQuery(condition, age, homeCountry, responseSummary).catch(err => {
    console.error('Error logging search query to DB:', err)
  })

  return {
    generatedAt: new Date().toISOString(),
    query: {
      condition,
      age,
      homeCountry,
      parsedTerms: tokenize(condition),
    },
    summary: responseSummary,
    configSnapshot: config,
    proxyNodes,
    trials,
    alerts,
  }
}

// Authentication Middleware
function authenticateToken(req, res, next) {
  // Allow OPTIONS preflight calls
  if (req.method === 'OPTIONS') return next()

  const authHeader = req.headers['authorization']
  const token = authHeader && authHeader.split(' ')[1]

  if (!token) {
    return res.status(401).json({ error: 'unauthorized', message: 'Access token is required.' })
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'forbidden', message: 'Access token is invalid or expired.' })
    }
    req.user = user
    next()
  })
}

// REST Router Setup
const router = express.Router()

// PUBLIC ROUTES

router.get('/health', async (request, response) => {
  response.json({
    status: 'ok',
    service: 'trialscope-controller',
    startedAt: startedAt.toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    databaseStatus: db.isFallback() ? 'memory-fallback' : 'connected'
  })
})

router.post('/login', async (request, response) => {
  try {
    const { username, password } = request.body || {}
    if (!username || !password) {
      return response.status(400).json({ error: 'bad_request', message: 'Username and password are required.' })
    }

    const user = await db.getUser(username)
    if (!user) {
      return response.status(401).json({ error: 'auth_failed', message: 'Invalid username or password.' })
    }

    const matches = await bcrypt.compare(password, user.passwordHash)
    if (!matches) {
      return response.status(401).json({ error: 'auth_failed', message: 'Invalid username or password.' })
    }

    // Sign JWT Token
    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '24h' })
    response.json({
      token,
      username: user.username,
      role: user.role
    })
  } catch (err) {
    response.status(500).json({ error: 'server_error', message: err.message })
  }
})

// SECURE ROUTES (Require JWT authentication)

router.get('/config', authenticateToken, async (request, response) => {
  response.json(await db.getConfig())
})

router.post('/config', authenticateToken, async (request, response) => {
  const body = request.body || {}
  const currentConfig = await db.getConfig()
  
  const nextConfig = {
    ...currentConfig,
    ingestionIntervalMinutes: Math.max(1, Number(body.ingestionIntervalMinutes || currentConfig.ingestionIntervalMinutes)),
    requestTimeoutMs: Math.max(1000, Number(body.requestTimeoutMs || currentConfig.requestTimeoutMs)),
    maxParallelWorkers: Math.min(20, Math.max(1, Number(body.maxParallelWorkers || currentConfig.maxParallelWorkers))),
    lookupDefinitions: Array.isArray(body.lookupDefinitions)
      ? body.lookupDefinitions.map(String).filter(Boolean)
      : currentConfig.lookupDefinitions,
    registries: Array.isArray(body.registries)
      ? body.registries.map(String).filter(Boolean)
      : currentConfig.registries,
  }

  await db.saveConfig(nextConfig)
  restartIngestionLoop(nextConfig.ingestionIntervalMinutes)

  response.json(nextConfig)
})

router.get('/proxies', authenticateToken, async (request, response) => {
  const nodes = await db.getProxies()
  const telemetry = getTelemetryNodes(nodes)
  
  response.json({
    provider: 'Torch Labs',
    credentialProfile: 'demo-redacted',
    credentialsMounted: true,
    mountedAt: startedAt.toISOString(),
    aggregate: {
      nodeCount: telemetry.length,
      avgLatencyMs: Math.round(telemetry.reduce((acc, n) => acc + n.latencyMs, 0) / telemetry.length),
      avgSuccessRate: Number((telemetry.reduce((acc, n) => acc + n.successRate, 0) / telemetry.length).toFixed(3)),
      avgBlockRatio: Number((telemetry.reduce((acc, n) => acc + n.blockRatio, 0) / telemetry.length).toFixed(3)),
    },
    nodes: telemetry
  })
})

router.post('/proxies', authenticateToken, async (request, response) => {
  const body = request.body || {}
  const sourceNodes = Array.isArray(body.nodes) && body.nodes.length > 0 ? body.nodes : []
  
  const mappedNodes = sourceNodes.map(node => {
    return {
      id: String(node.id),
      label: String(node.label),
      country: String(node.country),
      countryCode: String(node.countryCode),
      region: String(node.region),
      registryTargets: Array.isArray(node.registryTargets) ? node.registryTargets.map(String) : [],
      baseLatencyMs: Number(node.baseLatencyMs || 150),
      baseBlockRatio: Number(node.baseBlockRatio || 0.05),
      mapPosition: node.mapPosition || { x: 50, y: 50 }
    }
  })

  if (mappedNodes.length > 0) {
    await db.saveProxies(mappedNodes)
  }

  const nodes = await db.getProxies()
  const telemetry = getTelemetryNodes(nodes)

  response.status(201).json({
    provider: String(body.provider || 'Torch Labs'),
    credentialProfile: body.apiKey || body.credentialProfile ? 'mounted-redacted' : 'demo-redacted',
    credentialsMounted: Boolean(body.apiKey || body.credentialProfile),
    mountedAt: new Date().toISOString(),
    aggregate: {
      nodeCount: telemetry.length,
      avgLatencyMs: Math.round(telemetry.reduce((acc, n) => acc + n.latencyMs, 0) / telemetry.length),
      avgSuccessRate: Number((telemetry.reduce((acc, n) => acc + n.successRate, 0) / telemetry.length).toFixed(3)),
      avgBlockRatio: Number((telemetry.reduce((acc, n) => acc + n.blockRatio, 0) / telemetry.length).toFixed(3)),
    },
    nodes: telemetry
  })
})

router.post('/lookup', authenticateToken, async (request, response) => {
  response.json(await buildLookupResponse(request.body))
})

router.get('/lookup', authenticateToken, async (request, response) => {
  response.json(await buildLookupResponse(request.query))
})

// NLP Protocol Parsing
router.post('/nlp-parse', authenticateToken, async (request, response) => {
  try {
    const text = String(request.body.text || '').trim()
    if (!text) {
      return response.status(400).json({ error: 'text_required', message: 'No text content provided.' })
    }
    const result = await parser.parseProtocol(text)
    response.json(result)
  } catch (err) {
    response.status(500).json({ error: 'parse_failed', message: err.message })
  }
})

// PDF File Upload & Extraction
router.post('/upload-protocol', authenticateToken, upload.single('protocolFile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'file_required', message: 'No file uploaded.' })
    }

    const filepath = req.file.path
    console.log(`Uploaded file saved at: ${filepath}. Spawning python PDF text parser...`)

    const pythonBinary = process.platform === 'win32' ? 'python' : 'python3'
    const scriptPath = path.join(__dirname, 'pdf_parser.py')

    const child = spawn(pythonBinary, [scriptPath, '--file', filepath])

    let extractedText = ''
    let errText = ''

    child.stdout.on('data', (data) => {
      extractedText += data.toString()
    })

    child.stderr.on('data', (data) => {
      errText += data.toString()
    })

    child.on('close', async (code) => {
      // Clean up uploaded file
      try {
        fs.unlinkSync(filepath)
      } catch (err) {
        console.warn('Failed to delete temp upload file', err)
      }

      if (code !== 0) {
        console.error(`PDF extraction script exited with code ${code}. Error: ${errText}`)
        return res.status(500).json({ error: 'extraction_failed', message: errText || 'PDF text extraction failed.' })
      }

      console.log('PDF text successfully extracted. Sending to Semantic NLP parser...')
      try {
        const parseResult = await parser.parseProtocol(extractedText)
        res.json({
          parseResult,
          extractedSnippet: extractedText.slice(0, 1000)
        })
      } catch (parseErr) {
        res.status(500).json({ error: 'parse_failed', message: parseErr.message })
      }
    })
  } catch (err) {
    res.status(500).json({ error: 'server_error', message: err.message })
  }
})

// Scraper Ingestion Endpoints
router.get('/scraper-status', authenticateToken, async (request, response) => {
  try {
    const logs = await db.getScrapingLogs()
    response.json({
      active: activeScrapers.filter(s => s.status === 'running'),
      recentHistory: activeScrapers,
      databaseHistory: logs
    })
  } catch (err) {
    response.status(500).json({ error: 'fetch_status_failed', message: err.message })
  }
})

router.post('/scraper-trigger', authenticateToken, async (request, response) => {
  try {
    const registry = String(request.body.registry || 'ClinicalTrials.gov')
    const proxyNodeId = String(request.body.proxyNodeId || 'us-east')

    const run = triggerScraper(registry, proxyNodeId)
    if (!run) {
      return response.status(400).json({ error: 'already_running', message: `A scraper for ${registry} is already executing.` })
    }

    response.status(202).json({
      message: 'Scraper task triggered successfully.',
      run
    })
  } catch (err) {
    response.status(500).json({ error: 'trigger_failed', message: err.message })
  }
})

// Patient Registration & Cohort Alerting
router.post('/patients', authenticateToken, async (request, response) => {
  try {
    const { name, email, condition, age, country } = request.body || {}
    if (!name || !email || !condition || !age || !country) {
      return response.status(400).json({ error: 'bad_request', message: 'All patient enrollment fields are required.' })
    }

    // 1. Insert patient
    const patient = await db.registerPatient(name, email, condition, age, country)
    console.log(`Registered new patient: ${patient.name} (${patient.email})`)

    // 2. Perform matches check
    const lookupResults = await buildLookupResponse({
      condition,
      age: Number(age),
      homeCountry: country
    })

    const matchingTrials = lookupResults.trials || []
    let alertsGenerated = 0

    // Filter hidden trials that accept cross-border
    const hiddenCrossBorderTrials = matchingTrials.filter(trial => {
      return trial.hiddenFromHome && trial.acceptsCrossBorder
    })

    // Create a cohort alert record for each hidden cross-border match
    for (const trial of hiddenCrossBorderTrials) {
      const severity = trial.diversityNeed === 'High' ? 'high' : 'medium'
      const alertLog = `Cohort Alert generated for trial ${trial.id} [${trial.sponsor}]. Diversity requirements matching ethnically diverse patient cohort: ${name} (${country}). Triggering Sponsor Telemetry Webhook.`
      
      await db.createAlert(trial.id, patient.id, 'dispatched', alertLog)
      alertsGenerated++
    }

    response.status(201).json({
      patient,
      trialsMatchedCount: matchingTrials.length,
      alertsGeneratedCount: alertsGenerated,
      matchingTrials
    })
  } catch (err) {
    response.status(500).json({ error: 'register_failed', message: err.message })
  }
})

router.get('/patients', authenticateToken, async (request, response) => {
  try {
    const list = await db.getPatients()
    response.json(list)
  } catch (err) {
    response.status(500).json({ error: 'fetch_failed', message: err.message })
  }
})

router.get('/alerts', authenticateToken, async (request, response) => {
  try {
    const list = await db.getCohortAlerts()
    response.json(list)
  } catch (err) {
    response.status(500).json({ error: 'fetch_failed', message: err.message })
  }
})

// Mount router under direct root AND /api
app.use('/api', router)
app.use('/', router)

app.use((request, response) => {
  response.status(404).json({
    error: 'not_found',
    message: `No TrialScope endpoint exists for ${request.method} ${request.path}`,
  })
})

// Start Database & Ingestion Loop on launch
db.initDb().then(() => {
  db.getConfig().then(cfg => {
    restartIngestionLoop(cfg.ingestionIntervalMinutes || 30)
  })

  if (require.main === module) {
    app.listen(port, () => {
      console.log(`TrialScope controller listening on http://localhost:${port}`)
    })
  }
})

module.exports = {
  app,
  buildLookupResponse,
  triggerScraper
}
