import { createClient } from 'npm:@supabase/supabase-js@2.57.4'
import { extractCompanyPage, extractCompanyText, isPublicHttpUrl } from './worker-core.ts'
import { validateAudienceCandidate, buildAudienceExpansionQueryPlan } from './audience-validation.mjs'

const url = Deno.env.get('SUPABASE_URL')!
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const supabase = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
const WORKER_TOKEN_SHA256 = '2f52bc258b4d8a563858e4b297c300772b07cdebb1ce98619bcaabce879b1acc'
const MAX_BODY_BYTES = 500_000
const JINA_API_KEY = Deno.env.get('JINA_API_KEY') || ''
const GOOGLE_PLACES_API_KEY = Deno.env.get('GOOGLE_PLACES_API_KEY') || ''

type ClaimedJob = { job_id: string, seed_id: string, url: string, claim_token: string, source_ref?: string | null }
type WatchSource = { source_id: string, workspace_slug: string, company_name: string, source_type: string, source_url: string, signal_type: string, claim_token: string, last_content_hash?: string | null }
type FetchPayload = { content: string, finalUrl: string, contentType: string, retrievalMethod: 'http' | 'jina_reader', isHtml: boolean }

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}

function boundedCode(error: unknown): string {
  return (error instanceof Error ? error.message : 'fetch_failed').slice(0, 80).replace(/[^a-zA-Z0-9_:-]/g, '_')
}

async function readBounded(response: Response): Promise<string> {
  const text = await response.text()
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) throw new Error('response_too_large')
  return text
}

async function fetchDirect(start: string): Promise<FetchPayload> {
  let current = start
  for (let redirectCount = 0; redirectCount <= 4; redirectCount++) {
    if (!isPublicHttpUrl(current)) throw new Error('unsafe_target')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 12_000)
    let response: Response
    try {
      response = await fetch(current, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'user-agent': 'Mozilla/5.0 (compatible; GrowthIntelligenceBot/0.2; public-web-research)',
          'accept': 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
          'accept-language': 'en-US,en;q=0.8,ar;q=0.6',
        },
      })
    } catch (error) {
      if (controller.signal.aborted) throw new Error('fetch_timeout')
      throw error
    } finally {
      clearTimeout(timer)
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) throw new Error('redirect_without_location')
      if (redirectCount >= 4) throw new Error('redirect_limit_exceeded')
      const next = new URL(location, current).toString()
      if (!isPublicHttpUrl(next)) throw new Error('unsafe_redirect')
      current = next
      continue
    }
    if (!response.ok) throw new Error(`http_${response.status}`)
    const contentType = response.headers.get('content-type') || ''
    const isHtml = /text\/html|application\/xhtml\+xml/i.test(contentType)
    if (!isHtml && !/text\/plain/i.test(contentType)) throw new Error('unsupported_content_type')
    return { content: await readBounded(response), finalUrl: current, contentType, retrievalMethod: 'http', isHtml }
  }
  throw new Error('redirect_limit_exceeded')
}

