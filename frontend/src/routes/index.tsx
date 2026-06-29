// ===================================================================
// KaloKoT — Home Page
// Single-page application hub with four modes:
// 1. Chat  (FAQ / Digital Lawyer)
// 2. Tender Review (upload or paste tender for analysis)
// 3. Complaint (fill details, draft letter PDF)
// 4. Analysis (describe an issue, generate report PDF)
//
// Includes a landing state (mascot + thought bubble) and TTS playback
// for lawyer messages.
// ===================================================================

import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, useRef, useEffect, useCallback } from "react";
import {
  ArrowUp,
  FileText,
  HelpCircle,
  AlertOctagon,
  BarChart3,
  BookOpen,
  Circle,
  KeyRound,
  Cpu,
  User,
  Volume2,
  VolumeX,
  AlertTriangle,
  Download,
  Edit3,
  MapPin,
  Lightbulb,
  MessageCircle,
  Loader2,
  Send,
  Scale,
  Upload,
  X,
  Plus,
} from "lucide-react";
import mascot from "@/assets/mascot.png";
import {
  counselQuestion,
  analyzeTender,
  analyzeTenderText,
  draftComplaint,
  generateAnalysisReport,
  getProvidersStatus,
  setApiKey,
  getStoredApiKey,
  checkRateLimit,
  incrementRateCounter,
  getApiKeyInstructions,
  type CounselResponse,
  type ProvidersStatus,
  type CounselRequest,
} from "@/lib/api";
import {
  speakText as speakTextNative,
  initTts as initTtsNative,
  isTtsAvailable as isTtsAvailableNative,
} from "@/lib/tts";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  getSessions,
  getSession,
  createSession,
  updateSession,
  addMessage as addSessionMessage,
  deleteSession,
  getCurrentSessionId,
  setCurrentSessionId,
  clearCurrentSession,
  type AppSession,
  type SessionMessage,
} from "@/lib/chatHistory";

// ── Types ──────────────────────────────────────────

type Mode = "chat" | "tender" | "analysis" | "complaint";

interface Message {
  role: "user" | "lawyer";
  text: string;
}

interface FlaggedClause {
  id: string;
  label: string;
  severity: string;
  description: string;
  location: string;
  suggestion: string;
  risk_reason?: string;
}

interface AnalysisResult {
  report_id: string;
  overall_risk: string;
  summary: string;
  summary_ne?: string;
  section_scores: Record<string, string>;
  flagged_clauses: FlaggedClause[];
}

function riskColor(level: string): string {
  switch (level) {
    case "critical":
      return "oklch(0.52 0.18 30)";
    case "high":
      return "oklch(0.6 0.16 40)";
    case "medium":
      return "oklch(0.7 0.14 70)";
    default:
      return "oklch(0.6 0.1 150)";
  }
}

function riskBadge(level: string): string {
  const map: Record<string, string> = {
    critical: "CRITICAL",
    high: "HIGH",
    medium: "MEDIUM",
    low: "LOW",
  };
  return map[level] || level.toUpperCase();
}

function severityIcon(sev: string): string {
  switch (sev) {
    case "critical":
      return "🔴";
    case "high":
      return "🟠";
    case "medium":
      return "🟡";
    default:
      return "🟢";
  }
}

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const providers = [
  { value: "", label: "Auto", keyRequired: false },
  { value: "gemini", label: "Gemini", keyRequired: true },
  { value: "anthropic", label: "Claude", keyRequired: true },
  { value: "openai", label: "OpenAI", keyRequired: true },
  { value: "openrouter", label: "OpenRouter", keyRequired: true },
  { value: "rule-based", label: "Default", keyRequired: false },
];

const navItems = [
  { label: "Tender", icon: FileText, mode: "tender" as Mode },
  { label: "Counsel", icon: HelpCircle, mode: "chat" as Mode },
  { label: "Complaint", icon: AlertOctagon, mode: "complaint" as Mode },
  { label: "Analysis", icon: BarChart3, mode: "analysis" as Mode },
  { label: "Constitution", icon: BookOpen, mode: "chat" as Mode },
];

const chips = ["Draft a complaint against a noisy neighbour", "Summarise this tender document"];

// ── Route ──────────────────────────────────────────

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "KaloKoT — Digital Counsel" },
      {
        name: "description",
        content:
          "AI-powered legal assistant for procurement transparency and citizen rights in Nepal.",
      },
    ],
  }),
  component: HomePage,
});

