const { Pool } = require('pg')
const bcrypt = require('bcryptjs')

const connectionString = process.env.DATABASE_URL || 'postgresql://postgres:1234@localhost:5432/trialscope'
let pool = null
let useMemoryFallback = false

// Memory Fallback Store
const memoryStore = {
  config: {
    ingestionIntervalMinutes: 30,
    requestTimeoutMs: 18000,
    maxParallelWorkers: 5,
    lookupDefinitions: ['condition', 'age', 'phase', 'crossBorderAcceptance'],
    registries: [
      'ClinicalTrials.gov',
      'EU Clinical Trials Register',
      'WHO ICTRP',
      'Roche Trials',
      'Pfizer Clinical Trials',
    ],
  },
  proxies: [
    {
      id: 'us-east',
      label: 'US East',
      country: 'United States',
      countryCode: 'US',
      region: 'North America',
      registryTargets: ['ClinicalTrials.gov', 'Pfizer Clinical Trials', 'Roche Trials'],
      baseLatencyMs: 185,
      baseBlockRatio: 0.07,
      mapPosition: { x: 23, y: 38 },
      status: 'healthy',
      latencyMs: 185,
      successRate: 0.93,
      blockRatio: 0.07,
    },
    {
      id: 'eu-central',
      label: 'EU Central',
      country: 'Germany',
      countryCode: 'DE',
      region: 'European Union',
      registryTargets: ['EU Clinical Trials Register', 'WHO ICTRP', 'Roche Trials'],
      baseLatencyMs: 232,
      baseBlockRatio: 0.09,
      mapPosition: { x: 49, y: 34 },
      status: 'healthy',
      latencyMs: 232,
      successRate: 0.91,
      blockRatio: 0.09,
    },
    {
      id: 'uk-london',
      label: 'UK London',
      country: 'United Kingdom',
      countryCode: 'UK',
      region: 'Europe',
      registryTargets: ['ClinicalTrials.gov', 'WHO ICTRP', 'Pfizer Clinical Trials'],
      baseLatencyMs: 218,
      baseBlockRatio: 0.08,
      mapPosition: { x: 46, y: 31 },
      status: 'healthy',
      latencyMs: 218,
      successRate: 0.92,
      blockRatio: 0.08,
    },
    {
      id: 'sg-apac',
      label: 'APAC Singapore',
      country: 'Singapore',
      countryCode: 'SG',
      region: 'Asia Pacific',
      registryTargets: ['WHO ICTRP', 'Roche Trials', 'Pfizer Clinical Trials'],
      baseLatencyMs: 126,
      baseBlockRatio: 0.05,
      mapPosition: { x: 72, y: 58 },
      status: 'healthy',
      latencyMs: 126,
      successRate: 0.95,
      blockRatio: 0.05,
    },
    {
      id: 'in-south',
      label: 'South Asia',
      country: 'India',
      countryCode: 'IN',
      region: 'South Asia',
      registryTargets: ['WHO ICTRP', 'ClinicalTrials.gov', 'Regional Hospital Feeds'],
      baseLatencyMs: 96,
      baseBlockRatio: 0.11,
      mapPosition: { x: 66, y: 50 },
      status: 'healthy',
      latencyMs: 96,
      successRate: 0.89,
      blockRatio: 0.11,
    },
  ],
  trials: [
    {
      id: 'NCT-TS-1001',
      title: 'PD-1 Combination Therapy for Advanced Non-Small Cell Lung Cancer',
      sponsor: 'Roche',
      phase: 'Phase 2',
      status: 'Recruiting',
      registry: 'ClinicalTrials.gov',
      conditionTags: ['lung cancer', 'non-small cell lung cancer', 'cancer', 'oncology'],
      minAge: 18,
      maxAge: 75,
      acceptsCrossBorder: true,
      siteCountries: ['United States', 'Germany', 'Singapore'],
      visibleVia: ['us-east', 'eu-central', 'uk-london', 'sg-apac'],
      homeVisibleCountries: [],
      diversityNeed: 'High',
      criteriaSummary: 'Adults with advanced NSCLC, ECOG 0-1, measurable disease.',
    },
    {
      id: 'NCT-TS-1002',
      title: 'HER2 Positive Breast Cancer Adaptive Immunotherapy Study',
      sponsor: 'Pfizer',
      phase: 'Phase 3',
      status: 'Recruiting',
      registry: 'Pfizer Clinical Trials',
      conditionTags: ['breast cancer', 'cancer', 'oncology', 'immunotherapy'],
      minAge: 21,
      maxAge: 80,
      acceptsCrossBorder: true,
      siteCountries: ['United States', 'United Kingdom', 'Germany'],
      visibleVia: ['us-east', 'eu-central', 'uk-london'],
      homeVisibleCountries: [],
      diversityNeed: 'High',
      criteriaSummary: 'HER2 positive metastatic disease with prior first-line therapy.',
    },
    {
      id: 'NCT-TS-1003',
      title: 'Rare Neuromuscular Disease Gene Therapy Registry',
      sponsor: 'Novartis',
      phase: 'Phase 1/2',
      status: 'Recruiting',
      registry: 'EU Clinical Trials Register',
      conditionTags: ['rare disease', 'neuromuscular disease', 'gene therapy', 'pediatric'],
      minAge: 2,
      maxAge: 17,
      acceptsCrossBorder: true,
      siteCountries: ['Germany', 'United Kingdom'],
      visibleVia: ['eu-central', 'uk-london'],
      homeVisibleCountries: [],
      diversityNeed: 'Medium',
      criteriaSummary: 'Confirmed genetic marker, ambulatory or assisted mobility cohort.',
    },
    {
      id: 'NCT-TS-1004',
      title: 'Acute Myeloid Leukemia South Asian Cohort Extension',
      sponsor: 'Global CRO Network',
      phase: 'Phase 2',
      status: 'Recruiting',
      registry: 'WHO ICTRP',
      conditionTags: ['leukemia', 'aml', 'blood cancer', 'cancer', 'hematology'],
      minAge: 18,
      maxAge: 70,
      acceptsCrossBorder: true,
      siteCountries: ['India', 'Singapore'],
      visibleVia: ['sg-apac', 'in-south', 'eu-central'],
      homeVisibleCountries: ['Sri Lanka'],
      diversityNeed: 'High',
      criteriaSummary: 'Newly diagnosed AML with molecular panel available.',
    },
    {
      id: 'NCT-TS-1005',
      title: 'Metastatic Colorectal Cancer ctDNA Surveillance Trial',
      sponsor: 'Roche',
      phase: 'Phase 3',
      status: 'Recruiting',
      registry: 'Roche Trials',
      conditionTags: ['colorectal cancer', 'colon cancer', 'cancer', 'ctdna'],
      minAge: 18,
      maxAge: 78,
      acceptsCrossBorder: true,
      siteCountries: ['United States', 'Singapore', 'Germany'],
      visibleVia: ['us-east', 'eu-central', 'sg-apac'],
      homeVisibleCountries: [],
      diversityNeed: 'Medium',
      criteriaSummary: 'Stage III or IV colorectal cancer with post-surgical ctDNA signal.',
    },
    {
      id: 'NCT-TS-1006',
      title: 'CAR-T Bridge Therapy for Relapsed Lymphoma',
      sponsor: 'Pfizer',
      phase: 'Phase 2',
      status: 'Recruiting',
      registry: 'ClinicalTrials.gov',
      conditionTags: ['lymphoma', 'blood cancer', 'car-t', 'cancer', 'hematology'],
      minAge: 18,
      maxAge: 73,
      acceptsCrossBorder: true,
      siteCountries: ['United States', 'United Kingdom'],
      visibleVia: ['us-east', 'uk-london'],
      homeVisibleCountries: [],
      diversityNeed: 'High',
      criteriaSummary: 'Relapsed B-cell lymphoma after two previous therapy lines.',
    },
    {
      id: 'NCT-TS-1007',
      title: 'Thalassemia Gene Editing Long-Term Follow-Up',
      sponsor: 'International Hematology Group',
      phase: 'Phase 1/2',
      status: 'Recruiting',
      registry: 'WHO ICTRP',
      conditionTags: ['thalassemia', 'rare disease', 'gene editing', 'hematology'],
      minAge: 12,
      maxAge: 45,
      acceptsCrossBorder: true,
      siteCountries: ['India', 'Singapore', 'Germany'],
      visibleVia: ['in-south', 'sg-apac', 'eu-central'],
      homeVisibleCountries: ['Sri Lanka'],
      diversityNeed: 'High',
      criteriaSummary: 'Transfusion-dependent beta thalassemia with matched donor review.',
    },
    {
      id: 'NCT-TS-1008',
      title: 'Early-Onset Alzheimer Digital Biomarker Study',
      sponsor: 'Novartis',
      phase: 'Observational',
      status: 'Recruiting',
      registry: 'EU Clinical Trials Register',
      conditionTags: ['alzheimer', 'dementia', 'neurology', 'digital biomarker'],
      minAge: 40,
      maxAge: 65,
      acceptsCrossBorder: false,
      siteCountries: ['Germany', 'United Kingdom'],
      visibleVia: ['eu-central', 'uk-london'],
      homeVisibleCountries: [],
      diversityNeed: 'Low',
      criteriaSummary: 'Mild cognitive impairment with amyloid confirmation.',
    },
    {
      id: 'NCT-TS-1009',
      title: 'Type 2 Diabetes Cardiometabolic Outcomes Program',
      sponsor: 'Global Metabolic Alliance',
      phase: 'Phase 3',
      status: 'Recruiting',
      registry: 'ClinicalTrials.gov',
      conditionTags: ['diabetes', 'type 2 diabetes', 'cardiometabolic', 'endocrinology'],
      minAge: 18,
      maxAge: 85,
      acceptsCrossBorder: false,
      siteCountries: ['United States', 'India', 'Singapore'],
      visibleVia: ['us-east', 'sg-apac', 'in-south'],
      homeVisibleCountries: ['Sri Lanka'],
      diversityNeed: 'Medium',
      criteriaSummary: 'Type 2 diabetes with elevated cardiovascular risk profile.',
    },
    {
      id: 'NCT-TS-1010',
      title: 'Ovarian Cancer PARP Maintenance Access Study',
      sponsor: 'Roche',
      phase: 'Phase 3',
      status: 'Recruiting',
      registry: 'Roche Trials',
      conditionTags: ['ovarian cancer', 'cancer', 'parp', 'oncology'],
      minAge: 18,
      maxAge: 79,
      acceptsCrossBorder: true,
      siteCountries: ['United States', 'Germany', 'Singapore'],
      visibleVia: ['us-east', 'eu-central', 'sg-apac'],
      homeVisibleCountries: [],
      diversityNeed: 'High',
      criteriaSummary: 'BRCA or HRD positive ovarian cancer following platinum response.',
    },
  ],
  scrapingLogs: [],
  queriesLog: [],
  users: [
    {
      id: 1,
      username: 'admin',
      passwordHash: bcrypt.hashSync('admin123', 10),
      role: 'administrator'
    }
  ],
  patients: [],
  cohortAlerts: []
}