async function fetchViaJina(target: string): Promise<FetchPayload> {
  if (!isPublicHttpUrl(target)) throw new Error('unsafe_target')
  const response = await fetch(`https://r.jina.ai/${target}`, {
    redirect: 'manual',
    headers: { 'accept': 'text/plain', 'x-return-format': 'markdown', 'user-agent': 'GrowthIntelligenceBot/0.2' },
  })
  if (!response.ok) throw new Error(`reader_http_${response.status}`)
  const content = await readBounded(response)
  if (/Warning:\s*Target URL returned error\s+(?:401|403|429)|# Access Denied/i.test(content)) throw new Error('reader_target_blocked')
  return { content, finalUrl: target, contentType: 'text/markdown', retrievalMethod: 'jina_reader', isHtml: false }
}

async function fetchWithFallback(target: string): Promise<FetchPayload> {
  try {
    return await fetchDirect(target)
  } catch (error) {
    const code = boundedCode(error)
    if (/^http_(403|408|409|425|429|500|502|503|504)$/.test(code) || /^error_sending_request/.test(code) || ['fetch_failed', 'fetch_timeout', 'unsupported_content_type', 'response_too_large', 'redirect_limit_exceeded'].includes(code)) {
      return await fetchViaJina(target)
    }
    throw error
  }
}

function extractFetched(payload: FetchPayload) {
  return payload.isHtml
    ? extractCompanyPage(payload.content, payload.finalUrl)
    : extractCompanyText(payload.content, payload.finalUrl)
}

async function claimJobs(limit: number): Promise<ClaimedJob[]> {
  const { data, error } = await supabase.rpc('growth_live_claim_jobs', { p_limit: limit })
  if (error) throw error
  return Array.isArray(data) ? data : []
}

async function claimWatchSources(limit: number): Promise<WatchSource[]> {
  const { data, error } = await supabase.rpc('growth_live_claim_watch_sources', { p_limit: limit })
  if (error) throw error
  return Array.isArray(data) ? data : []
}

async function complete(jobId: string, claimToken: string, result: Record<string, unknown>) {
  const { error } = await supabase.rpc('growth_live_complete_job', { p_job_id: jobId, p_claim_token: claimToken, p_result: result })
  if (error) throw error
}

async function fail(jobId: string, claimToken: string, code: string) {
  const { error } = await supabase.rpc('growth_live_fail_job', { p_job_id: jobId, p_claim_token: claimToken, p_error_code: code })
  if (error) throw error
}

function sectorFitScore(sector: string, text: string): number {
  const sec = sector.toLowerCase().trim()
  const t = text.toLowerCase()
  if (/logistic|لوجست/.test(sec)) {
    const strong = [
      'logistics services','freight forwarding','freight services','warehousing','warehouse services',
      '3pl','third party logistics','cargo services','shipping services','transport services',
      'last mile','fulfillment','fulfilment','customs clearance','project logistics','cold chain'
    ]
    const hits = strong.filter(term => t.includes(term)).length
    if (hits >= 3) return 0.95
    if (hits === 2) return 0.85
    if (hits === 1 && /(logistic|freight|cargo|warehouse|shipping|transport)/.test(t)) return 0.70
    if (/(logistics company|logistics provider|freight forwarder|3pl provider)/.test(t)) return 0.65
    return 0.20
  }
  if (sec && t.includes(sec)) return 0.75
  const words = sec.split(/\s+/).filter(w => w.length >= 4)
  const hits = words.filter(w => t.includes(w)).length
  return hits >= Math.max(1, Math.ceil(words.length / 2)) ? 0.60 : 0.20
}

async function onDemandContext(seedId: string) {
  const candidate = await supabase.from('growth_live_candidates')
    .select('candidate_id,request_id')
    .eq('seed_id', seedId)
    .maybeSingle()
  if (candidate.error || !candidate.data) return null
  const request = await supabase.from('growth_live_audience_requests')
    .select('request_id,sector,geography,target_count,query_plan')
    .eq('request_id', candidate.data.request_id)
    .maybeSingle()
  if (request.error || !request.data) return null
  return { candidate: candidate.data, request: request.data }
}

async function setCandidateOutcome(seedId: string, status: 'researched' | 'rejected', fitScore: number, reason: string | null) {
  const { error } = await supabase.rpc('growth_live_set_candidate_outcome', {
    p_seed_id: seedId,
    p_status: status,
    p_fit_score: fitScore,
    p_reason: reason,
  })
  if (error) throw error
}

const VALIDATION_VERSION = 'sector-fit-v5'

async function markCandidateValidation(seedId: string, validation: any) {
  const { error } = await supabase.from('growth_live_candidates')
    .update({
      validation_version: VALIDATION_VERSION,
      validated_at: new Date().toISOString(),
      validation_evidence: {
        decision: validation.decision,
        reason: validation.reason,
        score: validation.score,
        evidence: Array.isArray(validation.evidence) ? validation.evidence : [],
      },
    })
    .eq('seed_id', seedId)
  if (error) throw error
}

async function processJob(job: ClaimedJob) {
  const target = String(job.url || '')
  if (!isPublicHttpUrl(target)) {
    await fail(job.job_id, job.claim_token, 'unsafe_target')
    return { ok: false, jobId: job.job_id, code: 'unsafe_target' }
  }
  try {
    const fetched = await fetchWithFallback(target)
    const extracted = extractFetched(fetched)
    if (!isPublicHttpUrl(extracted.canonicalUrl)) throw new Error('unsafe_canonical')
    const ondemand = await onDemandContext(job.seed_id)
    const validation = ondemand
      ? validateAudienceCandidate({
          sector: String(ondemand.request.sector || ''),
          geography: String(ondemand.request.geography || ''),
          sourceUrl: extracted.canonicalUrl,
          title: extracted.title,
          description: extracted.description,
          text: extracted.contentHashInput,
        })
      : { decision: 'accept', reason: null, score: 1, evidence: [] }
    const fitScore = Number(validation.score || 0)
    if (ondemand && validation.decision === 'reject') {
      await setCandidateOutcome(job.seed_id, 'rejected', fitScore, String(validation.reason || 'rejected'))
      await markCandidateValidation(job.seed_id, validation)
      await complete(job.job_id, job.claim_token, {
        rejected: true,
        reason: validation.reason,
        fitScore,
        validationVersion: VALIDATION_VERSION,
        validationEvidence: validation.evidence,
        retrievalMethod: fetched.retrievalMethod,
      })
      return { ok: true, jobId: job.job_id, rejected: true, code: validation.reason, fitScore }
    }
    const hash = await sha256(extracted.contentHashInput)
    const { data, error } = await supabase.rpc('growth_live_ingest_fetch', {
      p_seed_id: job.seed_id,
      p_job_id: job.job_id,
      p_url: extracted.canonicalUrl,
      p_title: extracted.title,
      p_description: extracted.description,
      p_content_hash: hash,
      p_emails: extracted.emails,
      p_signal_types: extracted.signalTypes,
    })
    if (error) throw error
    await complete(job.job_id, job.claim_token, {
      ingested: true,
      canonicalUrl: extracted.canonicalUrl,
      contentHash: hash,
      retrievalMethod: fetched.retrievalMethod,
      fitScore,
      graph: data,
    })
    if (ondemand) {
      await setCandidateOutcome(job.seed_id, 'researched', fitScore, null)
      await markCandidateValidation(job.seed_id, validation)
    }
    return { ok: true, jobId: job.job_id, retrievalMethod: fetched.retrievalMethod, fitScore, validationVersion: ondemand ? VALIDATION_VERSION : null }
  } catch (error) {
    const code = boundedCode(error)
    await fail(job.job_id, job.claim_token, code)
    return { ok: false, jobId: job.job_id, code }
  }
}

async function processWatchSource(source: WatchSource) {
  try {
    const fetched = await fetchWithFallback(source.source_url)
    const extracted = extractFetched(fetched)
    const contentHash = await sha256(extracted.contentHashInput)
    const changed = !source.last_content_hash || source.last_content_hash !== contentHash
    const isCareers = source.source_type === 'official_careers'
    const promote = isCareers
      ? extracted.hasFreshHiringEvidence || (changed && extracted.signalTypes.includes('hiring_signal'))
      : changed
    const signalType = isCareers && (extracted.hasFreshHiringEvidence || extracted.signalTypes.includes('hiring_signal'))
      ? 'hiring_signal'
      : source.signal_type || 'fresh_presence'
    const observedAt = extracted.hasFreshHiringEvidence && extracted.latestContentDate
      ? extracted.latestContentDate
      : new Date().toISOString()
    const { data, error } = await supabase.rpc('growth_live_record_watch_result', {
      p_source_id: source.source_id,
      p_claim_token: source.claim_token,
      p_content_hash: contentHash,
      p_canonical_url: extracted.canonicalUrl,
      p_observed_at: observedAt,
      p_signal_type: signalType,
      p_should_promote: promote,
      p_retrieval_method: fetched.retrievalMethod,
      p_note: extracted.hasFreshHiringEvidence ? 'dated_current_job_activity' : (changed ? 'source_content_changed' : 'source_unchanged'),
    })
    if (error) throw error
    return { ok: true, sourceId: source.source_id, promoted: Boolean(data?.promoted), signalType, retrievalMethod: fetched.retrievalMethod }
  } catch (error) {
    const code = boundedCode(error)
    const { error: recordError } = await supabase.rpc('growth_live_record_watch_failure', {
      p_source_id: source.source_id,
      p_claim_token: source.claim_token,
      p_error_code: code,
    })
    if (recordError) throw recordError
    return { ok: false, sourceId: source.source_id, code }
  }
}



const BLOCKED_DISCOVERY_DOMAINS = [
  'linkedin.com','facebook.com','instagram.com','x.com','twitter.com','youtube.com','wikipedia.org',
  'goodfirms.co','clutch.co','crunchbase.com','zoominfo.com','apollo.io','glassdoor.com','indeed.com',
  'mot.gov.sa','tga.gov.sa','google.com','maps.google.com','mapquest.com','yelp.com','yellowpages.com',
  'mordorintelligence.com','ruzave.com','gulftalent.com','freightnet.com','fiata.org','themanifest.com',
  'racklify.com','ensun.io','aeroleads.com','f6s.com','clickpost.ai','scribd.com','infobelpro.com',
  'quora.com','pmc.ncbi.nlm.nih.gov','ncbi.nlm.nih.gov','imarcgroup.com','kenresearch.com','techsciresearch.com','revenuebase.ai','foodlogistics.com','pl-alliance.com'
]

function normalizeCandidateDomain(rawUrl: string): string | null {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase().replace(/\\.$/, '').replace(/^www\\./, '')
    if (!host || BLOCKED_DISCOVERY_DOMAINS.some(d => host === d || host.endsWith('.' + d))) return null
    return host
  } catch {
    return null
  }
}

