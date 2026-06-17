import { useEffect, useState, useRef } from 'react'
import './App.css'

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api'

const defaultForm = {
  condition: 'non-small cell lung cancer',
  age: '46',
  homeCountry: 'Sri Lanka',
}

const fallbackConfig = {
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
}

function formatPercent(value) {
  return `${Math.round(Number(value || 0) * 100)}%`
}

function formatMs(value) {
  return `${Math.round(Number(value || 0))} ms`
}

function formatCountries(countries) {
  return Array.isArray(countries) ? countries.join(', ') : ''
}

function App() {
  // Session Authentication
  const [token, setToken] = useState(localStorage.getItem('trialscope_jwt') || '')
  const [username, setUsername] = useState(localStorage.getItem('trialscope_user') || '')
  const [loginUsername, setLoginUsername] = useState('admin')
  const [loginPassword, setLoginPassword] = useState('admin123')
  const [isLoggingIn, setIsLoggingIn] = useState(false)

  // Navigation Tabs
  const [activeTab, setActiveTab] = useState('map') // 'parser', 'map', 'scraper', 'settings'
  
  // App States
  const [health, setHealth] = useState(null)
  const [config, setConfig] = useState(fallbackConfig)
  const [proxyProfile, setProxyProfile] = useState({ nodes: [], aggregate: null })
  const [lookup, setLookup] = useState(null)
  const [form, setForm] = useState(defaultForm)
  const [error, setError] = useState('')
  const [isRunning, setIsRunning] = useState(false)
  const [isSavingConfig, setIsSavingConfig] = useState(false)
  const [isMounting, setIsMounting] = useState(false)

  // Intake NLP Parser States
  const [intakeText, setIntakeText] = useState(
    'We are seeking clinical trial enrollment leads for a 46-year-old patient diagnosed with advanced non-small cell lung cancer. The patient is willing to travel internationally (accepts cross-border site allowances) to oncology clinics in Germany, the United States or Singapore. Please analyze the HER2 and PD-1 criteria protocols for active Phase 2 treatments.'
  )
  const [parsedCriteria, setParsedCriteria] = useState(null)
  const [isParsingText, setIsParsingText] = useState(false)
  const [selectedFile, setSelectedFile] = useState(null)
  const [isUploadingFile, setIsUploadingFile] = useState(false)

  // Patient Registry States
  const [patientsList, setPatientsList] = useState([])
  const [patientForm, setPatientForm] = useState({
    name: 'Dilshan Perera',
    email: 'dilshan@hospital.lk',
    condition: 'non-small cell lung cancer',
    age: '46',
    country: 'Sri Lanka'
  })
  const [isRegisteringPatient, setIsRegisteringPatient] = useState(false)
  const [telemetryAlerts, setTelemetryAlerts] = useState([])

  // Ingestion / Scraper States
  const [scraperHistory, setScraperHistory] = useState({ active: [], recentHistory: [], databaseHistory: [] })
  const [selectedScrapeRegistry, setSelectedScrapeRegistry] = useState('ClinicalTrials.gov')
  const [selectedScrapeProxy, setSelectedScrapeProxy] = useState('us-east')
  const [isTriggeringScraper, setIsTriggeringScraper] = useState(false)
  const [selectedScraperRun, setSelectedScraperRun] = useState(null)

  // Interactive UI detail selected node
  const [selectedNodeDetails, setSelectedNodeDetails] = useState(null)

  const terminalEndRef = useRef(null)
  const fileInputRef = useRef(null)

  const controllerOnline = health?.status === 'ok'
  const nodes = lookup?.proxyNodes || proxyProfile.nodes || []
  const summary = lookup?.summary || {
    totalUniqueTrials: 0,
    visibleFromHome: 0,
    hiddenOpportunities: 0,
    crossBorderAccepting: 0,
    sponsorAlerts: 0,
    registriesSearched: config.registries.length,
  }
  const trials = lookup?.trials || []
  const alerts = lookup?.alerts || []
  const maxVisible = Math.max(1, ...nodes.map((node) => node.visibleCount || 0))

  const topVarianceNode = nodes.length
    ? [...nodes].sort((a, b) => (b.hiddenVsHome || 0) - (a.hiddenVsHome || 0))[0].label
    : 'Pending'

  // HTTP wrapper with Authentication headers
  const apiRequest = async (path, options = {}) => {
    const headers = {
      'Content-Type': 'application/json',
      ...options.headers,
    }
    
    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    }

    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers
    })

    if (response.status === 401 || response.status === 403) {
      handleLogout()
      throw new Error('Session expired. Please log in again.')
    }

    if (!response.ok) {
      const message = await response.text()
      let errorObj
      try {
        errorObj = JSON.parse(message)
      } catch (e) {
        errorObj = { message }
      }
      throw new Error(errorObj.message || `Request failed with ${response.status}`)
    }

    return response.json()
  }

  // Handle User Login
  async function handleLogin(e) {
    e.preventDefault()
    setIsLoggingIn(true)
    setError('')
    try {
      const res = await fetch(`${API_BASE}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: loginUsername, password: loginPassword })
      })

      if (!res.ok) {
        const msg = await res.json()
        throw new Error(msg.message || 'Login failed')
      }

      const data = await res.json()
      localStorage.setItem('trialscope_jwt', data.token)
      localStorage.setItem('trialscope_user', data.username)
      setToken(data.token)
      setUsername(data.username)
    } catch (err) {
      setError(err.message)
    } finally {
      setIsLoggingIn(false)
    }
  }

  function handleLogout() {
    localStorage.removeItem('trialscope_jwt')
    localStorage.removeItem('trialscope_user')
    setToken('')
    setUsername('')
    setHealth(null)
  }

  // Fetch initial setup details when authenticated
  useEffect(() => {
    if (!token) return
    let isActive = true

    async function boot() {
      try {
        const [healthData, configData, proxyData, lookupData, patientsData, alertsData] = await Promise.all([
          apiRequest('/health'),
          apiRequest('/config'),
          apiRequest('/proxies'),
          apiRequest('/lookup', {
            method: 'POST',
            body: JSON.stringify({
              ...defaultForm,
              age: Number(defaultForm.age),
            }),
          }),
          apiRequest('/patients'),
          apiRequest('/alerts')
        ])

        if (!isActive) return

        setHealth(healthData)
        setConfig(configData)
        setProxyProfile(proxyData)
        setLookup(lookupData)
        setPatientsList(patientsData)
        setTelemetryAlerts(alertsData)
      } catch (requestError) {
        if (isActive) {
          setError(`Booting failed: ${requestError.message}.`)
        }
      }
    }

    boot()

    return () => {
      isActive = false
    }
  }, [token])

  // Poll Scraper Status & Patients/Alerts logs if scraper tab is open
  useEffect(() => {
    if (!token) return
    let timer
    if (activeTab === 'scraper') {
      const fetchScrapers = async () => {
        try {
          const data = await apiRequest('/scraper-status')
          setScraperHistory(data)
          
          if (selectedScraperRun) {
            const currentRun = data.recentHistory.find(r => r.id === selectedScraperRun.id)
            if (currentRun) {
              setSelectedScraperRun(currentRun)
            }
          }
        } catch (e) {
          console.warn('Scraper status fetch failed:', e.message)
        }
      }
      fetchScrapers()
      timer = setInterval(fetchScrapers, 2000)
    }
    return () => clearInterval(timer)
  }, [activeTab, selectedScraperRun, token])

  // Scroll to bottom of terminal log when new lines arrive
  useEffect(() => {
    if (terminalEndRef.current) {
      terminalEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [selectedScraperRun?.logs?.length])

  async function runLookup(event) {
    if (event) event.preventDefault()
    setIsRunning(true)
    setError('')

    try {
      const lookupData = await apiRequest('/lookup', {
        method: 'POST',
        body: JSON.stringify({
          ...form,
          age: Number(form.age),
        }),
      })
      setLookup(lookupData)
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setIsRunning(false)
    }
  }

  // NLP Text Parser Trigger
  async function handleNlpParse() {
    setIsParsingText(true)
    setError('')
    setParsedCriteria(null)

    try {
      const parsed = await apiRequest('/nlp-parse', {
        method: 'POST',
        body: JSON.stringify({ text: intakeText })
      })
      setParsedCriteria(parsed)
      setForm({
        condition: parsed.condition,
        age: String(parsed.minAge || 18),
        homeCountry: form.homeCountry
      })
    } catch (requestError) {
      setError(`NLP Parsing failed: ${requestError.message}`)
    } finally {
      setIsParsingText(false)
    }
  }

  // Handle PDF Protocol File upload
  async function handleFileUpload(e) {
    const file = e.target.files[0]
    if (!file) return
    setSelectedFile(file)
    setIsUploadingFile(true)
    setError('')
    setParsedCriteria(null)

    const formData = new FormData()
    formData.append('protocolFile', file)

    try {
      const res = await fetch(`${API_BASE}/upload-protocol`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`
        },
        body: formData
      })

      if (!res.ok) {
        const msg = await res.json()
        throw new Error(msg.message || 'File upload failed')
      }

      const data = await res.json()
      setParsedCriteria(data.parseResult)
      setIntakeText(`--- EXTRACTED PDF PROTOCOL SNIPPET ---\n${data.extractedSnippet}\n...`)
      setForm({
        condition: data.parseResult.condition,
        age: String(data.parseResult.minAge || 18),
        homeCountry: form.homeCountry
      })
    } catch (requestError) {
      setError(`PDF parsing failed: ${requestError.message}`)
    } finally {
      setIsUploadingFile(false)
    }
  }

  function applyParsedCriteria() {
    if (!parsedCriteria) return
    setActiveTab('map')
    runLookup()
  }

  // Register Patient interest
  async function handleRegisterPatient(e) {
    e.preventDefault()
    setIsRegisteringPatient(true)
    setError('')

    try {
      const res = await apiRequest('/patients', {
        method: 'POST',
        body: JSON.stringify(patientForm)
      })

      // Update local states
      setPatientsList([res.patient, ...patientsList])
      
      // Fetch fresh alerts
      const freshAlerts = await apiRequest('/alerts')
      setTelemetryAlerts(freshAlerts)

      // Alert info overlay
      alert(`Patient registered successfully! Generated ${res.alertsGeneratedCount} Sponsor Telemetry alerts across hidden trials.`)

      // Reset patient registration form
      setPatientForm({
        name: '',
        email: '',
        condition: form.condition,
        age: form.age,
        country: form.homeCountry
      })
    } catch (requestError) {
      setError(`Patient registration failed: ${requestError.message}`)
    } finally {
      setIsRegisteringPatient(false)
    }
  }

  async function handleManualScrapeTrigger(event) {
    event.preventDefault()
    setIsTriggeringScraper(true)
    setError('')

    try {
      const res = await apiRequest('/scraper-trigger', {
        method: 'POST',
        body: JSON.stringify({
          registry: selectedScrapeRegistry,
          proxyNodeId: selectedScrapeProxy
        })
      })
      setSelectedScraperRun(res.run)
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setIsTriggeringScraper(false)
    }
  }

  async function saveConfig() {
    setIsSavingConfig(true)
    setError('')

    try {
      const nextConfig = await apiRequest('/config', {
        method: 'POST',
        body: JSON.stringify(config),
      })
      setConfig(nextConfig)
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setIsSavingConfig(false)
    }
  }

  async function mountProxyDefaults() {
    setIsMounting(true)
    setError('')

    try {
      const nextProfile = await apiRequest('/proxies', {
        method: 'POST',
        body: JSON.stringify({
          provider: 'Torch Labs',
          credentialProfile: 'demo-redacted',
          nodes: [],
        }),
      })
      setProxyProfile(nextProfile)
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setIsMounting(false)
    }
  }

  // RENDER LOGIN SCREEN IF NO TOKEN
  if (!token) {
    return (
      <main className="login-overlay-container">
        <div className="login-card glass-card animate-fade-in">
          <div className="login-header">
            <p className="eyebrow">Eco Hackers / Track 2</p>
            <h2>TrialScope Secure Portal</h2>
            <p className="description">Enter administrative credentials to mount search controller.</p>
          </div>
          {error && <div className="error-strip" role="alert">{error}</div>}
          <form onSubmit={handleLogin} className="login-form">
            <div className="form-group">
              <label htmlFor="loginUsername">Username</label>
              <input
                id="loginUsername"
                type="text"
                value={loginUsername}
                onChange={(e) => setLoginUsername(e.target.value)}
                className="theme-input"
                required
              />
            </div>
            <div className="form-group">
              <label htmlFor="loginPassword">Password</label>
              <input
                id="loginPassword"
                type="password"
                value={loginPassword}
                onChange={(e) => setLoginPassword(e.target.value)}
                className="theme-input"
                required
              />
            </div>
            <button type="submit" className="primary-action glowing-btn full-width" disabled={isLoggingIn}>
              {isLoggingIn ? 'Verifying Session...' : 'Authenticate Access'}
            </button>
          </form>
          <div className="login-footer">
            <small>Default pre-seeded access: <code>admin</code> / <code>admin123</code></small>
          </div>
        </div>
      </main>
    )
  }

  return (
    <main className="app-shell">
      <header className="topbar glass-card">
        <div className="branding">
          <p className="eyebrow">Eco Hackers / Track 2</p>
          <h1>TrialScope</h1>
          <p className="subhead">Global Clinical Trial Access Monitor</p>
        </div>
        <div className="system-status">
          <div className="user-profile-badge">
            User: <strong>{username}</strong>
            <button className="logout-btn" onClick={handleLogout}>Logout</button>
          </div>
          <div className="db-badge">
            Storage: <span>{health?.databaseStatus || 'checking...'}</span>
          </div>
          <div className={`system-pill ${controllerOnline ? 'online' : 'offline'}`}>
            <span aria-hidden="true" className="pulse-dot"></span>
            {controllerOnline ? 'Controller online' : 'Controller offline'}
          </div>
        </div>
      </header>

      {error ? <div className="error-strip animate-fade-in" role="alert">{error}</div> : null}

      {/* Tab Navigation */}
      <nav className="tab-navigation">
        <button 
          className={`tab-btn ${activeTab === 'parser' ? 'active' : ''}`}
          onClick={() => setActiveTab('parser')}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>
          Intake & Patient Registry
        </button>
        <button 
          className={`tab-btn ${activeTab === 'map' ? 'active' : ''}`}
          onClick={() => setActiveTab('map')}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"></circle><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"></path><path d="M2 12h20"></path></svg>
          Live Map Monitor
        </button>
        <button 
          className={`tab-btn ${activeTab === 'scraper' ? 'active' : ''}`}
          onClick={() => setActiveTab('scraper')}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg>
          Ingestion & Scraper Log
          {scraperHistory.active.length > 0 && <span className="active-badge">{scraperHistory.active.length}</span>}
        </button>
        <button 
          className={`tab-btn ${activeTab === 'settings' ? 'active' : ''}`}
          onClick={() => setActiveTab('settings')}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
          System Settings
        </button>
      </nav>

      {/* Tab Contents */}
      <div className="tab-content">
        
        {/* TAB 1: Intake & Patient Registry */}
        {activeTab === 'parser' && (
          <section className="intake-section animate-fade-in">
            <div className="parser-grid">
              
              {/* PDF & Unstructured Text Ingest Panel */}
              <div className="glass-card parse-input-panel">
                <div className="section-heading">
                  <p>Semantic Ingestion Layer</p>
                  <h2>Protocol PDF & Unstructured Text Intake</h2>
                </div>
                <p className="description">
                  Upload a PDF document or paste criteria details below. The system extracts raw text via Python <code>pypdf</code> and triggers semantic analysis to identify clinical eligibility boundaries.
                </p>

                {/* PDF File Uploader zone */}
                <div className="pdf-upload-zone" onClick={() => fileInputRef.current.click()}>
                  <input
                    type="file"
                    ref={fileInputRef}
                    onChange={handleFileUpload}
                    accept="application/pdf"
                    style={{ display: 'none' }}
                  />
                  <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>
                  <p>
                    {isUploadingFile ? 'Reading PDF pages...' : selectedFile ? `Uploaded: ${selectedFile.name}` : 'Drag & Drop or Click to Upload Protocol PDF'}
                  </p>
                </div>

                <div className="text-divider"><span>OR PASTE TEXT DIRECTLY</span></div>

                <textarea
                  id="protocolText"
                  value={intakeText}
                  onChange={(e) => setIntakeText(e.target.value)}
                  placeholder="Paste clinical trial protocol details..."
                  className="protocol-textarea"
                />
                <button 
                  className="primary-action full-width glowing-btn" 
                  onClick={handleNlpParse} 
                  disabled={isParsingText}
                >
                  {isParsingText ? (
                    <>
                      <span className="spinner"></span> Extracting criteria...
                    </>
                  ) : 'Extract Parameters with Semantic Model'}
                </button>
              </div>

              {/* Extracted Criteria & Patient Registration Panel */}
              <div className="glass-card parse-output-panel">
                
                {parsedCriteria ? (
                  <div className="extracted-criteria-container">
                    <div className="section-heading">
                      <p>Telemetry mapping Schema</p>
                      <h2>Extracted Constraints</h2>
                    </div>
                    <div className="extracted-criteria">
                      <div className="criteria-row">
                        <span className="criteria-label">Condition:</span>
                        <strong className="criteria-value tag-teal">{parsedCriteria.condition}</strong>
                      </div>
                      <div className="criteria-row">
                        <span className="criteria-label">Min/Max Age:</span>
                        <strong className="criteria-value">{parsedCriteria.minAge} - {parsedCriteria.maxAge} years</strong>
                      </div>
                      <div className="criteria-row">
                        <span className="criteria-label">Clinical Phase:</span>
                        <strong className="criteria-value tag-blue">{parsedCriteria.phase}</strong>
                      </div>
                      <div className="criteria-row">
                        <span className="criteria-label">Cross-Border Travel:</span>
                        <strong className={`criteria-value ${parsedCriteria.acceptsCrossBorder ? 'text-green' : 'text-rose'}`}>
                          {parsedCriteria.acceptsCrossBorder ? 'ACCEPTED' : 'NOT ALLOWED'}
                        </strong>
                      </div>
                      <div className="criteria-row">
                        <span className="criteria-label">Site Locations:</span>
                        <strong className="criteria-value list-countries">
                          {formatCountries(parsedCriteria.siteCountries)}
                        </strong>
                      </div>

                      <div className="button-row">
                        <button className="primary-action glowing-btn" onClick={applyParsedCriteria}>
                          Load into Map Lookup
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="patient-registration-container">
                    <div className="section-heading">
                      <p>Sponsor Cohort Alerter</p>
                      <h2>Patient Enrollment Intake</h2>
                    </div>
                    <p className="description">
                      Register patients seeking matches. If registered condition matches trials hidden from home but accepting cross-border, a sponsor alert is auto-generated and dispatched.
                    </p>
                    <form onSubmit={handleRegisterPatient} className="patient-form">
                      <div className="form-group">
                        <label htmlFor="patientName">Patient Name</label>
                        <input
                          id="patientName"
                          type="text"
                          value={patientForm.name}
                          onChange={(e) => setPatientForm({ ...patientForm, name: e.target.value })}
                          className="theme-input"
                          required
                        />
                      </div>
                      <div className="form-group">
                        <label htmlFor="patientEmail">Email Address</label>
                        <input
                          id="patientEmail"
                          type="email"
                          value={patientForm.email}
                          onChange={(e) => setPatientForm({ ...patientForm, email: e.target.value })}
                          className="theme-input"
                          required
                        />
                      </div>
                      
                      <div className="input-grid">
                        <div className="form-group">
                          <label htmlFor="patientAge">Age</label>
                          <input
                            id="patientAge"
                            type="number"
                            value={patientForm.age}
                            onChange={(e) => setPatientForm({ ...patientForm, age: e.target.value })}
                            className="theme-input"
                            required
                          />
                        </div>
                        <div className="form-group">
                          <label htmlFor="patientCountry">Home Country</label>
                          <select
                            id="patientCountry"
                            value={patientForm.country}
                            onChange={(e) => setPatientForm({ ...patientForm, country: e.target.value })}
                            className="theme-input"
                          >
                            <option>Sri Lanka</option>
                            <option>India</option>
                            <option>Singapore</option>
                            <option>United Kingdom</option>
                            <option>United States</option>
                          </select>
                        </div>
                      </div>

                      <div className="form-group">
                        <label htmlFor="patientCond">Diagnostic Condition</label>
                        <input
                          id="patientCond"
                          type="text"
                          value={patientForm.condition}
                          onChange={(e) => setPatientForm({ ...patientForm, condition: e.target.value })}
                          className="theme-input"
                          required
                        />
                      </div>

                      <button type="submit" className="primary-action glowing-btn full-width" disabled={isRegisteringPatient}>
                        {isRegisteringPatient ? 'Registering Patient...' : 'Enroll & Match Cohorts'}
                      </button>
                    </form>
                  </div>
                )}
              </div>
            </div>

            {/* Enrolled Patients List */}
            <div className="patients-log-grid">
              <div className="glass-card enrolled-patients-panel">
                <div className="section-heading">
                  <p>Database Core</p>
                  <h2>Registered Patients</h2>
                </div>
                <div className="patients-list-table">
                  <div className="patients-header-row">
                    <span>Name</span>
                    <span>Age / Country</span>
                    <span>Condition</span>
                  </div>
                  {patientsList.length > 0 ? (
                    patientsList.map(p => (
                      <div key={p.id} className="patient-item-row">
                        <div>
                          <strong>{p.name}</strong>
                          <small>{p.email}</small>
                        </div>
                        <span>{p.age} y / {p.country}</span>
                        <span className="tag-outline">{p.condition}</span>
                      </div>
                    ))
                  ) : (
                    <div className="empty-patients-log">No patients currently enrolled.</div>
                  )}
                </div>
              </div>

              {/* Patient Cohort Webhooks telemetry logs */}
              <div className="glass-card telemetry-alerts-history-panel">
                <div className="section-heading">
                  <p>Sponsor Cohort Alerter</p>
                  <h2>Notification Telemetry Feed (PostgreSQL)</h2>
                </div>
                <div className="alerts-history-feed">
                  {telemetryAlerts.length > 0 ? (
                    telemetryAlerts.map(alert => (
                      <div key={alert.id} className="alerts-feed-row">
                        <div className="alerts-feed-header">
                          <span className="badge-dispatched">dispatched</span>
                          <span className="time">{alert.notifiedAt.split('T')[1].slice(0,8)}</span>
                        </div>
                        <p>{alert.logs}</p>
                        <small>Trial: {alert.trialTitle} ({alert.sponsor})</small>
                      </div>
                    ))
                  ) : (
                    <div className="empty-alerts-log">No sponsor notification triggers recorded.</div>
                  )}
                </div>
              </div>
            </div>

          </section>
        )}

        {/* TAB 2: Access Map Monitor */}
        {activeTab === 'map' && (
          <section className="monitor-section animate-fade-in">
            <section className="control-band" aria-label="TrialScope controls">
              <form className="query-panel glass-card" onSubmit={runLookup}>
                <div className="section-heading">
                  <p>Eligibility intake</p>
                  <h2>Diagnostic search parameters</h2>
                </div>
                <label htmlFor="condition">Diagnostic condition</label>
                <textarea
                  id="condition"
                  value={form.condition}
                  rows="3"
                  onChange={(event) => setForm({ ...form, condition: event.target.value })}
                  className="theme-input"
                />

                <div className="input-grid">
                  <div>
                    <label htmlFor="age">Age</label>
                    <input
                      id="age"
                      min="1"
                      max="100"
                      type="number"
                      value={form.age}
                      onChange={(event) => setForm({ ...form, age: event.target.value })}
                      className="theme-input"
                    />
                  </div>
                  <div>
                    <label htmlFor="homeCountry">Home country</label>
                    <select
                      id="homeCountry"
                      value={form.homeCountry}
                      onChange={(event) => setForm({ ...form, homeCountry: event.target.value })}
                      className="theme-input"
                    >
                      <option>Sri Lanka</option>
                      <option>India</option>
                      <option>Singapore</option>
                      <option>United Kingdom</option>
                      <option>United States</option>
                    </select>
                  </div>
                </div>

                <button className="primary-action glowing-btn" type="submit" disabled={isRunning}>
                  {isRunning ? 'Analyzing registries...' : 'Search Across Global Nodes'}
                </button>
              </form>

              <div className="metric-band-vertical">
                <article className="metric glass-card">
                  <span>Unique trials cataloged</span>
                  <strong>{summary.totalUniqueTrials}</strong>
                  <small>{summary.registriesSearched} registries scanned</small>
                </article>
                <article className="metric warning glass-card">
                  <span>Hidden Opportunities</span>
                  <strong className="text-amber">{summary.hiddenOpportunities}</strong>
                  <small>{summary.visibleFromHome} visible from home direct</small>
                </article>
                <article className="metric success glass-card">
                  <span>Cross-border matches</span>
                  <strong className="text-green">{summary.crossBorderAccepting}</strong>
                  <small>{summary.sponsorAlerts} active sponsor alerts</small>
                </article>
              </div>
            </section>

            <div className="workspace-grid">
              <section className="map-surface glass-card" aria-label="Regional visibility map">
                <div className="section-heading">
                  <p>Global access portal</p>
                  <h2>Five-node visibility overlay</h2>
                </div>
                <div className="access-map">
                  <svg className="map-lines-svg" viewBox="0 0 100 100" preserveAspectRatio="none">
                    {nodes.map(node => (
                      <line
                        key={`line-${node.id}`}
                        x1="66"
                        y1="50"
                        x2={node.mapPosition?.x || 50}
                        y2={node.mapPosition?.y || 50}
                        className={`map-line ${node.status}`}
                      />
                    ))}
                  </svg>
                  
                  <div className="home-baseline">
                    <span>Home direct ({form.homeCountry})</span>
                    <strong>{summary.visibleFromHome}</strong>
                  </div>
                  
                  {nodes.map((node) => (
                    <div
                      className={`map-node ${node.status} ${selectedNodeDetails?.id === node.id ? 'selected' : ''}`}
                      key={node.id}
                      style={{
                        left: `${node.mapPosition?.x || 50}%`,
                        top: `${node.mapPosition?.y || 50}%`,
                      }}
                      onClick={() => setSelectedNodeDetails(node)}
                      title={`${node.label}: ${node.visibleCount || 0} visible trials`}
                    >
                      <span className="ping-radar"></span>
                      <span>{node.countryCode}</span>
                      <strong>{node.visibleCount || 0}</strong>
                    </div>
                  ))}
                </div>
              </section>

              <section className="telemetry-surface glass-card" aria-label="Proxy telemetry">
                <div className="section-heading">
                  <p>Proxy nodes telemetry</p>
                  <h2>Routing Core</h2>
                </div>
                
                {selectedNodeDetails ? (
                  <div className="selected-node-detail-panel animate-fade-in">
                    <div className="panel-header">
                      <h3>{selectedNodeDetails.label} ({selectedNodeDetails.country})</h3>
                      <button className="close-details-btn" onClick={() => setSelectedNodeDetails(null)}>✕</button>
                    </div>
                    <div className="stats-box">
                      <div className="stat-row">
                        <span>Latency:</span>
                        <strong>{formatMs(selectedNodeDetails.latencyMs)}</strong>
                      </div>
                      <div className="stat-row">
                        <span>Success Rate:</span>
                        <strong className="text-green">{formatPercent(selectedNodeDetails.successRate)}</strong>
                      </div>
                      <div className="stat-row">
                        <span>Block Ratio:</span>
                        <strong className="text-rose">{formatPercent(selectedNodeDetails.blockRatio)}</strong>
                      </div>
                      <div className="stat-row">
                        <span>Registries targets:</span>
                        <span className="registries-list-inline">{selectedNodeDetails.registryTargets.join(', ')}</span>
                      </div>
                      <div className="stat-row">
                        <span>Status:</span>
                        <span className={`status-text ${selectedNodeDetails.status}`}>{selectedNodeDetails.status}</span>
                      </div>
                    </div>
                    <div className="node-trial-highlights">
                      <h4>Visible Trials ({selectedNodeDetails.visibleCount})</h4>
                      <div className="mini-trial-list">
                        {trials
                          .filter(t => t.visibleVia.includes(selectedNodeDetails.id))
                          .map(t => (
                            <div key={`highlight-${t.id}`} className="mini-trial-row">
                              <strong>{t.title}</strong>
                              <span>{t.sponsor} | {t.phase}</span>
                            </div>
                          ))}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="node-list">
                    {nodes.map((node) => (
                      <article 
                        className={`node-row clickable ${selectedNodeDetails?.id === node.id ? 'active' : ''}`} 
                        key={node.id}
                        onClick={() => setSelectedNodeDetails(node)}
                      >
                        <div>
                          <strong>{node.label}</strong>
                          <span>{node.region}</span>
                        </div>
                        <div className="node-stat">
                          <span>{formatMs(node.latencyMs)}</span>
                          <small>latency</small>
                        </div>
                        <div className="node-stat">
                          <span>{formatPercent(node.successRate)}</span>
                          <small>success</small>
                        </div>
                        <div className="node-meter" aria-label={`${node.label} visible trial coverage`}>
                          <span style={{ width: `${((node.visibleCount || 0) / maxVisible) * 100}%` }}></span>
                        </div>
                        <div className={`node-status ${node.status}`}>{node.status}</div>
                      </article>
                    ))}
                  </div>
                )}
              </section>
            </div>

            <section className="data-grid">
              <section className="table-surface glass-card" aria-label="Trial opportunity gap">
                <div className="section-heading">
                  <p>Opportunity gap mapping</p>
                  <h2>Matched Trial Records</h2>
                </div>
                <div className="trial-table" role="table">
                  <div className="trial-row trial-header" role="row">
                    <span>Trial Protocol details</span>
                    <span>Sponsor</span>
                    <span>Sites countries</span>
                    <span>Access state</span>
                  </div>
                  {trials.length > 0 ? (
                    trials.map((trial) => (
                      <div className="trial-row" role="row" key={trial.id}>
                        <div>
                          <strong>{trial.title}</strong>
                          <small>{trial.phase} / {trial.eligibility} / {trial.registry} / ID: {trial.id}</small>
                        </div>
                        <span>{trial.sponsor}</span>
                        <span>{formatCountries(trial.siteCountries)}</span>
                        <div>
                          <span className={trial.hiddenFromHome ? 'gap-pill hidden' : 'gap-pill visible'}>
                            {trial.hiddenFromHome ? 'Hidden from Home' : 'Visible'}
                          </span>
                          <small>{trial.matchScore}% match score</small>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="empty-trials">No matching trials found.</div>
                  )}
                </div>
              </section>

              <section className="alert-surface glass-card" aria-label="Sponsor cohort alerts">
                <div className="section-heading">
                  <p>Sponsor cohort alerter</p>
                  <h2>Telemetry feed</h2>
                </div>
                <div className="alert-list">
                  {alerts.length > 0 ? (
                    alerts.map((alert) => (
                      <article className={`alert-row ${alert.severity}`} key={alert.id}>
                        <div>
                          <strong>{alert.sponsor}</strong>
                          <span>{alert.trialId}</span>
                        </div>
                        <p>{alert.message}</p>
                        <small>{alert.estimatedCohort} estimated cohort leads in {form.homeCountry}</small>
                      </article>
                    ))
                  ) : (
                    <div className="empty-alerts">No sponsor cohort telemetry generated.</div>
                  )}
                </div>
              </section>
            </section>
          </section>
        )}

        {/* TAB 3: Ingestion & Scraper Log */}
        {activeTab === 'scraper' && (
          <section className="scraper-section animate-fade-in">
            <div className="scraper-grid">
              
              <div className="glass-card trigger-panel-container">
                <div className="section-heading">
                  <p>Orchestrator Control</p>
                  <h2>Trigger Ingestion Worker</h2>
                </div>
                <p className="description">
                  Spawn a headless Python worker using requests and <code>psycopg2</code> to query ClinicalTrials.gov live v2 API or Pfizer/Roche mock targets.
                </p>
                <form onSubmit={handleManualScrapeTrigger} className="manual-scrape-form">
                  <div className="form-group">
                    <label htmlFor="scraperRegistry">Target Registry Database</label>
                    <select
                      id="scraperRegistry"
                      value={selectedScrapeRegistry}
                      onChange={(e) => setSelectedScrapeRegistry(e.target.value)}
                      className="theme-input"
                    >
                      {config.registries.map(r => (
                        <option key={r} value={r}>{r}</option>
                      ))}
                    </select>
                  </div>
                  
                  <div className="form-group">
                    <label htmlFor="scraperProxy">Residential Proxy Gateway</label>
                    <select
                      id="scraperProxy"
                      value={selectedScrapeProxy}
                      onChange={(e) => setSelectedScrapeProxy(e.target.value)}
                      className="theme-input"
                    >
                      {proxyProfile.nodes.map(n => (
                        <option key={n.id} value={n.id}>{n.label} ({n.countryCode})</option>
                      ))}
                    </select>
                  </div>

                  <button 
                    type="submit" 
                    className="primary-action glowing-btn full-width"
                    disabled={isTriggeringScraper}
                  >
                    {isTriggeringScraper ? 'Spawning Worker process...' : 'Launch Playwright Worker'}
                  </button>
                </form>

                <div className="historical-database-runs">
                  <h3>Historical Scraping Ingests (PostgreSQL)</h3>
                  <div className="ingest-history-list">
                    {scraperHistory.databaseHistory.length > 0 ? (
                      scraperHistory.databaseHistory.map(log => (
                        <div key={log.id} className="ingest-history-row">
                          <div>
                            <strong>{log.registry}</strong>
                            <span>Node: {log.proxyNodeId}</span>
                          </div>
                          <div>
                            <span className={`status-badge ${log.status}`}>{log.status}</span>
                            <small>{log.trialsScraped} trials found</small>
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="empty-history">No runs stored in the database.</div>
                    )}
                  </div>
                </div>
              </div>

              <div className="glass-card scraper-logs-panel">
                <div className="section-heading">
                  <p>Process Monitor</p>
                  <h2>Headless Python Worker Output</h2>
                </div>
                
                <div className="active-process-list">
                  <h3>Active Workers</h3>
                  {scraperHistory.active.length > 0 ? (
                    scraperHistory.active.map(run => (
                      <div 
                        key={run.id} 
                        className={`active-process-row ${selectedScraperRun?.id === run.id ? 'selected' : ''}`}
                        onClick={() => setSelectedScraperRun(run)}
                      >
                        <span className="spinner-mini"></span>
                        <div>
                          <strong>{run.registry}</strong>
                          <span>Route: {run.proxyNodeId}</span>
                        </div>
                        <span className="timestamp">{run.startedAt.split('T')[1].slice(0,8)}</span>
                      </div>
                    ))
                  ) : (
                    <div className="no-active-workers">No active processes running.</div>
                  )}
                </div>

                <div className="terminal-console-container">
                  <div className="terminal-header">
                    <span>Shell Console</span>
                    <span className="dot-indicators">
                      <span className="dot-red"></span>
                      <span className="dot-yellow"></span>
                      <span className="dot-green"></span>
                    </span>
                  </div>
                  <div className="terminal-body">
                    {selectedScraperRun ? (
                      <div className="terminal-content">
                        <div className="terminal-info">
                          === WORKER METADATA ===<br/>
                          RUN ID: {selectedScraperRun.id}<br/>
                          REGISTRY: {selectedScraperRun.registry}<br/>
                          PROXY NODE: {selectedScraperRun.proxyNodeId}<br/>
                          STATUS: {selectedScraperRun.status.toUpperCase()}<br/>
                          STARTED AT: {selectedScraperRun.startedAt}<br/>
                          ========================
                        </div>
                        {selectedScraperRun.logs.map((line, idx) => (
                          <div key={idx} className="terminal-line">{line}</div>
                        ))}
                        <div ref={terminalEndRef} />
                      </div>
                    ) : (
                      <div className="terminal-empty">
                        <p>No process selected. Choose an active run above or check recent history runs.</p>
                      </div>
                    )}
                  </div>
                </div>

                <div className="recent-runs-list">
                  <h3>Recent Executions</h3>
                  <div className="recent-history-rows">
                    {scraperHistory.recentHistory.map(run => (
                      <div 
                        key={run.id} 
                        className={`recent-run-row ${selectedScraperRun?.id === run.id ? 'selected' : ''}`}
                        onClick={() => setSelectedScraperRun(run)}
                      >
                        <div>
                          <strong>{run.registry}</strong>
                          <span>Proxy: {run.proxyNodeId}</span>
                        </div>
                        <div>
                          <span className={`status-text-badge ${run.status}`}>{run.status}</span>
                          <span className="time">{run.finishedAt?.split('T')?.[1]?.slice(0, 8) || 'running'}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

            </div>
          </section>
        )}

        {/* TAB 4: System Settings */}
        {activeTab === 'settings' && (
          <section className="settings-section animate-fade-in">
            <div className="settings-grid">
              
              <section className="config-panel glass-card" aria-label="Controller configuration">
                <div className="section-heading">
                  <p>Controller configuration</p>
                  <h2>Runtime settings</h2>
                </div>
                
                <div className="input-group">
                  <label htmlFor="interval">Background Ingestion Interval, minutes</label>
                  <input
                    id="interval"
                    min="1"
                    type="number"
                    value={config.ingestionIntervalMinutes}
                    onChange={(event) => {
                      setConfig({ ...config, ingestionIntervalMinutes: Number(event.target.value) })
                    }}
                    className="theme-input"
                  />
                </div>
                
                <div className="input-group">
                  <label htmlFor="timeout">Network Request Timeout, milliseconds</label>
                  <input
                    id="timeout"
                    min="1000"
                    step="500"
                    type="number"
                    value={config.requestTimeoutMs}
                    onChange={(event) => {
                      setConfig({ ...config, requestTimeoutMs: Number(event.target.value) })
                    }}
                    className="theme-input"
                  />
                </div>

                <div className="input-group">
                  <label htmlFor="workers">Max Parallel Worker Processes</label>
                  <input
                    id="workers"
                    min="1"
                    max="20"
                    type="number"
                    value={config.maxParallelWorkers}
                    onChange={(event) => {
                      setConfig({ ...config, maxParallelWorkers: Number(event.target.value) })
                    }}
                    className="theme-input"
                  />
                </div>

                <div className="input-group">
                  <label htmlFor="registries">Configured Target Registries</label>
                  <input id="registries" readOnly value={config.registries.length} className="theme-input read-only" />
                  <div className="registry-tags">
                    {config.registries.map(r => (
                      <span key={r} className="registry-tag">{r}</span>
                    ))}
                  </div>
                </div>

                <div className="button-row">
                  <button type="button" className="primary-action glowing-btn" onClick={saveConfig} disabled={isSavingConfig}>
                    {isSavingConfig ? 'Saving...' : 'Save Controller Config'}
                  </button>
                  <button type="button" className="secondary-action" onClick={mountProxyDefaults} disabled={isMounting}>
                    {isMounting ? 'Mounting...' : 'Mount Default Proxy Nodes'}
                  </button>
                </div>
              </section>

              <section className="glass-card proxy-management-panel">
                <div className="section-heading">
                  <p>Credentials Node mapping</p>
                  <h2>Residential Proxy Configuration</h2>
                </div>
                <div className="credentials-info">
                  <div className="info-row">
                    <span>Provider Network:</span>
                    <strong>{proxyProfile.provider || 'Torch Labs'}</strong>
                  </div>
                  <div className="info-row">
                    <span>Credential profile:</span>
                    <strong>{proxyProfile.credentialProfile}</strong>
                  </div>
                  <div className="info-row">
                    <span>Authentication status:</span>
                    <strong className="text-green">Active (SSL routed session)</strong>
                  </div>
                  <div className="info-row">
                    <span>Country overlaps:</span>
                    <span>US, DE, UK, SG, IN pools mounted</span>
                  </div>
                </div>
                <div className="developer-box">
                  <h3>Adapter Interface</h3>
                  <p>
                    All requests through these 5 regional nodes will overlay dynamic custom headers, hiding standard scraping headers using Puppeteer Stealth and browser fingerprint signatures. You can modify custom proxy username and password in this profile configuration.
                  </p>
                </div>
              </section>

            </div>
          </section>
        )}

      </div>
    </main>
  )
}

export default App
