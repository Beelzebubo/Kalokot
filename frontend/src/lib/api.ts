// ===================================================================
// KaloKoT API Client
// All endpoints talk to the FastAPI backend at /api. Two transport
// strategies are used:
//   1. formPost()   — general-purpose POST with FormData (most calls)
//   2. raw fetch()  — direct GET or POST for file uploads & plain text
// ===================================================================

const API_BASE = "/api";

// ── Transport helpers ───────────────────────────────

/** Fetch with a timeout signal (milliseconds). */
function fetchWithTimeout(url: string, init?: RequestInit, ms: number = 60_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const requestInit: RequestInit = { ...init, signal: controller.signal };
  return fetch(url, requestInit).finally(() => clearTimeout(timer));
}

/** POST with FormData encoding and a 60‑second timeout.
 * FastAPI expects form params for nearly all endpoints.
 * The return type is determined by the response Content‑Type:
 *   application/pdf  → Blob
 *   audio/mpeg       → Blob
 *   text/plain       → string
 *   anything else    → parsed JSON (generic T)
 */
async function formPost<T>(path: string, data: Record<string, unknown>): Promise<T> {
  const fd = new FormData();
  for (const [k, v] of Object.entries(data)) {
    if (v !== undefined && v !== null) {
      fd.append(k, typeof v === "boolean" ? String(v) : (v as string | Blob));
    }
  }
  const res = await fetchWithTimeout(`${API_BASE}${path}`, { method: "POST", body: fd });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
  }
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/pdf")) return res.blob() as unknown as T;
  if (ct.includes("audio/mpeg")) return res.blob() as unknown as T;
  if (ct.includes("text/plain")) return res.text() as unknown as T;
  return res.json() as Promise<T>;
}

// ── Shared request / response types ───────────────

export interface CounselRequest {
  tender_context?: string;
  question: string;
  jurisdiction?: string;
  risk_report?: unknown;
  report_id?: string;
}

export interface CounselResponse {
  answer: string;
  citations?: { source: string; description: string }[];
  suggested_actions?: string[];
  disclaimer?: string;
  template_name?: string;
}

export interface AnalysisResponse {
  report_id: string;
  overview?: string;
  summary?: string;
  summary_ne?: string;
  overall_risk?: string;
}

export interface ProvidersStatus {
  providers: Record<string, boolean>;
}

/** Fetch LLM provider status (which APIs are configured from env vars). */
export async function getProvidersStatus(): Promise<ProvidersStatus> {
  const res = await fetchWithTimeout(`${API_BASE}/providers`);
  if (!res.ok) throw new Error(`Providers fetch failed: ${res.status}`);
  return res.json();
}

// ── Core API functions ──────────────────────────────

/** Ask the Digital Lawyer a legal question (optionally scoped to a tender context). */
export async function counselQuestion(
  req: CounselRequest,
  provider?: string,
  chat_history?: { role: string; text: string }[],
): Promise<CounselResponse> {
  // If no provider specified, use the effective provider (user key → embedded key)
  const eff = !provider ? getEffectiveProvider() : null;
  const actualProvider = provider || eff?.provider || "";
  let apiKey = ssrSafeGetItem(`kalokot_api_key_${actualProvider}`) || "";
  if (!apiKey && eff) apiKey = eff.key;

  incrementRateCounter();

  return formPost<CounselResponse>("/counsel", {
    question: req.question,
    tender_context: req.tender_context || "",
    jurisdiction: req.jurisdiction || "np",
    provider: actualProvider,
    api_key: apiKey,
    chat_history: chat_history ? JSON.stringify(chat_history) : "",
    report_id: req.report_id,
  });
}