function looksLikeCompanyResult(title: string | null, content: string | null, sector: string): boolean {
  const t = (title || '').toLowerCase()
  const c = (content || '').toLowerCase()
  if (/\\b(top|best)\\s+\\d*|directory|members directory|companies in|company list|list of|reviews|market report|robot challenge|security checkpoint|checking your browser/.test(t)) return false
  const lowerSector = sector.toLowerCase()
  const terms = /logistic|لوجست/.test(lowerSector)
    ? ['logistic','freight','warehouse','3pl','supply chain','shipping','cargo','transport']
    : [lowerSector]
  return terms.some(term => t.includes(term) || c.includes(term))
}

function companyNameFromResult(title: string | null, domain: string): string {
  const raw = (title || '').replace(/\\s+/g, ' ').trim()
  if (!raw) return domain.split('.')[0]
  const first = raw.split(/\\s+[|–—]\\s+|\\s+-\\s+/)[0]?.trim() || raw
  return first.slice(0, 240)
}

function buildQueryPlan(sector: string, geography: string, targetCount: number): string[] {
  const s = sector.trim()
  const g = geography.trim()
  const lower = s.toLowerCase()
  const terms = [s]
  if (/logistic|لوجست/.test(lower)) terms.push('freight forwarding','3PL','warehousing','supply chain','shipping logistics','transport logistics')
  if (/health|medical|hospital|صح/.test(lower)) terms.push('healthcare','medical services','hospitals','health technology')
  if (/construct|real estate|مقاول|عقار/.test(lower)) terms.push('construction','contracting','real estate development','engineering services')
  if (/tech|software|digital|تقن/.test(lower)) terms.push('technology','software','digital transformation','IT services')
  const cities = /saudi|ksa|السعود/i.test(g)
    ? ['Riyadh','Jeddah','Dammam','Khobar','Jubail','Makkah','Medina']
    : []
  const queries: string[] = []
  for (const term of [...new Set(terms)]) queries.push(`${term} companies in ${g} official website`)
  for (const city of cities) queries.push(`${s} company ${city} Saudi Arabia official website`)
  queries.push(`${s} services in ${g} company website`)
  queries.push(`${s} ${g} careers company official website`)
  const maxQueries = targetCount >= 100 ? 15 : targetCount >= 50 ? 12 : 8
  return [...new Set(queries)].slice(0, maxQueries)
}

