export type ExtractedCompany = {
  title: string | null
  description: string | null
  canonicalUrl: string
  emails: string[]
  signalTypes: string[]
  contentHashInput: string
  latestContentDate: string | null
  hasFreshHiringEvidence: boolean
}

const MONTHS: Record<string, number> = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
}

function cleanText(value: string): string {
  return value.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

function meta(html: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const a = new RegExp(`<meta[^>]+(?:name|property)=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, 'i').exec(html)?.[1]
  const b = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${escaped}["'][^>]*>`, 'i').exec(html)?.[1]
  return (a || b || null)?.trim() || null
}

function safeCanonical(candidate: string, inputUrl: string): string {
  try {
    const input = new URL(inputUrl)
    const resolved = new URL(candidate, input)
    if (input.protocol === 'https:' && resolved.protocol === 'http:') {
      if (resolved.hostname.toLowerCase() === input.hostname.toLowerCase()) {
        resolved.protocol = 'https:'
        return resolved.toString()
      }
      return input.toString()
    }
    return resolved.toString()
  } catch {
    return inputUrl
  }
}

function findLatestEnglishDate(text: string): Date | null {
  const found: Date[] = []
  const patterns: Array<{ re: RegExp, monthIndex: number, dayIndex: number, yearIndex: number }> = [
    { re: /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2}),?\s+(20\d{2})\b/gi, monthIndex: 1, dayIndex: 2, yearIndex: 3 },
    { re: /\b(\d{1,2})\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(20\d{2})\b/gi, monthIndex: 2, dayIndex: 1, yearIndex: 3 },
  ]
  for (const p of patterns) {
    for (const match of text.matchAll(p.re)) {
      const month = MONTHS[String(match[p.monthIndex]).toLowerCase()]
      const day = Number(match[p.dayIndex])
      const year = Number(match[p.yearIndex])
      if (month === undefined || day < 1 || day > 31 || year < 2020 || year > 2100) continue
      const d = new Date(Date.UTC(year, month, day))
      if (!Number.isNaN(d.valueOf())) found.push(d)
    }
  }
  if (!found.length) return null
  return found.reduce((a, b) => a > b ? a : b)
}

function analyzeText(text: string, now: Date): { emails: string[], signalTypes: string[], latestContentDate: string | null, hasFreshHiringEvidence: boolean } {
  const normalized = text.replace(/\s+/g, ' ').trim().slice(0, 120_000)
  const emails = [...new Set((normalized.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [])
    .map(v => v.toLowerCase())
    .filter(v => !/\.(png|jpg|jpeg|gif|webp|svg)$/i.test(v)))]
    .slice(0, 20)

  const lower = normalized.toLowerCase()
  const signalTypes: string[] = []
  if (/careers|join our team|vacanc|job details|open positions|وظائف|انضم.*فريق/.test(lower)) signalTypes.push('hiring_signal')
  if (/remote|work from home|عن بعد|العمل عن بُعد|العمل عن بعد/.test(lower)) signalTypes.push('remote_work_signal')
  if (/new branch|expansion|expand|افتتاح فرع|التوسع|توسع/.test(lower)) signalTypes.push('expansion_signal')
  if (/training|academy|learning and development|talent development|تدريب|أكاديمية|تطوير/.test(lower)) signalTypes.push('training_signal')

  const latest = findLatestEnglishDate(normalized)
  let hasFreshHiringEvidence = false
  if (latest && signalTypes.includes('hiring_signal')) {
    const ageDays = (now.valueOf() - latest.valueOf()) / 86_400_000
    hasFreshHiringEvidence = ageDays >= -2 && ageDays <= 45
  }
  return {
    emails,
    signalTypes: [...new Set(signalTypes)],
    latestContentDate: latest?.toISOString() || null,
    hasFreshHiringEvidence,
  }
}

export function extractCompanyPage(html: string, inputUrl: string, now = new Date()): ExtractedCompany {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.replace(/\s+/g, ' ').trim() || null
  const description = meta(html, 'description') || meta(html, 'og:description')
  const canonical = /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i.exec(html)?.[1]
    || /<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i.exec(html)?.[1]
    || inputUrl
  const canonicalUrl = safeCanonical(canonical, inputUrl)
  const text = cleanText(html)
  const analysis = analyzeText(text, now)

  return {
    title,
    description,
    canonicalUrl,
    ...analysis,
    contentHashInput: `${canonicalUrl}\n${title || ''}\n${description || ''}\n${text.slice(0, 32_000)}`,
  }
}

export function extractCompanyText(text: string, inputUrl: string, now = new Date()): ExtractedCompany {
  const normalized = text.replace(/\r/g, '').trim()
  const title = /^Title:\s*(.+)$/mi.exec(normalized)?.[1]?.trim()
    || /^#\s+(.+)$/m.exec(normalized)?.[1]?.trim()
    || null
  const analysis = analyzeText(normalized, now)
  return {
    title,
    description: null,
    canonicalUrl: inputUrl,
    ...analysis,
    contentHashInput: `${inputUrl}\n${title || ''}\n\n${normalized.slice(0, 32_000)}`,
  }
}

export function isPublicHttpUrl(raw: string): boolean {
  let u: URL
  try { u = new URL(raw) } catch { return false }
  if (!['http:', 'https:'].includes(u.protocol)) return false
  if (u.username || u.password) return false
  const host = u.hostname.toLowerCase().replace(/\.$/, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return false
  const m = /^172\.(\d{1,3})\./.exec(host)
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return false
  if (/^169\.254\./.test(host) || host === '0.0.0.0' || host === '::1') return false
  return true
}
