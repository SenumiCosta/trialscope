const apiKey = process.env.GEMINI_API_KEY || ''

/**
 * Fallback regex-based parser when Gemini API Key is not set.
 * Returns the exact same JSON schema structure as the LLM parser.
 */
function parseWithFallback(text) {
  const normalizedText = text.toLowerCase()

  // 1. Condition extraction
  let condition = 'non-small cell lung cancer'
  if (normalizedText.includes('breast cancer')) {
    condition = 'breast cancer'
  } else if (normalizedText.includes('lung cancer')) {
    condition = 'lung cancer'
  } else if (normalizedText.includes('leukemia') || normalizedText.includes('aml')) {
    condition = 'acute myeloid leukemia'
  } else if (normalizedText.includes('thalassemia')) {
    condition = 'thalassemia'
  } else if (normalizedText.includes('neuromuscular') || normalizedText.includes('spinal muscular')) {
    condition = 'rare neuromuscular disease'
  } else if (normalizedText.includes('alzheimer') || normalizedText.includes('dementia')) {
    condition = 'alzheimer disease'
  } else if (normalizedText.includes('diabetes')) {
    condition = 'type 2 diabetes'
  } else if (normalizedText.includes('ovarian cancer') || normalizedText.includes('ovarian')) {
    condition = 'ovarian cancer'
  } else {
    // Fallback to extracting the first few words of the query
    const words = text.split(/\s+/).slice(0, 5).join(' ').replace(/[^\w\s-]/g, '')
    if (words && words.trim().length > 3) {
      condition = words.trim().toLowerCase()
    }
  }

  // 2. Age boundaries extraction
  let minAge = 18
  let maxAge = 75

  // Regex patterns for age: e.g. "18 to 75 years", "18-75", "min age 21", "max age 80", "age >= 18"
  const ageRangeRegex = /(?:age|ages|eligible)\s*[:\-\s]*\s*(\d+)\s*(?:to|[-/\s])\s*(\d+)\s*(?:years|yo|old)?/i
  const singleAgeMinRegex = /(?:min|minimum|at least|age|from)\s*(?:age|of)?\s*[:\-\s]*\s*(\d+)\s*(?:years|yo|old)?/i
  const singleAgeMaxRegex = /(?:max|maximum|up to|under|age|to)\s*(?:age|of)?\s*[:\-\s]*\s*(\d+)\s*(?:years|yo|old)?/i

  const rangeMatch = text.match(ageRangeRegex)
  if (rangeMatch) {
    minAge = parseInt(rangeMatch[1], 10)
    maxAge = parseInt(rangeMatch[2], 10)
  } else {
    const minMatch = text.match(singleAgeMinRegex)
    if (minMatch) {
      minAge = parseInt(minMatch[1], 10)
    }
    const maxMatch = text.match(singleAgeMaxRegex)
    if (maxMatch) {
      maxAge = parseInt(maxMatch[1], 10)
    }
  }

  // Sanity check bounds
  if (minAge > maxAge) {
    const temp = minAge
    minAge = maxAge
    maxAge = temp
  }

  // 3. Phase extraction
  let phase = 'Phase 2'
  if (/phase\s*3|phase\s*iii/i.test(text)) {
    phase = 'Phase 3'
  } else if (/phase\s*4|phase\s*iv/i.test(text)) {
    phase = 'Phase 4'
  } else if (/phase\s*1\/2|phase\s*i\/ii/i.test(text)) {
    phase = 'Phase 1/2'
  } else if (/phase\s*1|phase\s*i\b/i.test(text)) {
    phase = 'Phase 1'
  } else if (/observational/i.test(text)) {
    phase = 'Observational'
  }

  // 4. Cross border acceptance extraction
  let acceptsCrossBorder = true
  if (/no\s*cross\s*border|only\s*local|does\s*not\s*accept\s*international/i.test(normalizedText)) {
    acceptsCrossBorder = false
  }

  // 5. Site countries extraction
  const countriesPool = [
    { name: 'United States', matches: ['united states', 'us', 'usa', 'america'] },
    { name: 'Germany', matches: ['germany', 'de', 'german', 'deutschland'] },
    { name: 'United Kingdom', matches: ['united kingdom', 'uk', 'britain', 'england'] },
    { name: 'Singapore', matches: ['singapore', 'sg'] },
    { name: 'India', matches: ['india', 'in'] },
    { name: 'Sri Lanka', matches: ['sri lanka', 'lk', 'lankan'] }
  ]

  const siteCountries = []
  countriesPool.forEach(country => {
    const found = country.matches.some(m => {
      const rx = new RegExp(`\\b${m}\\b`, 'i')
      return rx.test(normalizedText)
    })
    if (found) {
      siteCountries.push(country.name)
    }
  })

  // If no countries match, fallback to typical countries based on condition/registry targets
  if (siteCountries.length === 0) {
    siteCountries.push('United States')
    siteCountries.push('Germany')
    siteCountries.push('Singapore')
  }

  return {
    condition,
    minAge,
    maxAge,
    phase,
    acceptsCrossBorder,
    siteCountries
  }
}