function buildExpansionQueryPlan(sector: string, geography: string, existing: string[]): string[] {
  return buildAudienceExpansionQueryPlan(sector, geography, existing, 15)
}

async function searchAndRecordCandidates(requestId: string, sector: string, queryPlan: string[]) {
  const searchRuns = await Promise.all(queryPlan.map(async (query, queryIndex) => {
    try {
      const result = await runJinaSearch(query)
      return { query, queryIndex, result }
    } catch (error) {
      return { query, queryIndex, result: { results: [] }, error: boundedCode(error) }
    }
  }))
  let rawResults = 0
  let accepted = 0
  for (const run of searchRuns) {
    const results = Array.isArray((run.result as any)?.results) ? (run.result as any).results : []
    rawResults += results.length
    for (let rank = 0; rank < results.length; rank++) {
      const item = results[rank]
      const sourceUrl = String(item?.url || '')
      const domain = normalizeCandidateDomain(sourceUrl)
      if (!domain || !isPublicHttpUrl(sourceUrl)) continue
      const title = typeof item?.title === 'string' ? item.title : null
      const snippet = typeof item?.content === 'string' ? item.content : null
      if (!looksLikeCompanyResult(title, snippet, sector)) continue
      const companyName = companyNameFromResult(title, domain)
      const publishedRaw = item?.publishedAt ? String(item.publishedAt) : null
      const publishedAt = publishedRaw && !Number.isNaN(new Date(publishedRaw).valueOf()) ? new Date(publishedRaw).toISOString() : null
      const saved = await supabase.rpc('growth_live_record_candidate', {
        p_request_id: requestId,
        p_company_name: companyName,
        p_source_url: sourceUrl,
        p_normalized_domain: domain,
        p_source_query: run.query,
        p_source_rank: run.queryIndex * 100 + rank,
        p_snippet: snippet,
        p_published_at: publishedAt,
      })
      if (!saved.error) accepted += 1
    }
  }
  return { rawResults, accepted }
}