async function initDb() {
  pool = new Pool({ connectionString })
  try {
    const client = await pool.connect()
    console.log('PostgreSQL Connected: Ready to initialize production tables')
    client.release()

    // 1. Config Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS system_config (
        key VARCHAR(50) PRIMARY KEY,
        value JSONB NOT NULL
      );
    `)

    // 2. Proxy Nodes Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS proxy_nodes (
        id VARCHAR(50) PRIMARY KEY,
        label VARCHAR(100) NOT NULL,
        country VARCHAR(100),
        country_code VARCHAR(10),
        region VARCHAR(100),
        registry_targets TEXT[],
        base_latency_ms INTEGER,
        base_block_ratio NUMERIC,
        map_position_x INTEGER,
        map_position_y INTEGER,
        status VARCHAR(20) DEFAULT 'healthy',
        latency_ms INTEGER DEFAULT 150,
        success_rate NUMERIC DEFAULT 0.95,
        block_ratio NUMERIC DEFAULT 0.05,
        last_checked_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `)

    // 3. Trials Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS trials (
        id VARCHAR(50) PRIMARY KEY,
        title TEXT NOT NULL,
        sponsor VARCHAR(150),
        phase VARCHAR(50),
        status VARCHAR(50),
        registry VARCHAR(100),
        condition_tags TEXT[],
        min_age INTEGER,
        max_age INTEGER,
        accepts_cross_border BOOLEAN,
        site_countries TEXT[],
        visible_via TEXT[],
        home_visible_countries TEXT[],
        diversity_need VARCHAR(50),
        criteria_summary TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `)

    // 4. Scraping Logs Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS scraping_logs (
        id SERIAL PRIMARY KEY,
        registry VARCHAR(100),
        proxy_node_id VARCHAR(50),
        status VARCHAR(50),
        trials_scraped INTEGER,
        logs TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `)

    // 5. Queries Log Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS queries_log (
        id SERIAL PRIMARY KEY,
        condition TEXT,
        age INTEGER,
        home_country VARCHAR(100),
        summary JSONB,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `)

    // 6. Users Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(100) UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role VARCHAR(50) DEFAULT 'department_user',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `)

    // 7. Patients Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS patients (
        id SERIAL PRIMARY KEY,
        name VARCHAR(150) NOT NULL,
        email VARCHAR(150) NOT NULL,
        condition VARCHAR(150) NOT NULL,
        age INTEGER NOT NULL,
        country VARCHAR(100) NOT NULL,
        registered_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `)

    // 8. Cohort Alerts Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cohort_alerts (
        id SERIAL PRIMARY KEY,
        trial_id VARCHAR(50) REFERENCES trials(id) ON DELETE CASCADE,
        patient_id INTEGER REFERENCES patients(id) ON DELETE CASCADE,
        status VARCHAR(50) DEFAULT 'pending',
        logs TEXT,
        notified_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `)

    console.log('Production database tables initialized successfully.')
    await seedData()
  } catch (err) {
    console.warn('PostgreSQL connection failed. Falling back to In-Memory mode.', err.message)
    useMemoryFallback = true
  }
}

