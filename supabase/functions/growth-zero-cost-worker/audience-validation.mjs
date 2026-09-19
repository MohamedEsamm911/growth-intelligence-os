const NON_COMPANY_DOMAINS = [
  'quora.com','reddit.com','wikipedia.org','pmc.ncbi.nlm.nih.gov','ncbi.nlm.nih.gov',
  'sciencedirect.com','springer.com','researchgate.net','academia.edu',
  'imarcgroup.com','kenresearch.com','techsciresearch.com','mordorintelligence.com',
  'grandviewresearch.com','marketsandmarkets.com','fortunebusinessinsights.com',
  'revenuebase.ai','goodfirms.co','clutch.co','themanifest.com','freightnet.com',
  'fiata.org','pl-alliance.com','foodlogistics.com','logisticsmgmt.com',
];

const SAUDI_TERMS = [
  'saudi arabia','kingdom of saudi arabia','ksa','السعودية','المملكة العربية السعودية',
  'riyadh','jeddah','dammam','khobar','jubail','makkah','mecca','medina','madinah',
  'yanbu','tabuk','qassim','jizan','jazan','abha','kaec','king abdullah economic city',
];

const LOGISTICS_SERVICE_TERMS = [
  'logistics services','logistics solutions','freight forwarding','freight services','warehousing',
  'warehouse services','3pl','third party logistics','4pl','cargo services','air cargo','ocean freight',
  'sea freight','road freight','shipping services','transport services','last mile','last-mile',
  'fulfillment','fulfilment','customs clearance','customs brokerage','project logistics','cold chain',
  'contract logistics','distribution logistics','supply chain solutions','container transport',
  'courier services','express delivery','fleet services','refrigerated transport','distribution',
];

const OPERATOR_TERMS = [
  'our services','we provide','we offer','we deliver','we specialize','we specialise','our fleet',
  'our warehouse','our warehouses','our network','our branches','our locations','contact us','about us',
  'who we are','our company','our offices','our terminals','our facilities','our customers','our clients',
];

const PUBLISHER_TERMS = [
  'market size','market report','market research','industry report','forecast 20','research article',
  'peer reviewed','journal','abstract','doi:','directory','top logistics companies',
  'best logistics companies','list of logistics companies','members directory','compare providers',
];

const SOFTWARE_TERMS = [
  'software platform','saas','carrier management platform','logistics software','delivery management software',
  'shipping software','api for','api integration','integrations platform',
];

function domainOf(rawUrl) {
  try { return new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, '') } catch { return '' }
}
function hasAny(text, terms) { return terms.some(term => text.includes(term)) }
function countHits(text, terms) { return terms.reduce((n, term) => n + (text.includes(term) ? 1 : 0), 0) }
function isNonCompanyDomain(domain) {
  return NON_COMPANY_DOMAINS.some(blocked => domain === blocked || domain.endsWith('.' + blocked))
}
function isSaudiGeography(geography) { return /saudi|ksa|السعود/i.test(geography) }