async function expandAudience(body: any) {
  const requestId = String(body.requestId || '').trim()
  if (!requestId) throw new Error('request_id_required')
  const request = await supabase.from('growth_live_audience_requests')
    .select('request_id,sector,geography,target_count,query_plan')
    .eq('request_id', requestId)
    .maybeSingle()
  if (request.error || !request.data) throw new Error('request_not_found')

  const verifiedQuery = await supabase.from('growth_live_candidates')
    .select('candidate_id', { count: 'exact', head: true })
    .eq('request_id', requestId)
    .eq('status', 'researched')
  if (verifiedQuery.error) throw verifiedQuery.error
  const verifiedBefore = Number(verifiedQuery.count || 0)
  const targetCount = Number(request.data.target_count || 100)
  const deficit = Math.max(0, targetCount - verifiedBefore)
  if (deficit <= 0) {
    return { ok: true, mode: 'expand_audience', requestId, targetReached: true, verifiedBefore, queries: 0, rawResults: 0, acceptedCandidates: 0, promoted: 0 }
  }

  const existing = Array.isArray(request.data.query_plan) ? request.data.query_plan.map(String) : []
  const queries = buildExpansionQueryPlan(String(request.data.sector), String(request.data.geography), existing)
  if (!queries.length) {
    const exhausted = await supabase.from('growth_live_audience_requests')
      .update({ status: 'searching', last_error_code: 'query_pool_exhausted', updated_at: new Date().toISOString() })
      .eq('request_id', requestId)
    if (exhausted.error) throw exhausted.error
    return { ok: true, mode: 'expand_audience', requestId, exhausted: true, verifiedBefore, deficit, queries: 0, rawResults: 0, acceptedCandidates: 0, promoted: 0 }
  }

  const found = await searchAndRecordCandidates(requestId, String(request.data.sector), queries)
  const update = await supabase.from('growth_live_audience_requests')
    .update({
      query_plan: [...existing, ...queries],
      status: 'searching',
      last_error_code: null,
      updated_at: new Date().toISOString(),
    })
    .eq('request_id', requestId)
  if (update.error) throw update.error

  const promoteLimit = Math.min(Math.max(deficit * 2, 15), 100)
  const promoted = await supabase.rpc('growth_live_promote_request_candidates', {
    p_request_id: requestId,
    p_limit: promoteLimit,
  })
  if (promoted.error) throw promoted.error

  return {
    ok: true,
    mode: 'expand_audience',
    requestId,
    verifiedBefore,
    deficit,
    queries: queries.length,
    rawResults: found.rawResults,
    acceptedCandidates: found.accepted,
    promoted: Number(promoted.data || 0),
  }
}