async function seedData() {
  if (useMemoryFallback) return

  // Seed Config
  const configCheck = await pool.query('SELECT 1 FROM system_config LIMIT 1')
  if (configCheck.rows.length === 0) {
    await pool.query('INSERT INTO system_config (key, value) VALUES ($1, $2)', ['default', JSON.stringify(memoryStore.config)])
    console.log('System Config seeded.')
  }

  // Seed Proxies
  const proxyCheck = await pool.query('SELECT 1 FROM proxy_nodes LIMIT 1')
  if (proxyCheck.rows.length === 0) {
    for (const node of memoryStore.proxies) {
      await pool.query(`
        INSERT INTO proxy_nodes (id, label, country, country_code, region, registry_targets, base_latency_ms, base_block_ratio, map_position_x, map_position_y, status, latency_ms, success_rate, block_ratio)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      `, [
        node.id, node.label, node.country, node.countryCode, node.region, node.registryTargets,
        node.baseLatencyMs, node.baseBlockRatio, node.mapPosition.x, node.mapPosition.y,
        node.status, node.latencyMs, node.successRate, node.blockRatio
      ])
    }
    console.log('Proxy nodes seeded.')
  }

  // Seed Trials
  const trialCheck = await pool.query('SELECT 1 FROM trials LIMIT 1')
  if (trialCheck.rows.length === 0) {
    for (const trial of memoryStore.trials) {
      await pool.query(`
        INSERT INTO trials (id, title, sponsor, phase, status, registry, condition_tags, min_age, max_age, accepts_cross_border, site_countries, visible_via, home_visible_countries, diversity_need, criteria_summary)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      `, [
        trial.id, trial.title, trial.sponsor, trial.phase, trial.status, trial.registry,
        trial.conditionTags, trial.minAge, trial.maxAge, trial.acceptsCrossBorder,
        trial.siteCountries, trial.visibleVia, trial.homeVisibleCountries, trial.diversityNeed,
        trial.criteriaSummary
      ])
    }
    console.log('Trials catalog seeded.')
  }

  // Seed User
  const userCheck = await pool.query('SELECT 1 FROM users LIMIT 1')
  if (userCheck.rows.length === 0) {
    const defaultAdmin = memoryStore.users[0]
    await pool.query(`
      INSERT INTO users (username, password_hash, role)
      VALUES ($1, $2, $3)
    `, [defaultAdmin.username, defaultAdmin.passwordHash, defaultAdmin.role])
    console.log('Default administrator user seeded: admin / admin123')
  }
}