export function validateAudienceCandidate(input) {
  const sector = String(input.sector || '').toLowerCase().trim()
  const rawUrl = String(input.sourceUrl || input.url || '')
  const domain = domainOf(rawUrl)
  const text = [input.title, input.description, input.text]
    .filter(Boolean).join('\n').toLowerCase().replace(/\s+/g, ' ').slice(0, 160_000)
  const evidence = []

  if (!domain || isNonCompanyDomain(domain)) {
    return { decision: 'reject', reason: 'non_company_source', score: 0.05, evidence: ['blocked_non_company_domain'] }
  }

  if (!/logistic|لوجست/.test(sector)) {
    const words = sector.split(/\s+/).filter(x => x.length >= 4)
    const hits = words.filter(x => text.includes(x)).length
    return hits >= Math.max(1, Math.ceil(words.length / 2))
      ? { decision: 'accept', reason: null, score: 0.70, evidence: ['sector_text_match'] }
      : { decision: 'reject', reason: 'sector_mismatch', score: 0.20, evidence: [] }
  }

  const serviceHits = countHits(text, LOGISTICS_SERVICE_TERMS)
  const operatorHits = countHits(text, OPERATOR_TERMS)
  const publisherHits = countHits(text, PUBLISHER_TERMS)
  const softwareHits = countHits(text, SOFTWARE_TERMS)
  const providerPhrase = /\b(logistics (company|provider|operator)|freight forwarder|shipping company|transport company|3pl provider|4pl provider|customs broker)\b/.test(text)
  const geographyMatch = !isSaudiGeography(String(input.geography || '')) || hasAny(text, SAUDI_TERMS)

  if (serviceHits) evidence.push(`service_hits:${serviceHits}`)
  if (operatorHits) evidence.push(`operator_hits:${operatorHits}`)
  if (publisherHits) evidence.push(`publisher_hits:${publisherHits}`)
  if (softwareHits) evidence.push(`software_hits:${softwareHits}`)
  if (providerPhrase) evidence.push('provider_phrase')
  if (geographyMatch) evidence.push('geography_match')

  if (publisherHits >= 2 && operatorHits === 0 && !providerPhrase) {
    return { decision: 'reject', reason: 'non_company_source', score: 0.15, evidence }
  }
  if (softwareHits >= 1 && operatorHits === 0 && !providerPhrase) {
    return { decision: 'reject', reason: 'sector_mismatch', score: 0.20, evidence }
  }
  if (serviceHits === 0 && !providerPhrase) {
    return { decision: 'reject', reason: 'sector_mismatch', score: 0.20, evidence }
  }
  if (!geographyMatch) {
    return { decision: 'reject', reason: 'geography_mismatch', score: Math.min(0.50, 0.25 + serviceHits * 0.05), evidence }
  }
  if (operatorHits === 0 && !providerPhrase) {
    return { decision: 'reject', reason: 'insufficient_official_evidence', score: Math.min(0.54, 0.30 + serviceHits * 0.05), evidence }
  }

  let score = 0.65 + Math.min(serviceHits, 4) * 0.06 + Math.min(operatorHits, 3) * 0.04
  if (providerPhrase) score += 0.05
  if (geographyMatch) score += 0.05
  score -= Math.min(publisherHits + softwareHits, 2) * 0.04
  return { decision: 'accept', reason: null, score: Math.max(0, Math.min(0.98, score)), evidence }
}

export function buildAudienceExpansionQueryPlan(sector, geography, existing = [], limit = 15) {
  const sec = String(sector || '').trim()
  const geo = String(geography || '').trim()
  const seen = new Set((existing || []).map(String))
  const queries = []
  const push = q => {
    const value = String(q || '').replace(/\s+/g, ' ').trim()
    if (value && !seen.has(value) && !queries.includes(value)) queries.push(value)
  }

  if (/logistic|لوجست/i.test(sec)) {
    const services = [
      '4PL logistics','heavy lift logistics','project cargo','multimodal transport','refrigerated transport',
      'reefer logistics','dangerous goods logistics','hazmat transport','import export logistics','express courier',
      'reverse logistics','retail logistics','FMCG logistics','industrial logistics','oil and gas logistics',
      'chemical logistics','healthcare logistics','medical logistics','ecommerce logistics','B2B fulfillment',
      'bonded warehousing','cross docking','distribution services','inland transportation','road haulage',
      'container haulage','customs brokerage','air freight forwarding','sea freight forwarding','LCL freight',
      'FCL freight','door to door cargo','international freight forwarding','domestic transport','fleet transport',
      'port services logistics','shipping agent','cargo handling','warehouse operator','logistics park operator',
    ]
    const cities = /saudi|ksa|السعود/i.test(geo)
      ? ['Riyadh','Jeddah','Dammam','Khobar','Jubail','Yanbu','Makkah','Medina','Qassim','Jizan','Tabuk','Abha']
      : [geo]

    for (const service of services) push(`${service} ${geo} official company website`)
    for (const city of cities) {
      for (const service of services.slice(0, 18)) {
        push(`${service} company ${city} Saudi Arabia official website`)
      }
    }
    if (/saudi|ksa|السعود/i.test(geo)) {
      for (const q of [
        'شركة خدمات لوجستية الرياض موقع رسمي','شركة شحن دولي الرياض موقع رسمي','شركة تخليص جمركي الرياض موقع رسمي',
        'شركة مستودعات لوجستية جدة موقع رسمي','شركة شحن بحري جدة موقع رسمي','شركة شحن جوي جدة موقع رسمي',
        'شركة نقل بري الدمام موقع رسمي','شركة خدمات موانئ الدمام موقع رسمي','شركة لوجستية الجبيل موقع رسمي',
        'شركة سلسلة إمداد السعودية موقع رسمي','شركة فور بي ال 4PL السعودية موقع رسمي','شركة نقل مبرد السعودية موقع رسمي',
      ]) push(q)
    }
  } else {
    for (const suffix of ['operators','providers','specialists','solutions','services','companies','group','contractors','suppliers']) {
      push(`${sec} ${suffix} ${geo} official company website`)
    }
  }

  return queries.slice(0, Math.max(1, Math.min(Number(limit) || 15, 50)))
}