async function buildAudience(body: any) {
  const sector = String(body.sector || '').trim()
  const geography = String(body.geography || '').trim()
  const targetCount = Math.max(1, Math.min(Number(body.targetCount || 25), 500))
  const workspaceSlug = String(body.workspaceSlug || 'skill-up').trim() || 'skill-up'
  if (!sector || sector.length > 120) throw new Error('invalid_sector')
  if (!geography || geography.length > 160) throw new Error('invalid_geography')

  const queryPlan = buildQueryPlan(sector, geography, targetCount)
  const request = await supabase.rpc('growth_live_create_audience_request', {
    p_workspace_slug: workspaceSlug,
    p_sector: sector,
    p_geography: geography,
    p_target_count: targetCount,
    p_query_plan: queryPlan,
  })
  if (request.error) throw request.error
  const requestId = String(request.data)

  const found = await searchAndRecordCandidates(requestId, sector, queryPlan)
  const rawResults = found.rawResults
  const accepted = found.accepted

  const coverageQueries = queryPlan.slice(0, Math.min(3, queryPlan.length))
  const coverageRuns = await Promise.all(coverageQueries.map(async query => {
    try {
      return await runGooglePlacesIdsCoverage(query, 3)
    } catch (error) {
      return { query, count: 0, pages: 0, hasNextPage: false, error: boundedCode(error) }
    }
  }))
  const coverage = { mode: 'ids_only', queries: coverageRuns, checkedAt: new Date().toISOString() }
  const coverageSave = await supabase.rpc('growth_live_set_places_coverage', { p_request_id: requestId, p_coverage: coverage })
  if (coverageSave.error) throw coverageSave.error

  const promoted = await supabase.rpc('growth_live_promote_request_candidates', {
    p_request_id: requestId,
    p_limit: Math.min(targetCount, 200),
  })
  if (promoted.error) throw promoted.error

  return {
    ok: true,
    mode: 'build_audience',
    requestId,
    sector,
    geography,
    targetCount,
    queries: queryPlan.length,
    rawResults,
    acceptedCandidates: accepted,
    promoted: Number(promoted.data || 0),
    placesCoverage: coverageRuns,
  }
}

async function runGooglePlacesIdsSearch(query: string, pageToken: string | null = null) {
  if (!GOOGLE_PLACES_API_KEY) throw new Error('google_places_key_missing')
  const q = query.trim()
  if (!q || q.length > 500) throw new Error('invalid_places_query')
  const requestBody: Record<string, unknown> = { textQuery: q, pageSize: 20 }
  if (pageToken) requestBody.pageToken = pageToken
  const response = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': GOOGLE_PLACES_API_KEY,
      'X-Goog-FieldMask': 'places.id,nextPageToken',
    },
    body: JSON.stringify(requestBody),
  })
  const raw = await response.text()
  if (!response.ok) throw new Error('google_places_http_' + response.status + ':' + raw.slice(0, 300))
  let parsed: any
  try { parsed = JSON.parse(raw) } catch { throw new Error('google_places_invalid_json') }
  const ids = Array.isArray(parsed?.places)
    ? parsed.places.map((p: any) => p?.id).filter((x: any) => typeof x === 'string')
    : []
  return {
    ok: true,
    mode: 'places_ids',
    query: q,
    count: ids.length,
    placeIds: ids,
    nextPageToken: typeof parsed?.nextPageToken === 'string' ? parsed.nextPageToken : null,
    hasNextPage: Boolean(parsed?.nextPageToken),
  }
}

async function runGooglePlacesIdsCoverage(query: string, maxPages = 3) {
  const ids = new Set<string>()
  let token: string | null = null
  let pages = 0
  let hasNextPage = false
  for (let page = 0; page < Math.max(1, Math.min(maxPages, 3)); page++) {
    const result = await runGooglePlacesIdsSearch(query, token)
    pages += 1
    for (const id of result.placeIds) ids.add(id)
    token = result.nextPageToken
    hasNextPage = Boolean(token)
    if (!token) break
  }
  return { query, count: ids.size, pages, hasNextPage }
}