/**
 * Main parse entry point.
 * Parses unstructured text protocol and returns the structured JSON output.
 */
async function parseProtocol(text) {
  if (!text || text.trim().length === 0) {
    throw new Error('Empty text content provided to parser.')
  }

  if (!apiKey) {
    console.log('Gemini API key not found. Using structured Regex fallback parser.')
    return parseWithFallback(text)
  }

  console.log('Sending protocol to Gemini API for semantic parsing...')
  const prompt = `You are a clinical trial intake AI. Parse the following clinical trial protocol details or medical text and return a structured JSON matching the database schema requirements.
Extract:
1. "condition": The primary medical condition being studied (lowercase, e.g. "non-small cell lung cancer", "alzheimer disease", "type 2 diabetes"). Keep it concise.
2. "minAge": The minimum age of eligibility (integer). If not specified, default to 18.
3. "maxAge": The maximum age of eligibility (integer). If not specified, default to 75.
4. "phase": The trial phase (e.g., "Phase 1", "Phase 1/2", "Phase 2", "Phase 3", "Phase 4", "Observational"). Default to "Phase 2".
5. "acceptsCrossBorder": A boolean indicating if international patients or cross-border travel is accepted or allowed. Default to true.
6. "siteCountries": An array of country names hosting the trial sites mentioned. If none mentioned, default to ["United States", "Germany", "Singapore"].

Input text:
"""
${text}
"""`

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'OBJECT',
            properties: {
              condition: { type: 'STRING' },
              minAge: { type: 'INTEGER' },
              maxAge: { type: 'INTEGER' },
              phase: { type: 'STRING' },
              acceptsCrossBorder: { type: 'BOOLEAN' },
              siteCountries: { type: 'ARRAY', items: { type: 'STRING' } }
            },
            required: ['condition', 'minAge', 'maxAge', 'phase', 'acceptsCrossBorder', 'siteCountries']
          }
        }
      })
    })

    if (!response.ok) {
      const errText = await response.text()
      throw new Error(`Gemini API call failed with status ${response.status}: ${errText}`)
    }

    const data = await response.json()
    const contentText = data.candidates?.[0]?.content?.parts?.[0]?.text
    if (!contentText) {
      throw new Error('Gemini API returned an empty or invalid response structure.')
    }

    const parsed = JSON.parse(contentText.trim())
    return {
      condition: String(parsed.condition || 'non-small cell lung cancer').toLowerCase().trim(),
      minAge: Number(parsed.minAge ?? 18),
      maxAge: Number(parsed.maxAge ?? 75),
      phase: String(parsed.phase || 'Phase 2'),
      acceptsCrossBorder: Boolean(parsed.acceptsCrossBorder ?? true),
      siteCountries: Array.isArray(parsed.siteCountries) ? parsed.siteCountries.map(String) : ['United States', 'Germany', 'Singapore']
    }
  } catch (err) {
    console.error('Failed to parse with Gemini API. Falling back to Regex parser.', err)
    return parseWithFallback(text)
  }
}

module.exports = {
  parseProtocol,
  parseWithFallback
}