// ── Component ──────────────────────────────────────
function HomePage() {
  const navigate = useNavigate();

  // ── Mode & chat state ────────────────────────
  const [mode, setMode] = useState<Mode>("chat");
  const [messages, setMessages] = useState<Message[]>([
    {
      role: "lawyer",
      text: "Welcome! I'm KaloKoT, your digital legal assistant. I can help you analyze procurement documents, draft complaints, or answer legal questions about Nepal's public procurement laws.",
    },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [speakingId, setSpeakingId] = useState<number | null>(null);
  const speakingRef = useRef(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [ttsError, setTtsError] = useState<string | null>(null);
  const [currentSessionId, setCurrentSessionId_] = useState<string>("");
  const [isViewingHistory, setIsViewingHistory] = useState(false);
  const [recentSessions, setRecentSessions] = useState<AppSession[]>([]);

  // ── Complaint page state ─────────────────────────
  const [complaintType, setComplaintType] = useState<string | null>(null);
  const [complaintTypes, setComplaintTypes] = useState<any[]>([]);
  const [complaintFields, setComplaintFields] = useState<any[]>([]);
  const [draftedComplaint, setDraftedComplaint] = useState<any>(null);
  const [generatingComplaint, setGeneratingComplaint] = useState(false);
  const [currentStep, setCurrentStep] = useState<"conversation" | "review" | "evidence" | "draft">(
    "conversation",
  );
  const [complainantInfo, setComplainantInfo] = useState({
    name: "",
    permanent_address: "",
    temporary_address: "",
    citizenship_no: "",
    phone: "",
    email: "",
    complaint_date: "",
  });
  const [intakeSessionId, setIntakeSessionId] = useState("");
  const [intakeMessages, setIntakeMessages] = useState<
    { role: "user" | "assistant"; text: string }[]
  >([
    {
      role: "assistant",
      text: "Please describe your complaint or the issue you're facing. For example:\n\n\"I want to report a procurement violation in a government tender for road construction in my district.\"\n\nTell me what happened, and I'll ask questions to gather all the information needed.",
    },
  ]);
  const [intakeLoading, setIntakeLoading] = useState(false);
  const [intakeInput, setIntakeInput] = useState("");
  const [intakeCompleted, setIntakeCompleted] = useState(false);
  const [extractedData, setExtractedData] = useState<any>(null);
  const [matchedType, setMatchedType] = useState<string | null>(null);
  const [evidenceItems, setEvidenceItems] = useState<{ file?: File; description: string }[]>([]);
  const intakeBottomRef = useRef<HTMLDivElement>(null);

  /** Fetch available complaint types / templates from the backend. */
  const loadComplaintTypes = useCallback(async () => {
    try {
      const response = await fetch("/api/complaint-types");
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const types: any[] = await response.json();
      if (!Array.isArray(types)) throw new Error("Expected array");
      setComplaintTypes(types);
    } catch {
      const mockTypes = [
        {
          id: "procurement_violation",
          name: "Procurement Violation",
          description: "General procurement violations and irregularities",
          required_fields: ["tender_reference", "violation_description", "estimated_impact"],
        },
        {
          id: "conflict_of_interest",
          name: "Conflict of Interest",
          description: "Allegations of conflicts of interest in procurement",
          required_fields: ["official_name", "contrary_financial_interest", "contract_value"],
        },
        {
          id: "non_performance",
          name: "Non-Performance",
          description: "Failure to perform contract obligations",
          required_fields: ["contract_date", "delivery_details", "actual_performance"],
        },
        {
          id: "budget_misallocation",
          name: "Budget Misallocation",
          description: "Improper allocation or misuse of procurement funds",
          required_fields: ["budget_line", "misallocated_amount", "affected_projects"],
        },
      ];
      setComplaintTypes(mockTypes);
    }
  }, []);

  /** Load complaint types on mount. */
  useEffect(() => {
    loadComplaintTypes();
  }, []);

  /** Auto-scroll intake chat to bottom. */
  useEffect(() => {
    intakeBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [intakeMessages]);

  /** Send a message in the complaint intake conversation. */
  const handleIntakeMessage = useCallback(async () => {
    const text = intakeInput.trim();
    if (!text || intakeLoading) return;
    setIntakeInput("");
    setIntakeMessages((prev) => [...prev, { role: "user", text }]);
    setIntakeLoading(true);

    try {
      const response = await fetch("/api/complaint-intake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, session_id: intakeSessionId || undefined }),
      });
      const data = await response.json();

      if (!intakeSessionId) setIntakeSessionId(data.session_id);
      setIntakeMessages((prev) => [...prev, { role: "assistant", text: data.reply }]);

      if (data.extracted_data) {
        setExtractedData((prev: any) => ({ ...prev, ...data.extracted_data }));
      }
      if (data.matched_type) {
        setMatchedType(data.matched_type);
        setComplaintType(data.matched_type);
      }
      if (data.completed) {
        setIntakeCompleted(true);
      }
    } catch {
      setIntakeMessages((prev) => [
        ...prev,
        { role: "assistant", text: "Sorry, I'm having trouble connecting. Please try again." },
      ]);
    }
    setIntakeLoading(false);
  }, [intakeInput, intakeLoading, intakeSessionId]);

  // ── Core workflow state ───────────────────────────
  const [tenderContext, setTenderContext] = useState<string>("");
  const [tenderReport, setTenderReport] = useState<any>(null);
  const [isLanding, setIsLanding] = useState<boolean>(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [uploadedFileName, setUploadedFileName] = useState<string>("");
  const [pasteText, setPasteText] = useState<string>("");
  const [aiProvider, setAiProvider] = useState<string>("");
  const [providersStatus, setProvidersStatus] = useState<ProvidersStatus | null>(null);
  const [keyDialogOpen, setKeyDialogOpen] = useState(false);
  const [keyDialogProvider, setKeyDialogProvider] = useState<string>("");
  const [keyInputValue, setKeyInputValue] = useState<string>("");

  // ── Session management ──────────────────────────────

  const setSessionId = useCallback((id: string) => {
    setCurrentSessionId_(id);
    setCurrentSessionId(id);
  }, []);

  const clearSessionId = useCallback(() => {
    setCurrentSessionId_("");
    clearCurrentSession();
  }, []);

  const refreshSessionsList = useCallback(() => {
    setRecentSessions(getSessions(20));
  }, []);

  const saveToSession = useCallback(() => {
    if (!currentSessionId) return;
    updateSession(currentSessionId, {
      mode,
      messages: messages as SessionMessage[],
      tenderContext,
      analysisResult: analysisResult ? JSON.stringify(analysisResult) : null,
      intakeSessionId,
      intakeMessages: intakeMessages as SessionMessage[],
      intakeCompleted,
      currentStep,
      complainantInfo: { ...complainantInfo },
      extractedData,
      matchedType,
    });
  }, [currentSessionId, mode, messages, tenderContext, analysisResult, intakeSessionId, intakeMessages, intakeCompleted, currentStep, complainantInfo, extractedData, matchedType]);

  const loadSessionState = useCallback((session: AppSession) => {
    setMode(session.mode as Mode);
    setMessages(session.messages as Message[]);
    setTenderContext(session.tenderContext);
    if (session.analysisResult) {
      try { setAnalysisResult(JSON.parse(session.analysisResult)); } catch { setAnalysisResult(null); }
    } else {
      setAnalysisResult(null);
    }
    setIntakeSessionId(session.intakeSessionId);
    setIntakeMessages(session.intakeMessages as { role: "user" | "assistant"; text: string }[]);
    setIntakeCompleted(session.intakeCompleted);
    setCurrentStep(session.currentStep as "conversation" | "review" | "evidence" | "draft");
    setComplainantInfo(session.complainantInfo as { name: string; permanent_address: string; temporary_address: string; citizenship_no: string; phone: string; email: string; complaint_date: string });
    setExtractedData(session.extractedData);
    setMatchedType(session.matchedType);
    setSessionId(session.id);
  }, [setSessionId]);

  const handleLoadSession = useCallback((session: AppSession) => {
    loadSessionState(session);
    setIsViewingHistory(true);
    refreshSessionsList();
  }, [loadSessionState, refreshSessionsList]);

  const handleBackToCurrent = useCallback(() => {
    const savedId = getCurrentSessionId();
    if (savedId) {
      const session = getSession(savedId);
      if (session) {
        loadSessionState(session);
      } else {
        clearSessionId();
        setMessages([{ role: "lawyer", text: "Welcome! I'm KaloKoT, your digital legal assistant. I can help you analyze procurement documents, draft complaints, or answer legal questions about Nepal's public procurement laws." }]);
        setTenderContext("");
        setAnalysisResult(null);
      }
    }
    setIsViewingHistory(false);
    refreshSessionsList();
  }, [loadSessionState, clearSessionId, refreshSessionsList]);

  const handleNewConversation = useCallback(() => {
    clearSessionId();
    setIsViewingHistory(false);
    setIsLanding(true);
    setMessages([{ role: "lawyer", text: "Welcome! I'm KaloKoT, your digital legal assistant. I can help you analyze procurement documents, draft complaints, or answer legal questions about Nepal's public procurement laws." }]);
    setTenderContext("");
    setAnalysisResult(null);
    setMode("chat");
    refreshSessionsList();
  }, [clearSessionId, refreshSessionsList]);

  // ── Session effects ────────────────────────────────

  /** Restore session from localStorage on mount + load session list. */
  useEffect(() => {
    const savedId = getCurrentSessionId();
    if (savedId) {
      const session = getSession(savedId);
      if (session) {
        loadSessionState(session);
      }
    }
    refreshSessionsList();
  }, []);

  /** Auto-save current state to active session on meaningful changes. */
  useEffect(() => {
    if (currentSessionId) saveToSession();
  }, [currentSessionId, mode, messages, tenderContext, analysisResult, intakeMessages, intakeSessionId, intakeCompleted, currentStep, complainantInfo, extractedData, matchedType]);

  /** Refresh session list when the active session changes. */
  useEffect(() => {
    refreshSessionsList();
  }, [currentSessionId, messages.length]);

  // ── Effects ───────────────────────────────────────

  /** Initialize TTS and fetch provider status on mount. */
  useEffect(() => {
    initTtsNative().catch(() => {});
    getProvidersStatus()
      .then(setProvidersStatus)
      .catch(() => {});
  }, []);

  /** Auto-scroll chat to bottom on new messages. */
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  /** Reset landing state once a user message appears. */
  useEffect(() => {
    if (messages.length > 1) setIsLanding(false);
  }, [messages]);

  /** Sync body class for consistent styling. */
  useEffect(() => {
    document.body.className = "bg-[#fdfcf9] text-[#2d2d2d] font-sans";
    return () => {
      document.body.className = "";
    };
  }, []);

  // ── Core workflow handlers ─────────────────────────

  /** Send a question to the Digital Lawyer with full context preservation. */
  const sendMessage = useCallback(
    async (text?: string) => {
      const q = (text ?? input).trim();
      if (!q || loading) return;
      if (!text) setInput("");
      setIsViewingHistory(false);
      setMessages((m) => [...m, { role: "user", text: q }]);

      // Create session on first user message
      if (!currentSessionId) {
        const title = q.length > 60 ? q.slice(0, 57) + "..." : q;
        const session = createSession({
          title,
          mode,
          messages: [{ role: "user" as const, text: q }],
          tenderContext,
          analysisResult: analysisResult ? JSON.stringify(analysisResult) : null,
        });
        setSessionId(session.id);
        refreshSessionsList();
      } else {
        addSessionMessage(currentSessionId, { role: "user", text: q });
        updateSession(currentSessionId, {
          tenderContext,
          analysisResult: analysisResult ? JSON.stringify(analysisResult) : null,
        });
      }

      setLoading(true);
      try {
        const res: CounselResponse = await counselQuestion(
          {
            question: q,
            tender_context: tenderContext || "",
          },
          aiProvider,
          messages,
        );
        const answer = res.answer;
        setMessages((m) => [...m, { role: "lawyer", text: answer }]);
        if (currentSessionId || getCurrentSessionId()) {
          const sid = currentSessionId || getCurrentSessionId()!;
          addSessionMessage(sid, { role: "assistant", text: answer });
        }
      } catch {
        const fallback =
          "I need my legal backend connected to give you a precise answer. Please make sure the server is running, or try again.";
        setMessages((m) => [...m, { role: "lawyer", text: fallback }]);
      }
      setLoading(false);
    },
    [input, loading, tenderContext, aiProvider, messages, currentSessionId, mode, analysisResult, setSessionId, refreshSessionsList],
  );

  /** Read a lawyer message aloud via browser-native TTS. */
  const handleTts = useCallback(async (text: string, idx: number) => {
    if (speakingRef.current) return;
    speakingRef.current = true;
    setSpeakingId(idx);
    setTtsError(null);
    try {
      await speakTextNative(text);
      setSpeakingId(null);
      speakingRef.current = false;
    } catch (err: unknown) {
      setSpeakingId(null);
      speakingRef.current = false;
      if (err instanceof DOMException && err.name === "NotAllowedError") {
        setAudioBlocked(true);
      } else {
        setTtsError("Audio playback failed — check browser TTS support");
      }
    }
  }, []);

  /** Analyze an uploaded tender file. */
  const handleFileUpload = useCallback(async (file: File) => {
    setUploadedFileName(file.name);
    setAnalyzing(true);
    setAnalysisResult(null);
    setAnalysisError(null);
    try {
      setAnalysisResult((await analyzeTender(file)) as unknown as AnalysisResult);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Upload failed";
      setAnalysisError(msg);
      console.error("Tender analysis failed", e);
    }
    setAnalyzing(false);
  }, []);

  /** Analyze pasted tender text. */
  const handleAnalyzeText = useCallback(async () => {
    if (!pasteText.trim()) return;
    setUploadedFileName("Pasted text");
    setAnalyzing(true);
    setAnalysisResult(null);
    setAnalysisError(null);
    try {
      setAnalysisResult((await analyzeTenderText(pasteText)) as unknown as AnalysisResult);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Analysis failed";
      setAnalysisError(msg);
      console.error("Analyze text failed", e);
    }
    setAnalyzing(false);
  }, [pasteText]);

  /** React to the file‑input change event. */
  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) handleFileUpload(file);
    },
    [handleFileUpload],
  );

  /**
   * Send the analysis summary to the chat lawyer and stay in tender analysis mode.
   * This allows users to ask the digital lawyer about specific flagged clauses
   * and legal issues from their tender analysis without losing context.
   */
  const discussWithLawyer = useCallback(() => {
    if (analysisResult) {
      setTenderContext(analysisResult.summary);
      setTenderReport(analysisResult);
      setMode("chat");
    }
  }, [analysisResult]);


  // ── Complaint page handlers ───────────────────────

  /** Handle complaint type selection. */
  /** Proceed from conversation → review step. */
  const handleProceedToReview = useCallback(() => {
    setCurrentStep("review");
  }, []);

  /** Go back to conversation to add more info. */
  const handleBackToConversation = useCallback(() => {
    setCurrentStep("conversation");
    setIntakeCompleted(false);
  }, []);

  /** Proceed from review → evidence step. */
  const handleProceedToEvidence = useCallback(() => {
    setCurrentStep("evidence");
  }, []);

  /** Handle evidence file selection. */
  const handleEvidenceFile = useCallback((index: number, file: File | undefined) => {
    setEvidenceItems((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], file };
      return next;
    });
  }, []);

  /** Handle evidence description change. */
  const handleEvidenceDesc = useCallback((index: number, description: string) => {
    setEvidenceItems((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], description };
      return next;
    });
  }, []);

  /** Add another evidence item. */
  const handleAddEvidenceItem = useCallback(() => {
    setEvidenceItems((prev) => [...prev, { description: "" }]);
  }, []);

  /** Remove evidence item. */
  const handleRemoveEvidenceItem = useCallback((index: number) => {
    setEvidenceItems((prev) => prev.filter((_, i) => i !== index));
  }, []);

  /** Upload evidence and proceed to draft generation. */
  const handleProceedToDraft = useCallback(async () => {
    setCurrentStep("draft");
    setGeneratingComplaint(true);
    setDraftedComplaint(null);

    try {
      for (const item of evidenceItems) {
        if (item.file) {
          await fetch("/api/upload-evidence", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              session_id: intakeSessionId,
              description: item.description,
              filename: item.file.name,
              file_content: "",
            }),
          });
        }
      }

      const response = await fetch("/api/draft-complaint", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: matchedType || complaintType,
          field_data: extractedData || {},
          complainant_info: {
            name: complainantInfo.name,
            permanent_address: complainantInfo.permanent_address,
            temporary_address: complainantInfo.temporary_address,
            citizenship_no: complainantInfo.citizenship_no,
            phone: complainantInfo.phone,
            email: complainantInfo.email,
            complaint_date:
              complainantInfo.complaint_date || new Date().toISOString().split("T")[0],
          },
        }),
      });

      const result = await response.json();
      if (result.complaint_draft) {
        setDraftedComplaint(result.complaint_draft);
      }
    } catch (error) {
      console.error("Failed to generate complaint:", error);
    } finally {
      setGeneratingComplaint(false);
    }
  }, [matchedType, complaintType, extractedData, complainantInfo, evidenceItems, intakeSessionId]);

  /** Reset complaint page state. */
  const resetComplaintPage = useCallback(() => {
    setComplaintType(null);
    setComplaintFields([]);
    setDraftedComplaint(null);
    setCurrentStep("conversation");
    setComplainantInfo({
      name: "",
      permanent_address: "",
      temporary_address: "",
      citizenship_no: "",
      phone: "",
      email: "",
      complaint_date: "",
    });
    setIntakeSessionId("");
    setIntakeMessages([
      {
        role: "assistant",
        text: "Please describe your complaint or the issue you're facing. For example:\n\n\"I want to report a procurement violation in a government tender for road construction in my district.\"\n\nTell me what happened, and I'll ask questions to gather all the information needed.",
      },
    ]);
    setIntakeCompleted(false);
    setExtractedData(null);
    setMatchedType(null);
    setEvidenceItems([]);
    setMode("tender");
    const keys = [
      "kalokot_intake_session_id",
      "kalokot_intake_messages",
      "kalokot_intake_completed",
      "kalokot_extracted_data",
      "kalokot_matched_type",
      "kalokot_current_step",
      "kalokot_complainant_info",
    ];
    keys.forEach((k) => localStorage.removeItem(k));
  }, []);

  // ── UI event handlers ────────────────────────────

  /** Handle key press in message input. */
  const handleKeyPress = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    },
    [sendMessage],
  );

  /** Handle provider key save. */
  const handleSaveApiKey = useCallback(async () => {
    if (!keyInputValue.trim()) return;
    await setApiKey(keyDialogProvider, keyInputValue.trim());
    setAiProvider(keyDialogProvider);
    setKeyDialogOpen(false);
    setKeyInputValue("");
    // Refresh provider status
    getProvidersStatus()
      .then(setProvidersStatus)
      .catch(() => {});
  }, [keyDialogProvider, keyInputValue]);

  /** Format field value for display. */
  const formatFieldValue = useCallback((field: any, value: any) => {
    if (value === null || value === undefined) return "";
    switch (field.type) {
      case "date":
        const date = new Date(value);
        return date.toLocaleDateString();
      case "number":
        return new Intl.NumberFormat().format(Number(value));
      default:
        return String(value);
    }
  }, []);

  // ── Render ────────────────────────────────────────

  return (
    <div className="min-h-screen bg-[#fdfcf9] text-[#2d2d2d] font-sans">
      {/* Header */}
      <header className="sticky top-0 z-50 w-full border-b border-[#e5e0c4] bg-[#fdfcf9]/95 backdrop-blur supports-[backdrop-filter]:bg-[#fdfcf9]/60">
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-4">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#c9a84b] text-[#fdfcf9]">
              <Circle className="h-4 w-4" />
            </div>
            <span className="text-xl font-bold tracking-tight">KaloKoT</span>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setKeyDialogOpen(true)}
              className="interactive flex items-center gap-2 rounded-lg border border-[#e5e0c4] bg-[#fdfcf9] px-3 py-1.5 text-sm transition-all hover:bg-[#f5f0e6]"
            >
              <KeyRound className="h-4 w-4" />
              {aiProvider || "Setup AI"}
            </button>
          </div>
        </div>
      </header>

      {/* Rate limit banner */}
      {(() => {
        const rl = checkRateLimit();
        if (rl.allowed) return null;
        const hasUserKey = providers.some((p) => p.value && getStoredApiKey(p.value));
        return (
          <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-2 text-xs">
            <span className="text-ink/60">
              Free queries used ({rl.remaining} remaining). Resets in ~{rl.resetMinutes} min.
            </span>
            {!hasUserKey && (
              <button
                onClick={() => setKeyDialogOpen(true)}
                className="font-medium text-gold hover:text-gold/80 transition-colors"
              >
                Enter your own API key
              </button>
            )}
          </div>
        );
      })()}

      {/* Two‑column layout */}
      <div className="mx-3 mt-3 flex gap-3" style={{ minHeight: "calc(100vh - 5rem)" }}>
        {/* Sidebar (desktop only) */}
        <aside className="glass hidden w-64 shrink-0 flex-col rounded-2xl p-4 md:flex">
          <div className="mb-4">
            <p className="text-kicker mb-2 px-2">Sections</p>
            <ul className="space-y-0.5">
              {navItems.map((item) => (
                <li key={item.label}>
                  <button
                    onClick={() => {
                      if (item.label === "Constitution") {
                        navigate({ to: "/constitution" });
                      } else {
                        setMode(item.mode);
                      }
                    }}
                    className={`group interactive flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm transition ${
                      item.label === "Constitution"
                        ? "text-ink/75 hover:bg-paper-dark/60"
                        : mode === item.mode
                          ? "bg-ink/8 text-deep font-medium"
                          : "text-ink/75 hover:bg-paper-dark/60"
                    }`}
                  >
                    <item.icon className="h-4 w-4" />
                    {item.label}
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <div className="h-px bg-ink/10 my-2" />

          <div className="flex items-center justify-between px-2 mb-1">
            <p className="text-kicker">Recents</p>
            <button
              onClick={handleNewConversation}
              className="text-xs text-ink/50 hover:text-ink transition px-1 py-0.5 rounded hover:bg-ink/5"
              title="New conversation"
            >
              + New
            </button>
          </div>
          <div className="flex-1 overflow-y-auto space-y-0.5 min-h-0">
            {recentSessions.length === 0 && (
              <p className="text-xs text-ink/40 px-2">No past conversations</p>
            )}
            {recentSessions.map((s) => {
              const isActive = s.id === currentSessionId;
              const ago = formatRelativeTime(s.updated_at);
              return (
                <button
                  key={s.id}
                  onClick={() => handleLoadSession(s)}
                  className={`w-full text-left rounded-lg px-3 py-2 text-sm transition ${
                    isActive
                      ? "bg-ink/8 text-deep font-medium"
                      : "text-ink/75 hover:bg-paper-dark/60"
                  }`}
                >
                  <span className="block truncate">{s.title}</span>
                  <span className="block text-[11px] text-ink/40 mt-0.5">{ago}</span>
                </button>
              );
            })}
          </div>
        </aside>

        {/* Main stage */}
        <main className="relative flex-1 rounded-2xl overflow-hidden">
          {/* Back-to-current banner */}
          {isViewingHistory && (
            <div className="absolute top-0 left-0 right-0 z-20 flex items-center justify-between bg-gold/10 backdrop-blur-sm px-4 py-2 border-b border-gold/20">
              <span className="text-xs text-ink/70">Viewing a past conversation</span>
              <button
                onClick={handleBackToCurrent}
                className="text-xs font-medium text-gold hover:text-gold-dark transition px-3 py-1 rounded-full border border-gold/30 hover:bg-gold/10"
              >
                Back to Current
              </button>
            </div>
          )}
          {/* Gold glow aura */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                "radial-gradient(520px 360px at 50% 38%, rgba(201,168,76,0.28), transparent 65%)",
            }}
          />

          <div className="relative flex h-full flex-col gap-4 py-4 px-4 sm:py-6 sm:px-6">
            {/* Content area */}
            <div
              className="flex flex-1 flex-col items-center w-full overflow-y-auto animate-fade-in"
              key={mode}
            >
              {/* LANDING STATE (chat mode, only greeting) */}
              {isLanding && mode === "chat" && messages.length === 1 && (
                <div className="flex flex-1 flex-col items-center justify-center w-full">
                  {/* Mascot + thought bubble */}
                  <div className="relative flex flex-col md:flex-row items-center md:items-center justify-center gap-5 md:gap-10 w-full max-w-3xl">
                    {/* Warm halo */}
                    <div
                      aria-hidden
                      className="absolute left-1/2 top-1/2 -z-10 h-[420px] w-[420px] md:h-[520px] md:w-[640px] -translate-x-1/2 -translate-y-1/2 rounded-full blur-3xl animate-fade-in"
                      style={{
                        background:
                          "radial-gradient(ellipse at 50% 45%, rgba(201,168,76,0.32) 0%, rgba(201,168,76,0.12) 40%, transparent 72%)",
                      }}
                    />

                    <div className="relative">
                      <div
                        aria-hidden
                        className="absolute -bottom-2 left-1/2 -z-10 h-8 w-[160px] -translate-x-1/2 rounded-[50%] blur-xl"
                        style={{
                          background:
                            "radial-gradient(ellipse, rgba(13,13,13,0.35), transparent 70%)",
                        }}
                      />
                      <img
                        src={mascot}
                        alt="KaloKoT, the pixel-art judge mascot"
                        width={196}
                        height={284}
                        className="pixelated h-[180px] sm:h-[220px] md:h-[280px] w-auto drop-shadow-[0_24px_20px_rgba(13,13,13,0.22)]"
                      />
                      <p className="mt-3 text-kicker">Kalokot · in chambers</p>
                    </div>

                    {/* Thought bubble */}
                    <div className="relative w-full max-w-sm animate-slide-up delay-200">
                      <div className="absolute -top-4 left-1/2 -translate-x-1/2 flex md:hidden items-center gap-1.5">
                        <span className="glass block h-1.5 w-1.5 rounded-full" />
                        <span className="glass block h-2.5 w-2.5 rounded-full" />
                        <span className="glass block h-3.5 w-3.5 rounded-full" />
                      </div>
                      <div className="absolute -left-6 bottom-6 hidden md:flex flex-col items-center gap-1.5">
                        <span className="glass block h-2 w-2 rounded-full" />
                        <span className="glass block h-3 w-3 rounded-full" />
                        <span className="glass block h-4 w-4 rounded-full" />
                      </div>

                      <div className="glass rounded-3xl px-5 py-4 sm:px-6 sm:py-5">
                        <p className="font-mono text-[10px] uppercase tracking-[0.25em] text-gold/90 mb-2">
                          Counsel's note
                        </p>
                        <p className="font-serif text-sm sm:text-base md:text-lg leading-relaxed text-deep">
                          Ask me about a <em>tender clause</em>, a faulty service complaint, or how
                          a statute reads in your situation — I'll cite the section and lay out your
                          options.
                        </p>
                        <div className="mt-4 flex items-center gap-2">
                          <span className="text-kicker">Hearing open</span>
                          <span className="h-px flex-1 bg-ink/15" />
                          <span className="font-mono text-[10px] text-ink/45">§ Art. 21</span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Suggested chips */}
                  <div className="mt-8 sm:mt-10 flex flex-wrap items-center justify-center gap-2 max-w-xl animate-slide-up delay-300">
                    {chips.map((c) => (
                      <button
                        key={c}
                        onClick={() => {
                          setIsLanding(false);
                          sendMessage(c);
                        }}
                        className="interactive rounded-full border border-ink/10 bg-paper/50 px-4 py-2 text-sm transition-all hover:bg-gold/10 hover:border-gold/30"
                      >
                        {c}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* CHAT MODE (active conversation) */}
              {mode === "chat" && !isLanding && (
                <div className="flex w-full max-w-3xl flex-1 flex-col animate-fade-in">
                  {/* Messages */}
                  <div className="flex-1 space-y-4 overflow-y-auto px-2 py-4 pb-0">
                    {messages.map((msg, i) => (
                      <div
                        key={i}
                        className={`flex gap-3 ${msg.role === "user" ? "flex-row-reverse" : "flex-row"}`}
                      >
                        {msg.role === "lawyer" && (
                          <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gold/10 ring-1 ring-gold/20">
                            <Scale className="h-4 w-4 text-gold" />
                          </div>
                        )}
                        {msg.role === "user" && (
                          <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ink/5 text-[10px] font-mono uppercase tracking-wider text-ink/50">
                            You
                          </div>
                        )}

                        <div className="max-w-[75%] space-y-1">
                          <div
                            className={`rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                              msg.role === "user"
                                ? "rounded-tr-md bg-gold/10 border border-gold/20"
                                : "rounded-tl-md glass"
                            }`}
                            style={{ color: "var(--ink)" }}
                          >
                            {msg.text}
                          </div>
                          {msg.role === "lawyer" && (
                            <button
                              onClick={() => handleTts(msg.text, i)}
                              className="flex items-center gap-1 text-[11px] text-ink/40 hover:text-gold transition-colors"
                              disabled={speakingId === i}
                            >
                              {speakingId === i ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                <Volume2 className="h-3 w-3" />
                              )}
                              Read aloud
                            </button>
                          )}
                        </div>
                      </div>
                    ))}

                    {loading && (
                      <div className="flex gap-3">
                        <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gold/10 ring-1 ring-gold/20">
                          <Scale className="h-4 w-4 text-gold" />
                        </div>
                        <div className="glass flex items-center gap-2 rounded-2xl rounded-tl-md px-4 py-3">
                          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-gold" />
                          <span
                            className="inline-block h-2 w-2 animate-pulse rounded-full bg-gold"
                            style={{ animationDelay: "0.15s" }}
                          />
                          <span
                            className="inline-block h-2 w-2 animate-pulse rounded-full bg-gold"
                            style={{ animationDelay: "0.3s" }}
                          />
                        </div>
                      </div>
                    )}

                    <div ref={bottomRef} />
                  </div>
                </div>
              )}

              {/* TENDER MODE */}
              {mode === "tender" && (
                <div className="w-full max-w-2xl space-y-6 animate-fade-in">
                  <div className="text-center mb-6">
                    <h1 className="text-3xl font-bold mb-2">Tender Review</h1>
                    <p className="text-ink/70">
                      Upload or paste a tender document to analyze for procurement risks and legal
                      compliance.
                    </p>
                  </div>

                  {/* Upload area */}
                  <div className="glass rounded-2xl p-8 transition-all hover:bg-paper/30">
                    <div className="flex flex-col items-center justify-center space-y-4">
                      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-ink/5">
                        <FileText className="h-8 w-8 text-ink/40" />
                      </div>
                      <div className="text-center">
                        <h3 className="text-lg font-semibold mb-2">Upload Tender Document</h3>
                        <p className="text-sm text-ink/60 mb-4">
                          PDF, images, or text documents (max 10MB)
                        </p>
                      </div>
                      <label className="interactive cursor-pointer">
                        <input
                          type="file"
                          className="hidden"
                          accept=".pdf,.png,.jpg,.jpeg,.txt"
                          onChange={handleFileChange}
                        />
                        <div className="flex items-center gap-2 rounded-lg border-2 border-dashed border-ink/20 px-6 py-4 transition-all hover:border-gold/40 hover:bg-gold/5">
                          <Download className="h-5 w-5 text-ink/40" />
                          <span className="font-medium">Choose file or drag & drop</span>
                        </div>
                      </label>
                    </div>
                  </div>

                  {/* Divider */}
                  <div className="flex items-center gap-4">
                    <div className="flex-1 h-px bg-ink/10" />
                    <span className="text-sm text-ink/40 font-medium">OR</span>
                    <div className="flex-1 h-px bg-ink/10" />
                  </div>

                  {/* Paste text area */}
                  <div className="space-y-4">
                    <div className="flex items-center gap-2 mb-2">
                      <Edit3 className="h-5 w-5 text-ink/40" />
                      <h3 className="text-lg font-semibold">Paste Tender Text</h3>
                    </div>
                    <div className="relative">
                      <textarea
                        value={pasteText}
                        onChange={(e) => setPasteText(e.target.value)}
                        placeholder="Paste the entire tender document text here for analysis..."
                        className="w-full min-h-[120px] rounded-lg border border-ink/20 bg-white p-4 text-sm transition-all focus:border-gold/40 focus:ring-2 focus:ring-gold/20 resize-none"
                        rows={6}
                      />
                      {pasteText && (
                        <button
                          onClick={() => setPasteText("")}
                          className="absolute top-3 right-3 p-1 rounded-full text-ink/40 hover:text-ink/60 hover:bg-ink/5"
                        >
                          <VolumeX className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                    <button
                      onClick={handleAnalyzeText}
                      disabled={!pasteText.trim() || analyzing}
                      className="interactive w-full rounded-lg bg-gold/90 px-6 py-3 font-medium text-paper transition-all hover:bg-gold active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {analyzing ? (
                        <span className="flex items-center justify-center gap-2">
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Analyzing...
                        </span>
                      ) : (
                        <span className="flex items-center justify-center gap-2">
                          <ArrowUp className="h-4 w-4" />
                          Analyze Tender
                        </span>
                      )}
                    </button>
                  </div>

                  {/* Loading state */}
                  {analyzing && (
                    <div className="glass rounded-xl p-6">
                      <div className="flex items-center gap-4">
                        <div
                          className="h-10 w-10 rounded-full border-4 border-transparent"
                          style={{
                            borderTopColor: "var(--gold)",
                            animation: "spin 0.8s linear infinite",
                          }}
                        />
                        <div>
                          <div className="font-medium">Analyzing tender document...</div>
                          <div className="text-sm text-ink/60">This may take a few moments</div>
                        </div>
                      </div>
                      <div
                        className="mt-4 text-sm"
                        style={{ color: "color-mix(in oklab, var(--ink) 50%, transparent)" }}
                      >
                        {uploadedFileName}
                      </div>
                    </div>
                  )}

                  {/* Error banner */}
                  {analysisError && !analyzing && (
                    <div
                      className="p-4 rounded-lg text-sm"
                      style={{
                        background: "color-mix(in oklab, #c0392b 10%, transparent)",
                        border: "1px solid color-mix(in oklab, #c0392b 25%, transparent)",
                      }}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <AlertTriangle className="h-4 w-4" style={{ color: "#c0392b" }} />
                        <span className="font-semibold text-sm">Analysis Failed</span>
                      </div>
                      <div
                        className="text-xs"
                        style={{ color: "color-mix(in oklab, var(--ink) 65%, transparent)" }}
                      >
                        {analysisError}
                      </div>
                      <button
                        onClick={() => {
                          setAnalysisError(null);
                          setUploadedFileName("");
                        }}
                        className="mt-2 text-xs px-2.5 py-1 rounded"
                        style={{
                          border: "1px solid color-mix(in oklab, var(--ink) 20%, transparent)",
                          color: "color-mix(in oklab, var(--ink) 55%, transparent)",
                        }}
                      >
                        Try again
                      </button>
                    </div>
                  )}

                  {/* Analysis Results */}
                  {analysisResult && !analyzing && (
                    <div className="space-y-4">
                      {/* Risk Badge */}
                      <div className="flex items-center gap-3">
                        <div
                          className="px-4 py-1.5 rounded-full text-xs font-bold tracking-wider text-white"
                          style={{ background: riskColor(analysisResult.overall_risk) }}
                        >
                          {riskBadge(analysisResult.overall_risk)} RISK
                        </div>
                        <div
                          className="text-xs"
                          style={{ color: "color-mix(in oklab, var(--ink) 50%, transparent)" }}
                        >
                          {uploadedFileName}
                        </div>
                      </div>

                      {/* Summary — Nepali first */}
                      <div
                        className="p-3 rounded-lg text-sm"
                        style={{
                          background: "color-mix(in oklab, var(--paper-dark) 50%, transparent)",
                          border: "1px solid color-mix(in oklab, var(--ink) 10%, transparent)",
                        }}
                      >
                        <div
                          className="text-xs uppercase tracking-wider mb-1"
                          style={{ color: "color-mix(in oklab, var(--ink) 50%, transparent)" }}
                        >
                          सारांश
                        </div>
                        <div style={{ whiteSpace: "pre-wrap" }}>{analysisResult.summary_ne || analysisResult.summary}</div>
                      </div>

                      {/* Summary — English */}
                      <div
                        className="p-3 rounded-lg text-sm"
                        style={{
                          background: "color-mix(in oklab, var(--paper-dark) 50%, transparent)",
                          border: "1px solid color-mix(in oklab, var(--ink) 10%, transparent)",
                        }}
                      >
                        <div
                          className="text-xs uppercase tracking-wider mb-1"
                          style={{ color: "color-mix(in oklab, var(--ink) 50%, transparent)" }}
                        >
                          Summary (English)
                        </div>
                        <div style={{ whiteSpace: "pre-wrap" }}>{analysisResult.summary}</div>
                      </div>

                      {/* Section Scores */}
                      <div>
                        <div
                          className="text-xs uppercase tracking-wider mb-2"
                          style={{ color: "color-mix(in oklab, var(--ink) 50%, transparent)" }}
                        >
                          Section Risk Scores
                        </div>
                        {Object.entries(analysisResult.section_scores || {}).map(
                          ([section, level]) => (
                            <div key={section} className="flex items-center gap-2.5 mb-1.5">
                              <div
                                className="flex-[0_0_120px] text-xs capitalize"
                                style={{
                                  color: "color-mix(in oklab, var(--ink) 65%, transparent)",
                                }}
                              >
                                {section.replace(/_/g, " ")}
                              </div>
                              <div
                                className="flex-1 h-2 rounded-full overflow-hidden"
                                style={{
                                  background: "color-mix(in oklab, var(--ink) 10%, transparent)",
                                }}
                              >
                                <div
                                  className="h-full rounded-full transition-all duration-500"
                                  style={{
                                    width:
                                      level === "critical"
                                        ? "100%"
                                        : level === "high"
                                          ? "75%"
                                          : level === "medium"
                                            ? "50%"
                                            : "25%",
                                    background: riskColor(level),
                                  }}
                                />
                              </div>
                              <div
                                className="flex-[0_0_60px] text-[11px] font-semibold text-right"
                                style={{ color: riskColor(level) }}
                              >
                                {level.toUpperCase()}
                              </div>
                            </div>
                          ),
                        )}
                      </div>

                      {/* Flagged Clauses */}
                      <div>
                        <div
                          className="text-xs uppercase tracking-wider mb-2"
                          style={{ color: "color-mix(in oklab, var(--ink) 50%, transparent)" }}
                        >
                          Flagged Clauses ({analysisResult.flagged_clauses.length})
                        </div>
                        {analysisResult.flagged_clauses.slice(0, 3).map((clause) => (
                          <div
                            key={clause.id}
                            className="p-3 rounded-lg border border-ink/10 bg-paper/30 mb-2"
                          >
                            <div className="flex items-start gap-3">
                              <div className="flex-shrink-0 mt-0.5">
                                {severityIcon(clause.severity)}
                              </div>
                              <div className="flex-1">
                                <div className="font-medium text-sm mb-1">{clause.label}</div>
                                <div className="text-xs text-ink/70 mb-1">
                                  Location: {clause.location}
                                </div>
                                <div className="text-xs">
                                  Risk: {clause.risk_reason || clause.description}
                                </div>
                              </div>
                            </div>
                          </div>
                        ))}
                        {analysisResult.flagged_clauses.length > 3 && (
                          <div className="text-xs text-ink/50 mt-2">
                            ... and {analysisResult.flagged_clauses.length - 3} more flagged clauses
                          </div>
                        )}
                      </div>

                      {/* Action buttons */}
                      <div className="pt-4 flex flex-wrap gap-3">
                        <button
                          onClick={() => setMode("chat")}
                          className="interactive rounded-lg border border-ink/20 bg-paper/50 px-4 py-2 text-sm font-medium transition-all hover:bg-gold/10 hover:border-gold/30"
                        >
                          <MessageCircle className="inline h-4 w-4 mr-2" />
                          Ask Digital Lawyer
                        </button>
                        <button
                          onClick={discussWithLawyer}
                          className="interactive rounded-lg bg-gold/90 px-4 py-2 text-sm font-medium text-paper transition-all hover:bg-gold active:scale-95"
                        >
                          <Lightbulb className="inline h-4 w-4 mr-2" />
                          Discuss with Digital Lawyer
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* COMPLAINT MODE */}
              {mode === "complaint" && (
                <div className="w-full max-w-4xl space-y-6 animate-fade-in">
                  {/* ─── Step 1: Conversation – multi-turn AI intake ─── */}
                  {currentStep === "conversation" && (
                    <div className="space-y-4">
                      <div className="text-center">
                        <h1 className="text-3xl font-bold mb-2">Draft Legal Complaint</h1>
                        <p className="text-ink/70">
                          Describe your situation in your own words. The AI will ask follow-up
                          questions to gather all necessary details.
                        </p>
                      </div>

                      <div className="bg-paper/30 rounded-xl border border-ink/10 overflow-hidden">
                        <div className="h-[420px] overflow-y-auto p-4 space-y-3">
                          {intakeMessages.map((msg, i) => (
                            <div
                              key={i}
                              className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                            >
                              <div
                                className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap ${
                                  msg.role === "user"
                                    ? "bg-gold/90 text-paper rounded-br-md"
                                    : "bg-white border border-ink/10 text-ink rounded-bl-md"
                                }`}
                              >
                                {msg.text}
                              </div>
                            </div>
                          ))}
                          {intakeLoading && (
                            <div className="flex justify-start">
                              <div className="bg-white border border-ink/10 rounded-2xl rounded-bl-md px-4 py-3 text-sm text-ink/60">
                                <span className="flex items-center gap-1">
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                  Thinking...
                                </span>
                              </div>
                            </div>
                          )}
                          <div ref={intakeBottomRef} />
                        </div>

                        <div className="border-t border-ink/10 p-3 bg-white/50">
                          <div className="flex gap-2">
                            <input
                              type="text"
                              value={intakeInput}
                              onChange={(e) => setIntakeInput(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" && !e.shiftKey) {
                                  e.preventDefault();
                                  handleIntakeMessage();
                                }
                              }}
                              placeholder="Describe your complaint..."
                              disabled={intakeLoading || intakeCompleted}
                              className="flex-1 rounded-lg border border-ink/20 bg-white px-3 py-2 text-sm transition-all focus:border-gold/40 focus:ring-2 focus:ring-gold/20 disabled:opacity-50"
                            />
                            <button
                              onClick={handleIntakeMessage}
                              disabled={!intakeInput.trim() || intakeLoading || intakeCompleted}
                              className="interactive rounded-lg bg-gold/90 px-4 py-2 text-paper transition-all hover:bg-gold active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              {intakeLoading ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <Send className="h-4 w-4" />
                              )}
                            </button>
                          </div>
                        </div>
                      </div>

                      {intakeCompleted && (
                        <div className="flex justify-center">
                          <button
                            onClick={handleProceedToReview}
                            className="interactive rounded-lg bg-gold/90 px-6 py-2.5 font-medium text-paper transition-all hover:bg-gold active:scale-95"
                          >
                            Review & Confirm Information →
                          </button>
                        </div>
                      )}
                    </div>
                  )}

                  {/* ─── Step 2: Review – summary + editable fields ─── */}
                  {currentStep === "review" && (
                    <div className="space-y-6">
                      <div className="flex items-center justify-between">
                        <div>
                          <h2 className="text-2xl font-bold mb-1">Review Your Information</h2>
                          <p className="text-ink/70">
                            Confirm the details below. Fill in any missing fields before proceeding.
                          </p>
                        </div>
                        <button
                          onClick={handleBackToConversation}
                          className="interactive text-sm text-ink/60 hover:text-ink transition-colors"
                        >
                          ← Back to conversation
                        </button>
                      </div>

                      <div className="bg-paper/30 rounded-xl p-6 space-y-4">
                        <h3 className="text-lg font-semibold border-b border-ink/10 pb-2">
                          Complainant Details
                        </h3>
                        {[
                          {
                            key: "name",
                            label: "Full Name",
                            type: "text",
                            placeholder: "e.g., Ram Sharma",
                            required: true,
                          },
                          {
                            key: "permanent_address",
                            label: "Permanent Address",
                            type: "text",
                            placeholder: "e.g., Kathmandu-15, Bagmati",
                            required: true,
                          },
                          {
                            key: "temporary_address",
                            label: "Temporary Address",
                            type: "text",
                            placeholder: "e.g., Lalitpur-3, Bagmati",
                            required: false,
                          },
                          {
                            key: "citizenship_no",
                            label: "Citizenship Number",
                            type: "text",
                            placeholder: "e.g., 01-123-4567",
                            required: true,
                          },
                          {
                            key: "phone",
                            label: "Phone Number",
                            type: "text",
                            placeholder: "e.g., 9851234567",
                            required: true,
                          },
                          {
                            key: "email",
                            label: "Email Address",
                            type: "text",
                            placeholder: "e.g., ram.sharma@email.com",
                            required: false,
                          },
                          {
                            key: "complaint_date",
                            label: "Date of Complaint",
                            type: "date",
                            required: false,
                          },
                        ].map((field) => (
                          <div key={field.key} className="space-y-2">
                            <label className="block text-sm font-medium">
                              {field.label}
                              {field.required && <span className="text-red-500 ml-1">*</span>}
                            </label>
                            <input
                              type={field.type}
                              value={(complainantInfo as any)[field.key] || ""}
                              onChange={(e) =>
                                setComplainantInfo({
                                  ...complainantInfo,
                                  [field.key]: e.target.value,
                                })
                              }
                              placeholder={field.placeholder}
                              className="w-full rounded-lg border border-ink/20 bg-white px-3 py-2 text-sm transition-all focus:border-gold/40 focus:ring-2 focus:ring-gold/20"
                            />
                          </div>
                        ))}
                      </div>

                      {extractedData && (
                        <div className="bg-paper/30 rounded-xl p-6 space-y-4">
                          <h3 className="text-lg font-semibold border-b border-ink/10 pb-2">
                            Extracted Case Details
                          </h3>
                          <div className="space-y-3">
                            {Object.entries(extractedData).map(([key, value]) => (
                              <div key={key} className="text-sm">
                                <span className="font-medium capitalize">
                                  {key.replace(/_/g, " ")}:
                                </span>{" "}
                                <span className="text-ink/70">{String(value)}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      <div className="flex gap-3">
                        <button
                          onClick={handleProceedToEvidence}
                          disabled={
                            !complainantInfo.name.trim() ||
                            !complainantInfo.permanent_address.trim() ||
                            !complainantInfo.citizenship_no.trim() ||
                            !complainantInfo.phone.trim()
                          }
                          className="interactive rounded-lg bg-gold/90 px-6 py-2.5 font-medium text-paper transition-all hover:bg-gold active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          Next: Upload Evidence →
                        </button>
                        <button
                          onClick={handleBackToConversation}
                          className="interactive rounded-lg border border-ink/20 bg-white px-4 py-2.5 text-sm font-medium transition-all hover:bg-ink/5"
                        >
                          ← Back to conversation
                        </button>
                      </div>
                    </div>
                  )}

                  {/* ─── Step 3: Evidence – file upload + description ─── */}
                  {currentStep === "evidence" && (
                    <div className="space-y-6">
                      <div className="flex items-center justify-between">
                        <div>
                          <h2 className="text-2xl font-bold mb-1">Upload Evidence</h2>
                          <p className="text-ink/70">
                            Attach supporting documents and provide a brief description for each.
                          </p>
                        </div>
                        <button
                          onClick={() => setCurrentStep("review")}
                          className="interactive text-sm text-ink/60 hover:text-ink transition-colors"
                        >
                          ← Back to review
                        </button>
                      </div>

                      <div className="bg-paper/30 rounded-xl p-6 space-y-4">
                        {evidenceItems.length === 0 && (
                          <div className="text-center py-8 text-ink/50">
                            <Upload className="h-8 w-8 mx-auto mb-2" />
                            <p className="text-sm">No evidence items added yet.</p>
                          </div>
                        )}
                        {evidenceItems.map((item, i) => (
                          <div
                            key={i}
                            className="border border-ink/10 rounded-xl p-4 space-y-3 bg-white/50"
                          >
                            <div className="flex items-start justify-between">
                              <div className="flex-1 space-y-2">
                                <div className="flex items-center gap-2">
                                  <input
                                    type="file"
                                    onChange={(e) => handleEvidenceFile(i, e.target.files?.[0])}
                                    className="text-sm text-ink/70 file:mr-3 file:rounded-lg file:border-0 file:bg-gold/10 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-gold-900 hover:file:bg-gold/20"
                                  />
                                  {item.file && (
                                    <span className="text-xs text-ink/50 truncate max-w-[200px]">
                                      {item.file.name}
                                    </span>
                                  )}
                                </div>
                                <textarea
                                  value={item.description}
                                  onChange={(e) => handleEvidenceDesc(i, e.target.value)}
                                  placeholder="Describe this evidence item..."
                                  rows={2}
                                  className="w-full rounded-lg border border-ink/20 bg-white px-3 py-2 text-sm transition-all focus:border-gold/40 focus:ring-2 focus:ring-gold/20"
                                />
                              </div>
                              <button
                                onClick={() => handleRemoveEvidenceItem(i)}
                                className="ml-2 p-1 text-ink/40 hover:text-red-500 transition-colors"
                              >
                                <X className="h-4 w-4" />
                              </button>
                            </div>
                          </div>
                        ))}

                        <button
                          onClick={handleAddEvidenceItem}
                          className="interactive w-full rounded-lg border border-dashed border-ink/20 px-4 py-3 text-sm text-ink/50 transition-all hover:border-gold/30 hover:text-gold-700"
                        >
                          <Plus className="inline h-4 w-4 mr-1" />
                          Add Evidence Item
                        </button>
                      </div>

                      <div className="flex gap-3">
                        <button
                          onClick={handleProceedToDraft}
                          className="interactive rounded-lg bg-gold/90 px-6 py-2.5 font-medium text-paper transition-all hover:bg-gold active:scale-95"
                        >
                          {generatingComplaint ? (
                            <span className="flex items-center gap-2">
                              <Loader2 className="h-4 w-4 animate-spin" />
                              Generating Complaint...
                            </span>
                          ) : (
                            <span className="flex items-center gap-2">
                              <Download className="h-4 w-4" />
                              Generate Complaint Draft
                            </span>
                          )}
                        </button>
                        <button
                          onClick={() => setCurrentStep("review")}
                          className="interactive rounded-lg border border-ink/20 bg-white px-4 py-2.5 text-sm font-medium transition-all hover:bg-ink/5"
                        >
                          ← Back to review
                        </button>
                      </div>
                    </div>
                  )}

                  {/* ─── Step 4: Draft – generated complaint ─── */}
                  {currentStep === "draft" && (
                    <div className="space-y-6">
                      <div className="flex items-center justify-between">
                        <div>
                          <h2 className="text-2xl font-bold mb-1">
                            {generatingComplaint
                              ? "Generating Complaint..."
                              : "Generated Complaint Draft"}
                          </h2>
                          <p className="text-ink/70">
                            {generatingComplaint
                              ? "Please wait while your complaint is being drafted."
                              : "Review and customize your legal complaint below."}
                          </p>
                        </div>
                        <button
                          onClick={resetComplaintPage}
                          className="interactive text-sm text-ink/60 hover:text-ink transition-colors"
                        >
                          ← Start over
                        </button>
                      </div>

                      {generatingComplaint && !draftedComplaint && (
                        <div className="flex items-center justify-center py-16">
                          <div className="text-center">
                            <Loader2 className="h-8 w-8 animate-spin mx-auto mb-3 text-gold/70" />
                            <p className="text-sm text-ink/50">Drafting your legal complaint...</p>
                          </div>
                        </div>
                      )}

                      {draftedComplaint && !generatingComplaint && (
                        <>
                          <div className="bg-white rounded-xl border border-ink/20 p-6 space-y-4">
                            <div className="pb-4 border-b border-ink/10">
                              <div className="text-sm text-ink/50 mb-1">Complaint Type</div>
                              <div className="font-semibold">
                                {complaintTypes.find((t) => t.id === (matchedType || complaintType))
                                  ?.name || "General Complaint"}
                              </div>
                            </div>

                            <div className="pb-4 border-b border-ink/10 text-sm">
                              <div className="text-ink/50 mb-1">Complainant</div>
                              <div className="font-medium">{complainantInfo.name}</div>
                              <div className="text-ink/70">{complainantInfo.permanent_address}</div>
                              <div className="text-ink/70">
                                {complainantInfo.phone} · {complainantInfo.email}
                              </div>
                            </div>

                            <div className="prose max-w-none">
                              <div
                                className="whitespace-pre-wrap text-sm leading-relaxed"
                                style={{ color: "var(--ink)" }}
                              >
                                {draftedComplaint.body || draftedComplaint}
                              </div>
                            </div>

                            {draftedComplaint.instructions && (
                              <div className="pt-4 border-t border-ink/10">
                                <div className="text-sm text-ink/50 mb-2">Instructions</div>
                                <div className="text-sm">{draftedComplaint.instructions}</div>
                              </div>
                            )}
                          </div>

                          <div className="flex gap-3">
                            <button
                              onClick={() => {
                                const blob = new Blob([draftedComplaint.body || draftedComplaint], {
                                  type: "text/plain",
                                });
                                const url = URL.createObjectURL(blob);
                                const a = document.createElement("a");
                                a.href = url;
                                a.download = "complaint-draft.txt";
                                a.click();
                                URL.revokeObjectURL(url);
                              }}
                              className="interactive rounded-lg bg-gold/90 px-6 py-2.5 font-medium text-paper transition-all hover:bg-gold active:scale-95"
                            >
                              <Download className="inline h-4 w-4 mr-2" />
                              Download as Text
                            </button>
                            <button
                              onClick={resetComplaintPage}
                              className="interactive rounded-lg border border-ink/20 bg-white px-4 py-2.5 text-sm font-medium transition-all hover:bg-ink/5"
                            >
                              <Edit3 className="inline h-4 w-4 mr-2" />
                              Draft New Complaint
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* ANALYSIS MODE */}
              {mode === "analysis" && (
                <div className="w-full max-w-2xl space-y-6 animate-fade-in">
                  <div className="text-center mb-6">
                    <h1 className="text-3xl font-bold mb-2">Legal Analysis</h1>
                    <p className="text-ink/70">
                      Describe a procurement issue you're experiencing and receive a comprehensive
                      legal analysis.
                    </p>
                  </div>

                  <div className="glass rounded-xl p-6">
                    <div className="space-y-4">
                      <div className="flex items-center gap-2 mb-2">
                        <User className="h-5 w-5 text-ink/40" />
                        <h3 className="text-lg font-semibold">Describe Your Issue</h3>
                      </div>
                      <textarea
                        value={pasteText}
                        onChange={(e) => setPasteText(e.target.value)}
                        placeholder="Describe the procurement violation, irregularity, or issue you're experiencing...

Example: 'Our procurement department bypassed the competitive bidding process for the IT services contract, selecting a vendor with personal connections to the procurement officer. The contract value is NPR 5 million and was awarded without proper documentation.'"
                        className="w-full min-h-[120px] rounded-lg border border-ink/20 bg-white p-4 text-sm transition-all focus:border-gold/40 focus:ring-2 focus:ring-gold/20 resize-none"
                      />
                      <button
                        onClick={handleAnalyzeText}
                        disabled={!pasteText.trim() || analyzing}
                        className="interactive w-full rounded-lg bg-gold/90 px-6 py-3 font-medium text-paper transition-all hover:bg-gold active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {analyzing ? (
                          <span className="flex items-center justify-center gap-2">
                            <Loader2 className="h-4 w-4 animate-spin" />
                            Analyzing...
                          </span>
                        ) : (
                          <span className="flex items-center justify-center gap-2">
                            <BarChart3 className="h-4 w-4" />
                            Generate Analysis Report
                          </span>
                        )}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Persistent chat bar — visible across all modes (like ChatGPT/Gemini) */}
            {!(mode === "complaint" && currentStep === "conversation") && (
              <div className="sticky bottom-0 w-full max-w-3xl mx-auto border-t border-ink/10 bg-[#fdfcf9] px-2 py-3">
                {/* File a Complaint chip — shown when tender context is active */}
                {mode === "chat" && tenderContext && (
                  <div className="mb-2 flex items-center gap-2">
                    <button
                      onClick={() => {
                        setComplaintType("procurement_violation");
                        setMode("complaint");
                        setCurrentStep("conversation");
                        setIntakeMessages([
                          { role: "assistant", text: `I see you're discussing a tender analysis. I'll help you file a complaint related to:\n\n${tenderContext.slice(0, 500)}\n\nCan you confirm you'd like to file a complaint about this tender?` }
                        ]);
                      }}
                      className="text-xs flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-gold/30 text-gold-dark hover:bg-gold/10 transition"
                    >
                      <AlertOctagon className="h-3 w-3" />
                      File a Complaint about this Tender
                    </button>
                    <span className="text-[11px] text-ink/40">Tender discussion active</span>
                  </div>
                )}
                <div className="flex items-center gap-3">
                  <input
                    ref={inputRef}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        if (mode !== "chat") setMode("chat");
                        sendMessage();
                      }
                    }}
                    placeholder="Ask about a tender, law, or your rights…"
                    className="flex-1 rounded-xl border border-ink/20 bg-white px-4 py-3 text-sm text-ink placeholder:text-ink/40 focus:outline-none focus:ring-2 focus:ring-gold/20 focus:border-gold/40"
                    disabled={loading}
                  />
                  <button
                    onClick={() => {
                      if (mode !== "chat") setMode("chat");
                      sendMessage();
                    }}
                    disabled={loading || !input.trim()}
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gold/90 text-paper transition-all hover:bg-gold active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed"
                    aria-label="Send"
                  >
                    {loading ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Send className="h-4 w-4" strokeWidth={2.5} />
                    )}
                  </button>
                </div>
              </div>
            )}
          </div>
        </main>
      </div>

      {/* API Key Dialog */}
      <Dialog open={keyDialogOpen} onOpenChange={setKeyDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="h-5 w-5" />
              Configure AI Provider
            </DialogTitle>
            <DialogDescription>
              Select a provider and enter your API key. Your key is stored in your browser only.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {/* Provider selector */}
            <div className="space-y-2">
              <label className="text-sm font-medium">Provider</label>
              <select
                value={keyDialogProvider}
                onChange={(e) => {
                  setKeyDialogProvider(e.target.value);
                  setKeyInputValue("");
                }}
                className="w-full rounded-lg border border-ink/20 bg-white px-3 py-2 text-sm focus:border-gold/40 focus:ring-2 focus:ring-gold/20"
              >
                <option value="">Select a provider...</option>
                {providers
                  .filter((p) => p.value)
                  .map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
              </select>
            </div>

            {/* Instructions */}
            {keyDialogProvider && (
              <div className="rounded-lg bg-ink/5 p-3 text-xs text-ink/70 whitespace-pre-line leading-relaxed">
                {getApiKeyInstructions(keyDialogProvider)}
              </div>
            )}

            {/* API Key input */}
            {keyDialogProvider && (
              <div className="space-y-2">
                <label className="text-sm font-medium">API Key</label>
                <input
                  type="password"
                  value={keyInputValue}
                  onChange={(e) => setKeyInputValue(e.target.value)}
                  placeholder="Paste your API key here..."
                  className="w-full rounded-lg border border-ink/20 px-3 py-2 text-sm transition-all focus:border-gold/40 focus:ring-2 focus:ring-gold/20"
                />
                <p className="text-xs text-ink/50">
                  Stored locally in your browser. Never sent to our servers.
                </p>
              </div>
            )}
          </div>
          <DialogFooter>
            <button
              onClick={() => setKeyDialogOpen(false)}
              className="px-4 py-2 rounded-lg text-xs font-medium transition"
              style={{
                border: "1px solid color-mix(in oklab, var(--ink) 20%, transparent)",
                color: "color-mix(in oklab, var(--ink) 55%, transparent)",
              }}
            >
              Cancel
            </button>
            <button
              onClick={() => {
                if (!keyInputValue.trim() || !keyDialogProvider) return;
                setApiKey(keyDialogProvider, keyInputValue.trim());
                setAiProvider(keyDialogProvider);
                setKeyDialogOpen(false);
                setKeyInputValue("");
              }}
              disabled={!keyInputValue.trim() || !keyDialogProvider}
              className="px-4 py-2 rounded-lg text-xs font-semibold transition"
              style={{
                background:
                  keyInputValue.trim() && keyDialogProvider
                    ? "var(--gold)"
                    : "color-mix(in oklab, var(--ink) 10%, transparent)",
                color:
                  keyInputValue.trim() && keyDialogProvider
                    ? "var(--paper)"
                    : "color-mix(in oklab, var(--ink) 40%, transparent)",
                cursor: keyInputValue.trim() && keyDialogProvider ? "pointer" : "not-allowed",
              }}
            >
              Save Key
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