async function runJinaSearch(query: string) {
  if (!JINA_API_KEY) throw new Error('jina_key_missing')
  const q = query.trim()
  if (!q || q.length > 500) throw new Error('invalid_search_query')
  const response = await fetch('https://s.jina.ai/' + encodeURIComponent(q), {
    headers: {
      'Authorization': 'Bearer ' + JINA_API_KEY,
      'Accept': 'application/json',
      'X-Return-Format': 'markdown',
      'User-Agent': 'GrowthIntelligenceBot/0.3',
    },
  })
  if (!response.ok) throw new Error('jina_search_http_' + response.status)
  const raw = await response.text()
  let parsed: any
  try { parsed = JSON.parse(raw) } catch { throw new Error('jina_search_invalid_json') }
  const items = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.data) ? parsed.data : (Array.isArray(parsed?.results) ? parsed.results : []))
  const results = items.slice(0, 10).map((item: any) => ({
    title: typeof item?.title === 'string' ? item.title : null,
    url: typeof item?.url === 'string' ? item.url : (typeof item?.link === 'string' ? item.link : null),
    content: typeof item?.content === 'string' ? item.content.slice(0, 1500) : null,
    publishedAt: item?.publishedTime || item?.published_at || item?.timestamp || null,
  })).filter((item: any) => item.url && isPublicHttpUrl(item.url))
  return { ok: true, mode: 'search', query: q, count: results.length, results }
}


async function revalidateAudience(body: any) {
  const requestId = String(body.requestId || '').trim()
  if (!requestId) throw new Error('request_id_required')
  const batchSize = Math.max(1, Math.min(Number(body.batchSize || 10), 20))

  const request = await supabase.from('growth_live_audience_requests')
    .select('request_id,sector,geography,target_count')
    .eq('request_id', requestId)
    .maybeSingle()
  if (request.error || !request.data) throw new Error('request_not_found')

  const candidates = await supabase.from('growth_live_candidates')
    .select('candidate_id,seed_id,source_url,company_name,status')
    .eq('request_id', requestId)
    .in('status', ['researched','rejected'])
    .or(`validation_version.is.null,validation_version.neq.${VALIDATION_VERSION}`)
    .not('seed_id', 'is', null)
    .order('source_rank', { ascending: true })
    .limit(batchSize)
  if (candidates.error) throw candidates.error

  const results: any[] = []
  for (const candidate of candidates.data || []) {
    const seedId = String(candidate.seed_id || '')
    const target = String(candidate.source_url || '')
    try {
      if (!seedId || !isPublicHttpUrl(target)) throw new Error('unsafe_target')
      const fetched = await fetchWithFallback(target)
      const extracted = extractFetched(fetched)
      const validation = validateAudienceCandidate({
        sector: String(request.data.sector || ''),
        geography: String(request.data.geography || ''),
        sourceUrl: extracted.canonicalUrl,
        title: extracted.title,
        description: extracted.description,
        text: extracted.contentHashInput,
      })

      if (validation.decision === 'reject') {
        await setCandidateOutcome(seedId, 'rejected', Number(validation.score || 0), String(validation.reason || 'rejected'))
      } else if (candidate.status === 'rejected') {
        const job = await supabase.from('growth_live_jobs')
          .select('job_id')
          .eq('seed_id', seedId)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()
        if (job.error || !job.data?.job_id) throw new Error('reingest_job_missing')

        await setCandidateOutcome(seedId, 'researched', Number(validation.score || 0), null)
        try {
          const hash = await sha256(extracted.contentHashInput)
          const ingest = await supabase.rpc('growth_live_ingest_fetch', {
            p_seed_id: seedId,
            p_job_id: job.data.job_id,
            p_url: extracted.canonicalUrl,
            p_title: extracted.title,
            p_description: extracted.description,
            p_content_hash: hash,
            p_emails: extracted.emails,
            p_signal_types: extracted.signalTypes,
          })
          if (ingest.error) throw ingest.error
        } catch (error) {
          await setCandidateOutcome(seedId, 'rejected', Number(validation.score || 0), 'reingest_failed')
          throw error
        }
      } else {
        await setCandidateOutcome(seedId, 'researched', Number(validation.score || 0), null)
      }

      await markCandidateValidation(seedId, validation)
      results.push({
        candidateId: candidate.candidate_id,
        companyName: candidate.company_name,
        previousStatus: candidate.status,
        ok: true,
        decision: validation.decision,
        reason: validation.reason,
        score: validation.score,
        evidence: validation.evidence,
        retrievalMethod: fetched.retrievalMethod,
      })
    } catch (error) {
      results.push({
        candidateId: candidate.candidate_id,
        companyName: candidate.company_name,
        previousStatus: candidate.status,
        ok: false,
        code: boundedCode(error),
      })
    }
  }

  const [verified, rejected, remaining] = await Promise.all([
    supabase.from('growth_live_candidates').select('candidate_id', { count: 'exact', head: true }).eq('request_id', requestId).eq('status', 'researched'),
    supabase.from('growth_live_candidates').select('candidate_id', { count: 'exact', head: true }).eq('request_id', requestId).eq('status', 'rejected'),
    supabase.from('growth_live_candidates').select('candidate_id', { count: 'exact', head: true })
      .eq('request_id', requestId)
      .in('status', ['researched','rejected'])
      .or(`validation_version.is.null,validation_version.neq.${VALIDATION_VERSION}`)
      .not('seed_id', 'is', null),
  ])
  for (const q of [verified, rejected, remaining]) if (q.error) throw q.error

  const verifiedCount = Number(verified.count || 0)
  return {
    ok: true,
    mode: 'revalidate_audience',
    validationVersion: VALIDATION_VERSION,
    requestId,
    processed: results.length,
    accepted: results.filter(x => x.ok && x.decision === 'accept').length,
    rejected: results.filter(x => x.ok && x.decision === 'reject').length,
    failed: results.filter(x => !x.ok).length,
    verifiedCount,
    rejectedCount: Number(rejected.count || 0),
    remaining: Number(remaining.count || 0),
    targetCount: Number(request.data.target_count || 0),
    needsExpansion: verifiedCount < Number(request.data.target_count || 0),
    results,
  }
}