// Config Functions
async function getConfig() {
  if (useMemoryFallback) return memoryStore.config
  try {
    const res = await pool.query('SELECT value FROM system_config WHERE key = $1', ['default'])
    return res.rows[0]?.value || memoryStore.config
  } catch (err) {
    console.error('Error fetching config from database', err)
    return memoryStore.config
  }
}

async function saveConfig(config) {
  if (useMemoryFallback) {
    memoryStore.config = { ...memoryStore.config, ...config }
    return memoryStore.config
  }
  try {
    await pool.query(`
      INSERT INTO system_config (key, value) VALUES ($1, $2)
      ON CONFLICT (key) DO UPDATE SET value = $2
    `, ['default', JSON.stringify(config)])
    return config
  } catch (err) {
    console.error('Error saving config to database', err)
    return config
  }
}

// Proxy Functions
async function getProxies() {
  if (useMemoryFallback) return memoryStore.proxies
  try {
    const res = await pool.query('SELECT * FROM proxy_nodes')
    return res.rows.map(row => ({
      id: row.id,
      label: row.label,
      country: row.country,
      countryCode: row.country_code,
      region: row.region,
      registryTargets: row.registry_targets,
      baseLatencyMs: row.base_latency_ms,
      baseBlockRatio: Number(row.base_block_ratio),
      mapPosition: { x: row.map_position_x, y: row.map_position_y },
      status: row.status,
      latencyMs: row.latency_ms,
      successRate: Number(row.success_rate),
      blockRatio: Number(row.block_ratio),
      lastCheckedAt: row.last_checked_at
    }))
  } catch (err) {
    console.error('Error fetching proxies from database', err)
    return memoryStore.proxies
  }
}