/** Upload a tender file (PDF / image / text) for corruption‑risk analysis. */
export async function analyzeTender(file: File): Promise<AnalysisResponse> {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetchWithTimeout(`${API_BASE}/analyze`, { method: "POST", body: fd });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Upload failed (${res.status}): ${body.slice(0, 200)}`);
  }
  return res.json();
}

/** Analyse pasted tender text (with optional title). */
export async function analyzeTenderText(text: string, title?: string): Promise<AnalysisResponse> {
  return formPost<AnalysisResponse>("/analyze-text", {
    text,
    title: title || "Uploaded Tender",
  });
}

/** Generate a formal complaint letter PDF from the user's personal details + description. */
export async function draftComplaint(
  name: string,
  permanent_address: string,
  temporary_address: string,
  citizenship_no: string,
  phone: string,
  email: string,
  complaint_description: string,
  complaint_date: string = "",
): Promise<Blob> {
  return formPost<Blob>("/draft-complaint", {
    name,
    permanent_address,
    temporary_address,
    citizenship_no,
    phone,
    email,
    complaint_description,
    complaint_date: complaint_date || "",
  });
}

/** Generate a legal analysis report based on a described issue. */
export async function generateAnalysisReport(issue: string): Promise<Blob> {
  return formPost<Blob>("/analysis-report", { issue });
}

/** Store an API key for a provider in localStorage. */
export function setApiKey(provider: string, key: string): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(`kalokot_api_key_${provider}`, key);
}

/** Get a stored API key for a provider from localStorage. */
export function getStoredApiKey(provider: string): string | null {
  return ssrSafeGetItem(`kalokot_api_key_${provider}`);
}

/** Remove a stored API key. */
export function removeApiKey(provider: string): void {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(`kalokot_api_key_${provider}`);
}

/** List all providers that have stored API keys. */
export function getConfiguredProviders(): string[] {
  if (typeof localStorage === "undefined") return [];
  const prefixes: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith("kalokot_api_key_")) {
        prefixes.push(key.replace("kalokot_api_key_", ""));
      }
    }
  } catch {
    /* noop */
  }
  return prefixes;
}

// ── Rate limiting ────────────────────────────────────

interface RateLimitState {
  count: number;
  windowStart: number;
}

const RATE_LIMIT_KEY = "kalokot_rate_limit";
const DEFAULT_LIMIT = 20;
const DEFAULT_WINDOW_MS = 3_600_000; // 1 hour

function getRateLimitConfig(): { limit: number; windowMs: number } {
  return {
    limit: Number(import.meta.env.VITE_RATE_LIMIT) || DEFAULT_LIMIT,
    windowMs: Number(import.meta.env.VITE_RATE_LIMIT_WINDOW_MS) || DEFAULT_WINDOW_MS,
  };
}

function readRateLimit(): RateLimitState {
  if (typeof localStorage === "undefined") return { count: 0, windowStart: Date.now() };
  try {
    const raw = localStorage.getItem(RATE_LIMIT_KEY);
    if (!raw) return { count: 0, windowStart: Date.now() };
    return JSON.parse(raw);
  } catch {
    return { count: 0, windowStart: Date.now() };
  }
}

function writeRateLimit(state: RateLimitState): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(RATE_LIMIT_KEY, JSON.stringify(state));
  } catch {
    /* noop */
  }
}

/** Check if the user is within the free rate limit. */
export function checkRateLimit(): { allowed: boolean; remaining: number; resetMinutes: number } {
  const { limit, windowMs } = getRateLimitConfig();
  const state = readRateLimit();
  const now = Date.now();

  if (now - state.windowStart > windowMs) {
    // Window expired — reset
    const fresh: RateLimitState = { count: 0, windowStart: now };
    writeRateLimit(fresh);
    return { allowed: true, remaining: limit, resetMinutes: 0 };
  }

  const remaining = Math.max(0, limit - state.count);
  const resetMinutes = Math.max(0, Math.ceil((state.windowStart + windowMs - now) / 60_000));

  return {
    allowed: state.count < limit,
    remaining,
    resetMinutes,
  };
}

/** Increment the rate counter. */
export function incrementRateCounter(): void {
  const state = readRateLimit();
  const now = Date.now();
  const { windowMs } = getRateLimitConfig();

  if (now - state.windowStart > windowMs) {
    writeRateLimit({ count: 1, windowStart: now });
  } else {
    writeRateLimit({ count: state.count + 1, windowStart: state.windowStart });
  }
}

// ── Embedded API keys (set at deploy time) ───────────

/** Get the effective provider and key to use, considering user keys, embedded keys, and rate limits. */
export function getEffectiveProvider(): { provider: string; key: string } | null {
  // 1. Check if user has a personal key in localStorage
  const userProviders = getConfiguredProviders();
  for (const p of userProviders) {
    const key = getStoredApiKey(p);
    if (key) return { provider: p, key };
  }

  // 2. Check rate limit
  const { allowed } = checkRateLimit();
  if (!allowed) return null; // Rate limited, no user key

  // 3. Try embedded keys (set via env vars at deploy time)
  const geminiKey = import.meta.env.VITE_GEMINI_API_KEY as string | undefined;
  if (geminiKey) return { provider: "gemini", key: geminiKey };

  const openrouterKey = import.meta.env.VITE_OPENROUTER_API_KEY as string | undefined;
  if (openrouterKey) return { provider: "openrouter", key: openrouterKey };

  return null; // No keys available
}

// ── Provider instructions ────────────────────────────

/** Get step-by-step instructions for getting an API key from a provider. */
export function getApiKeyInstructions(provider: string): string {
  const guides: Record<string, string> = {
    gemini:
      "1. Go to https://aistudio.google.com/apikey\n" +
      "2. Sign in with your Google account\n" +
      '3. Click "Create API Key"\n' +
      "4. Copy the key and paste it below\n" +
      "5. It's free to start with generous usage limits",
    openrouter:
      "1. Go to https://openrouter.ai/keys\n" +
      "2. Sign up or sign in\n" +
      '3. Click "Create Key"\n' +
      "4. Copy the key and paste it below\n" +
      "5. OpenRouter gives access to many models through one API",
    openai:
      "1. Go to https://platform.openai.com/api-keys\n" +
      "2. Sign in to your OpenAI account\n" +
      '3. Click "Create new secret key"\n' +
      "4. Copy the key and paste it below\n" +
      "5. Note: OpenAI requires a paid account with credits",
    anthropic:
      "1. Go to https://console.anthropic.com/\n" +
      "2. Sign in to your Anthropic account\n" +
      "3. Navigate to API Keys section\n" +
      '4. Click "Create Key"\n' +
      "5. Copy the key and paste it below\n" +
      "6. Note: Anthropic requires a paid account",
  };
  return (
    guides[provider] ||
    `Enter your API key for ${provider}. Check the provider's website for instructions.`
  );
}