async function maybeAutoExpandAudience() {
  const requests = await supabase.from('growth_live_audience_requests')
    .select('request_id,last_error_code')
    .eq('status', 'searching')
    .order('updated_at', { ascending: true })
    .limit(5)
  if (requests.error) throw requests.error

  for (const request of requests.data || []) {
    if (request.last_error_code === 'query_pool_exhausted') continue
    const pending = await supabase.from('growth_live_candidates')
      .select('candidate_id', { count: 'exact', head: true })
      .eq('request_id', request.request_id)
      .in('status', ['discovered','promoted'])
    if (pending.error) throw pending.error
    if (Number(pending.count || 0) > 0) continue
    return await expandAudience({ requestId: request.request_id })
  }
  return null
}

async function runResearch(limit: number) {
  const jobs = await claimJobs(limit)
  const results = []
  for (const job of jobs) results.push(await processJob(job))
  const autoExpansion = jobs.length === 0 ? await maybeAutoExpandAudience() : null
  return { ok: true, mode: 'research', claimed: jobs.length, results, autoExpansion }
}

async function runDiscovery(limit: number) {
  const sources = await claimWatchSources(limit)
  const results = []
  for (const source of sources) results.push(await processWatchSource(source))
  return { ok: true, mode: 'discover', claimed: sources.length, results }
}

Deno.serve(async (req: Request) => {
  const auth = req.headers.get('authorization') || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  if (!token || await sha256(token) !== WORKER_TOKEN_SHA256) return Response.json({ error: 'unauthorized' }, { status: 401 })
  const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {}
  const limit = Math.max(1, Math.min(Number(body.limit || 3), 5))
  const mode = String(body.mode || 'research')
  if (mode === 'discover') return Response.json(await runDiscovery(limit))
  if (mode === 'research') return Response.json(await runResearch(limit))
  if (mode === 'revalidate_audience') return Response.json(await revalidateAudience(body))
  if (mode === 'expand_audience') return Response.json(await expandAudience(body))
  if (mode === 'build_audience') return Response.json(await buildAudience(body))
  if (mode === 'places_ids') return Response.json(await runGooglePlacesIdsSearch(String(body.query || '')))
  if (mode === 'search') return Response.json(await runJinaSearch(String(body.query || '')))
  if (mode === 'health') return Response.json({ ok: true, mode: 'health', jinaSearchConfigured: Boolean(JINA_API_KEY), googlePlacesConfigured: Boolean(GOOGLE_PLACES_API_KEY) })
  return Response.json({ error: 'invalid_mode' }, { status: 400 })
})