async function saveProxies(proxies) {
  if (useMemoryFallback) {
    memoryStore.proxies = proxies
    return proxies
  }
  try {
    for (const node of proxies) {
      await pool.query(`
        INSERT INTO proxy_nodes (id, label, country, country_code, region, registry_targets, base_latency_ms, base_block_ratio, map_position_x, map_position_y, status, latency_ms, success_rate, block_ratio, last_checked_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())
        ON CONFLICT (id) DO UPDATE SET
          label = $2, country = $3, country_code = $4, region = $5, registry_targets = $6,
          base_latency_ms = $7, base_block_ratio = $8, map_position_x = $9, map_position_y = $10,
          status = $11, latency_ms = $12, success_rate = $13, block_ratio = $14, last_checked_at = NOW()
      `, [
        node.id, node.label, node.country, node.countryCode, node.region, node.registryTargets,
        node.baseLatencyMs, node.baseBlockRatio, node.mapPosition.x, node.mapPosition.y,
        node.status || 'healthy', node.latencyMs || 150, node.successRate || 0.95, node.blockRatio || 0.05
      ])
    }
    return getProxies()
  } catch (err) {
    console.error('Error saving proxies to database', err)
    return proxies
  }
}

async function updateProxyMetrics(id, metrics) {
  if (useMemoryFallback) {
    const idx = memoryStore.proxies.findIndex(p => p.id === id)
    if (idx !== -1) {
      memoryStore.proxies[idx] = { ...memoryStore.proxies[idx], ...metrics }
    }
    return
  }
  try {
    await pool.query(`
      UPDATE proxy_nodes
      SET latency_ms = $1, success_rate = $2, block_ratio = $3, status = $4, last_checked_at = NOW()
      WHERE id = $5
    `, [metrics.latencyMs, metrics.successRate, metrics.blockRatio, metrics.status, id])
  } catch (err) {
    console.error(`Error updating proxy metrics for ${id}`, err)
  }
}