/** Semantic search over the Constitution of Nepal 2015. */
export async function searchConstitution(
  query: string,
  topK: number = 5,
): Promise<ConstitutionSearchResponse> {
  return formPost<ConstitutionSearchResponse>("/constitution-search", {
    query,
    top_k: topK,
    resolve_parents: true,
  });
}

/** Search case law / statutes by text and jurisdiction. */
export async function searchLegal(
  query: string,
  jurisdiction: string = "NEPAL",
): Promise<LegalSearchResponse> {
  return formPost<LegalSearchResponse>("/legal-search", { query, jurisdiction });
}

/** List available jurisdictions. */
export async function getJurisdictions(): Promise<string[]> {
  const res = await fetchWithTimeout(`${API_BASE}/jurisdictions`);
  if (!res.ok) throw new Error(`Jurisdictions fetch failed: ${res.status}`);
  return res.json();
}

/** Safe localStorage helpers (SSR‑safe) ────────── */
function ssrSafeGetItem(key: string): string | null {
  if (typeof localStorage === "undefined") return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

// ── Constitution search types ───────────────────────

export interface ConstitutionSearchResponse {
  results?: {
    child_id: string;
    child_text: string;
    score: number;
    parent_id: string;
    parent_title: string;
    part_title: string;
    path: string[];
  }[];
  context?: string;
}

export interface LegalSearchResponse {
  results?: { source: string; description: string; relevance: number }[];
}

/** Fetch the full constitution text for browsing. */
export async function getConstitutionContext(): Promise<string> {
  const res = await fetchWithTimeout(`${API_BASE}/constitution-text`);
  if (!res.ok) throw new Error(`Constitution fetch failed: ${res.status}`);
  const data = await res.json();
  return data.text || data.context || "";
}

// Backwards‑compatibility shim for index.tsx (expects formPost).
export { formPost };
