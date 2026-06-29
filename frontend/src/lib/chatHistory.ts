/* ===================================================================
 * Chat History Store — localStorage-based persistent session log
 *
 * Stores full-application-state sessions so users can revisit
 * previous conversations. Each session captures mode, messages,
 * tender context, and complaint intake state for review.
 * =================================================================== */

const STORAGE_KEY = "kalokot_sessions";
const CURRENT_KEY = "kalokot_current_session";
const MAX_SESSIONS = 50;
const MAX_MESSAGES_PER_SESSION = 200;

type Mode = "chat" | "tender" | "analysis" | "complaint";

export interface SessionMessage {
  role: "user" | "assistant";
  text: string;
}

export interface AppSession {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  mode: Mode;
  messages: SessionMessage[];
  tenderContext: string;
  analysisResult: string | null; // JSON-serialized AnalysisResult
  intakeSessionId: string;
  intakeMessages: SessionMessage[];
  intakeCompleted: boolean;
  currentStep: string;
  complainantInfo: Record<string, string>;
  extractedData: any;
  matchedType: string | null;
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function now(): number {
  return Date.now();
}

function loadAll(): AppSession[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as AppSession[];
  } catch {
    return [];
  }
}

function saveAll(sessions: AppSession[]): void {
  const trimmed = sessions.slice(0, MAX_SESSIONS);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
}

export function getSessions(limit: number = 20): AppSession[] {
  return loadAll().sort((a, b) => b.updated_at - a.updated_at).slice(0, limit);
}

export function getSession(id: string): AppSession | undefined {
  return loadAll().find((s) => s.id === id);
}

export function createSession(data: Partial<AppSession> & { title: string }): AppSession {
  const session: AppSession = {
    id: generateId(),
    title: data.title,
    created_at: now(),
    updated_at: now(),
    mode: data.mode || "chat",
    messages: data.messages || [],
    tenderContext: data.tenderContext || "",
    analysisResult: data.analysisResult || null,
    intakeSessionId: data.intakeSessionId || "",
    intakeMessages: data.intakeMessages || [],
    intakeCompleted: data.intakeCompleted || false,
    currentStep: data.currentStep || "conversation",
    complainantInfo: data.complainantInfo || {},
    extractedData: data.extractedData || null,
    matchedType: data.matchedType || null,
  };
  const all = loadAll();
  all.unshift(session);
  saveAll(all);
  return session;
}

export function updateSession(id: string, updates: Partial<AppSession>): void {
  const all = loadAll();
  const idx = all.findIndex((s) => s.id === id);
  if (idx === -1) return;
  all[idx] = { ...all[idx], ...updates, updated_at: now() };
  saveAll(all);
}

export function addMessage(id: string, message: SessionMessage): void {
  const all = loadAll();
  const idx = all.findIndex((s) => s.id === id);
  if (idx === -1) return;
  all[idx].messages.push(message);
  if (all[idx].messages.length > MAX_MESSAGES_PER_SESSION) {
    all[idx].messages = all[idx].messages.slice(-MAX_MESSAGES_PER_SESSION);
  }
  all[idx].updated_at = now();
  saveAll(all);
}

export function deleteSession(id: string): void {
  saveAll(loadAll().filter((s) => s.id !== id));
  if (getCurrentSessionId() === id) {
    localStorage.removeItem(CURRENT_KEY);
  }
}

export function getCurrentSessionId(): string | null {
  return localStorage.getItem(CURRENT_KEY);
}

export function setCurrentSessionId(id: string | null): void {
  if (id) {
    localStorage.setItem(CURRENT_KEY, id);
  } else {
    localStorage.removeItem(CURRENT_KEY);
  }
}

export function clearCurrentSession(): void {
  localStorage.removeItem(CURRENT_KEY);
}