// Trials Functions
async function getTrialsCatalog() {
  if (useMemoryFallback) return memoryStore.trials
  try {
    const res = await pool.query('SELECT * FROM trials')
    return res.rows.map(row => ({
      id: row.id,
      title: row.title,
      sponsor: row.sponsor,
      phase: row.phase,
      status: row.status,
      registry: row.registry,
      conditionTags: row.condition_tags,
      minAge: row.min_age,
      maxAge: row.max_age,
      acceptsCrossBorder: row.accepts_cross_border,
      siteCountries: row.site_countries,
      visibleVia: row.visible_via,
      homeVisibleCountries: row.home_visible_countries || [],
      diversityNeed: row.diversity_need,
      criteriaSummary: row.criteria_summary
    }))
  } catch (err) {
    console.error('Error fetching trials from database', err)
    return memoryStore.trials
  }
}

async function addScrapedTrial(trial) {
  if (useMemoryFallback) {
    const idx = memoryStore.trials.findIndex(t => t.id === trial.id)
    if (idx !== -1) {
      memoryStore.trials[idx] = trial
    } else {
      memoryStore.trials.push(trial)
    }
    return
  }
  try {
    await pool.query(`
      INSERT INTO trials (id, title, sponsor, phase, status, registry, condition_tags, min_age, max_age, accepts_cross_border, site_countries, visible_via, home_visible_countries, diversity_need, criteria_summary)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      ON CONFLICT (id) DO UPDATE SET
        title = $2, sponsor = $3, phase = $4, status = $5, registry = $6, condition_tags = $7,
        min_age = $8, max_age = $9, accepts_cross_border = $10, site_countries = $11,
        visible_via = $12, home_visible_countries = $13, diversity_need = $14, criteria_summary = $15
    `, [
      trial.id, trial.title, trial.sponsor, trial.phase, trial.status, trial.registry,
      trial.conditionTags, trial.minAge, trial.maxAge, trial.acceptsCrossBorder,
      trial.siteCountries, trial.visibleVia, trial.homeVisibleCountries || [], trial.diversityNeed,
      trial.criteriaSummary
    ])
  } catch (err) {
    console.error('Error adding scraped trial', err)
  }
}

// User Authentication Queries
async function getUser(username) {
  if (useMemoryFallback) {
    return memoryStore.users.find(u => u.username === username) || null
  }
  try {
    const res = await pool.query('SELECT * FROM users WHERE username = $1', [username])
    if (res.rows.length === 0) return null
    const row = res.rows[0]
    return {
      id: row.id,
      username: row.username,
      passwordHash: row.password_hash,
      role: row.role
    }
  } catch (err) {
    console.error('Error fetching user', err)
    return null
  }
}

// Patient & Alert Queries
async function registerPatient(name, email, condition, age, country) {
  if (useMemoryFallback) {
    const patient = {
      id: memoryStore.patients.length + 1,
      name,
      email,
      condition,
      age: Number(age),
      country,
      registeredAt: new Date().toISOString()
    }
    memoryStore.patients.push(patient)
    return patient
  }
  try {
    const res = await pool.query(`
      INSERT INTO patients (name, email, condition, age, country)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, name, email, condition, age, country, registered_at AS "registeredAt"
    `, [name, email, condition, Number(age), country])
    return res.rows[0]
  } catch (err) {
    console.error('Error registering patient', err)
    throw err
  }
}

async function getPatients() {
  if (useMemoryFallback) return memoryStore.patients
  try {
    const res = await pool.query('SELECT id, name, email, condition, age, country, registered_at AS "registeredAt" FROM patients ORDER BY registered_at DESC')
    return res.rows
  } catch (err) {
    console.error('Error fetching patients', err)
    return []
  }
}

async function createAlert(trialId, patientId, status, logs) {
  if (useMemoryFallback) {
    const alert = {
      id: memoryStore.cohortAlerts.length + 1,
      trialId,
      patientId,
      status,
      logs,
      notifiedAt: new Date().toISOString()
    }
    memoryStore.cohortAlerts.push(alert)
    return alert
  }
  try {
    const res = await pool.query(`
      INSERT INTO cohort_alerts (trial_id, patient_id, status, logs)
      VALUES ($1, $2, $3, $4)
      RETURNING id, trial_id AS "trialId", patient_id AS "patientId", status, logs, notified_at AS "notifiedAt"
    `, [trialId, patientId, status, logs])
    return res.rows[0]
  } catch (err) {
    console.error('Error creating cohort alert', err)
    return null
  }
}

async function getCohortAlerts() {
  if (useMemoryFallback) {
    return memoryStore.cohortAlerts.map(alert => {
      const patient = memoryStore.patients.find(p => p.id === alert.patientId) || {}
      const trial = memoryStore.trials.find(t => t.id === alert.trialId) || {}
      return {
        ...alert,
        patientName: patient.name,
        patientCountry: patient.country,
        trialTitle: trial.title,
        sponsor: trial.sponsor
      }
    })
  }
  try {
    const res = await pool.query(`
      SELECT 
        a.id, a.trial_id AS "trialId", a.patient_id AS "patientId", a.status, a.logs, a.notified_at AS "notifiedAt",
        p.name AS "patientName", p.country AS "patientCountry",
        t.title AS "trialTitle", t.sponsor AS "sponsor"
      FROM cohort_alerts a
      JOIN patients p ON a.patient_id = p.id
      JOIN trials t ON a.trial_id = t.id
      ORDER BY a.notified_at DESC
    `)
    return res.rows
  } catch (err) {
    console.error('Error fetching cohort alerts', err)
    return []
  }
}

// Logging Functions
async function logScrapingRun(registry, proxyNodeId, status, trialsScraped, logs) {
  if (useMemoryFallback) {
    memoryStore.scrapingLogs.unshift({
      id: memoryStore.scrapingLogs.length + 1,
      registry,
      proxyNodeId,
      status,
      trialsScraped,
      logs,
      createdAt: new Date().toISOString()
    })
    return
  }
  try {
    await pool.query(`
      INSERT INTO scraping_logs (registry, proxy_node_id, status, trials_scraped, logs)
      VALUES ($1, $2, $3, $4, $5)
    `, [registry, proxyNodeId, status, trialsScraped, logs])
  } catch (err) {
    console.error('Error logging scraping run', err)
  }
}

async function getScrapingLogs() {
  if (useMemoryFallback) return memoryStore.scrapingLogs.slice(0, 50)
  try {
    const res = await pool.query('SELECT * FROM scraping_logs ORDER BY created_at DESC LIMIT 50')
    return res.rows.map(row => ({
      id: row.id,
      registry: row.registry,
      proxyNodeId: row.proxy_node_id,
      status: row.status,
      trialsScraped: row.trials_scraped,
      logs: row.logs,
      createdAt: row.created_at
    }))
  } catch (err) {
    console.error('Error fetching scraping logs', err)
    return memoryStore.scrapingLogs
  }
}

async function logQuery(condition, age, homeCountry, summary) {
  if (useMemoryFallback) {
    memoryStore.queriesLog.unshift({
      id: memoryStore.queriesLog.length + 1,
      condition,
      age,
      homeCountry,
      summary,
      createdAt: new Date().toISOString()
    })
    return
  }
  try {
    await pool.query(`
      INSERT INTO queries_log (condition, age, home_country, summary)
      VALUES ($1, $2, $3, $4)
    `, [condition, age, homeCountry, JSON.stringify(summary)])
  } catch (err) {
    console.error('Error logging search query', err)
  }
}

module.exports = {
  initDb,
  getConfig,
  saveConfig,
  getProxies,
  saveProxies,
  updateProxyMetrics,
  getTrialsCatalog,
  addScrapedTrial,
  logScrapingRun,
  getScrapingLogs,
  logQuery,
  getUser,
  registerPatient,
  getPatients,
  createAlert,
  getCohortAlerts,
  getPool: () => pool,
  isFallback: () => useMemoryFallback
}
