"""API endpoints for complaint type selection, field generation, and conversational intake."""

from fastapi import APIRouter, HTTPException, Form, Request, UploadFile, File
from typing import List, Dict, Any, Optional
from pathlib import Path
from src.shared.jurisdiction import JurisdictionLoader
from src.shared.llm import create_llm_client, LLMClient
from src.shared.models import CounselRequest, CounselResponse
from src.lawyer import VirtualLawyer
from datetime import datetime
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
import yaml
import logging
import uuid
import json
import asyncio
import os
from src.shared.security import SecurityHeadersMiddleware

logger = logging.getLogger("justice_api")

limiter = Limiter(key_func=get_remote_address)

router = APIRouter(prefix="/api", tags=["Complaint"])

LEGAL_DIR = Path(__file__).resolve().parent.parent / "docs" / "legal"

# ── Provider status endpoint ──────────────────────────────────────

@router.get("/providers")
async def get_providers():
    """Return which LLM providers are configured and available."""
    return {
        "providers": {
            "gemini": bool(os.environ.get("GEMINI_API_KEY")),
            "openrouter": bool(os.environ.get("OPENROUTER_API_KEY")),
            "anthropic": bool(os.environ.get("ANTHROPIC_API_KEY")),
            "openai": bool(os.environ.get("OPENAI_API_KEY")),
            "phi": False,
        }
    }

# ── Complaint intake session store ────────────────────────────────

_intake_sessions: dict[str, dict] = {}

COMPLAINT_INTAKE_SYSTEM_PROMPT = """You are a legal intake assistant for KaloKoT, a digital legal companion for Nepali citizens.
Your job is to help users file complaints by gathering information through conversation.

RULES:
1. ONLY discuss complaint-related legal matters. Reject non-legal topics.
2. Identify the complaint type from the user's description (e.g., procurement violation, conflict of interest, non-performance, budget misallocation, consumer complaint, etc.).
3. Ask follow-up questions to gather ALL required information for the complaint type.
4. Extract structured data as you go.
5. When you have enough information, signal completion.

Required fields to gather (ask about these if relevant):
- incident_date: When did the incident occur?
- incident_location: Where did it happen? (city, office, etc.)
- persons_involved: Names of people or entities involved
- evidence_description: What evidence exists? (documents, photos, witnesses, etc.)
- description: A clear description of what happened

OUTPUT FORMAT:
You MUST respond with valid JSON on a single line starting with "JSON:" followed by the JSON object, then a blank line, then your conversational reply.

Example:
JSON:{"extracted":{"incident_date":"2024-01-15","incident_location":"Kathmandu"},"matched_type":null,"required_fields":["incident_date","incident_location","description","evidence_description"],"completed":false,"question":"Where exactly did this incident take place?"}

Your conversational reply here...

If completed is true, the user can review and submit.

NEVER make up laws or citations. If you don't know something, say so.
"""

def _get_llm() -> Optional[LLMClient]:
    """Create an LLM client using available configuration with fallback."""
    try:
        return create_llm_client()
    except Exception as e:
        logger.warning(f"Failed to create LLM client: {e}")
        return None

def _parse_intake_response(text: str) -> tuple[dict, str]:
    """Parse the JSON: prefix and separate the JSON data from the reply text."""
    if text.startswith("JSON:"):
        end_of_json = text.find("\n", 5)
        if end_of_json == -1:
            end_of_json = len(text)
        json_str = text[5:end_of_json].strip()
        reply = text[end_of_json:].strip()
        try:
            data = json.loads(json_str)
            return data, reply
        except json.JSONDecodeError:
            pass
    return {"extracted": {}, "matched_type": None, "required_fields": [], "completed": False}, text


# ── Counsel (general legal Q&A) ────────────────────────────

@router.post("/counsel")
@limiter.limit("10/minute")
async def counsel(
    request: Request,
    question: str = Form(...),
    tender_context: str = Form(""),
    jurisdiction: str = Form("np"),
    provider: str = Form(""),
    api_key: str = Form(""),
    chat_history: str = Form(""),
    report_id: str = Form(""),
):
    """Answer a general legal question using the backend's LLM + legal knowledge base.

    The frontend sends the question (and optionally an api_key/provider).
    This endpoint uses the backend's configured API keys by default,
    falling back to any user-provided key.
    """
    try:
        from src.shared.models import JurisdictionCode
        jcode = JurisdictionCode.UNKNOWN
        for code in JurisdictionCode:
            if code.value == jurisdiction.lower():
                jcode = code
                break

        loader = JurisdictionLoader()

        llm = None
        if api_key and provider:
            try:
                llm = create_llm_client(provider=provider, api_key=api_key)
            except Exception:
                llm = None
        if not llm:
            llm = _get_llm()
        if not llm:
            return {"answer": "No AI provider configured. Please set an API key in Settings or add one to the server .env file.", "citations": [], "suggested_actions": []}

        lawyer = VirtualLawyer(loader, llm)

        constitution_context = ""
        try:
            from src.shared.chroma_store import ChromaLegalStore
            chroma_store = ChromaLegalStore()
            if chroma_store.count() > 0:
                results = chroma_store.search(question, top_k=4)
                if results:
                    constitution_context = chroma_store.get_search_context(results)
        except Exception:
            pass

        history = []
        if chat_history:
            try:
                history = json.loads(chat_history)
                if not isinstance(history, list):
                    history = []
            except Exception:
                history = []

        req = CounselRequest(
            question=question,
            tender_context=tender_context or "",
            jurisdiction=jcode,
        )

        try:
            resp = lawyer.counsel(req, constitution_context=constitution_context, chat_history=history)
        except Exception as first_err:
            # If the user provided a key and it failed, retry with the backend's own LLM
            if api_key and provider:
                logger.warning(f"User-provided LLM failed, falling back to backend LLM: {first_err}")
                backend_llm = _get_llm()
                if backend_llm:
                    lawyer = VirtualLawyer(loader, backend_llm)
                    resp = lawyer.counsel(req, constitution_context=constitution_context, chat_history=history)
                else:
                    raise
            else:
                raise

        return {
            "answer": resp.answer,
            "citations": [{"source": c.source, "description": c.description} for c in (resp.citations or [])],
            "suggested_actions": resp.suggested_actions or [],
            "disclaimer": resp.disclaimer or "",
        }

    except Exception as e:
        logger.error(f"Counsel error: {e}")
        return {"answer": "I encountered an error processing your question. Please try again.", "citations": [], "suggested_actions": []}


@router.post("/complaint-intake")
@limiter.limit("10/minute")
async def complaint_intake(request: Request, body: Dict[str, Any]):
    """Multi-turn conversational complaint intake.

    Accepts a message from the user and returns an AI-driven response
    that asks follow-up questions or signals completion.
    """
    message = body.get("message", "")
    session_id = body.get("session_id") or uuid.uuid4().hex[:12]

    if not message.strip():
        return {
            "session_id": session_id,
            "reply": "Please describe your complaint or issue. For example: 'I want to report a procurement violation in a government tender.'",
            "extracted_data": None,
            "matched_type": None,
            "required_fields": [],
            "completed": False,
        }

    # Get or create session
    session = _intake_sessions.setdefault(session_id, {
        "messages": [],
        "extracted": {},
        "matched_type": None,
        "step": "gathering",
        "created_at": datetime.utcnow(),
    })
    # Cap sessions to prevent memory leak
    if len(_intake_sessions) > 1000:
        oldest = sorted(_intake_sessions.items(), key=lambda x: x[1].get("created_at", datetime.min))[0][0]
        _intake_sessions.pop(oldest, None)

    # Add user message to history
    session["messages"].append({"role": "user", "text": message})

    # Build conversation history for the LLM
    history_text = "\n".join(
        f"{'User' if m['role'] == 'user' else 'Assistant'}: {m['text']}"
        for m in session["messages"][-10:]
    )

    # Build extracted data summary
    extracted_summary = json.dumps(session["extracted"], indent=2) if session["extracted"] else "None yet"

    llm = _get_llm()
    if llm:
        user_prompt = (
            f"Conversation so far:\n{history_text}\n\n"
            f"Currently extracted data:\n{extracted_summary}\n\n"
            f"Matched complaint type: {session['matched_type'] or 'Not yet identified'}\n\n"
            f"User message: {message}\n\n"
            f"Respond with JSON: prefix followed by your reply."
        )
        try:
            raw = llm.generate(
                system_prompt=COMPLAINT_INTAKE_SYSTEM_PROMPT,
                user_prompt=user_prompt,
                temperature=0.3,
                max_tokens=2048,
            )
            data, reply = _parse_intake_response(raw)

            # Update session with extracted data
            extracted = data.get("extracted", {})
            session["extracted"].update(extracted)
            if data.get("matched_type"):
                session["matched_type"] = data["matched_type"]

            completed = data.get("completed", False)
            required_fields = data.get("required_fields", [])

            if not reply:
                reply = "Could you please provide more details about your complaint?"

        except Exception as e:
            logger.error(f"LLM error in complaint intake: {e}")
            data, reply = {}, "I'm having trouble processing your request. Please try describing your complaint in simple terms."
            completed = False
            required_fields = []
    else:
        # Fallback when no LLM available
        reply = (
            "Thank you for sharing. To help you file a complaint, I need some more details:\n\n"
            "1. When did this incident happen?\n"
            "2. Where did it take place?\n"
            "3. Who is involved?\n"
            "4. What evidence do you have?\n\n"
            "Please describe these details."
        )
        completed = False
        required_fields = ["incident_date", "incident_location", "persons_involved", "evidence_description", "description"]

    # Add assistant reply to history
    session["messages"].append({"role": "assistant", "text": reply})

    return {
        "session_id": session_id,
        "reply": reply,
        "extracted_data": session["extracted"] if session["extracted"] else None,
        "matched_type": session["matched_type"],
        "required_fields": required_fields,
        "completed": completed,
    }

@router.post("/upload-evidence")
async def upload_evidence(body: Dict[str, Any]):
    """Register evidence items for a complaint intake session."""
    session_id = body.get("session_id", "")
    description = body.get("description", "")
    filename = body.get("filename", "unnamed")
    file_content = body.get("file_content", "")

    if not session_id:
        raise HTTPException(status_code=400, detail="session_id is required")

    session = _intake_sessions.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    evidence = session.setdefault("evidence", [])
    evidence.append({
        "id": uuid.uuid4().hex[:8],
        "filename": filename,
        "description": description,
        "uploaded_at": datetime.utcnow().isoformat(),
    })

    return {
        "success": True,
        "evidence_id": evidence[-1]["id"],
        "filename": filename,
        "description": description,
    }

@router.post("/complaint-intake-reset")
async def complaint_intake_reset(body: Dict[str, Any]):
    """Reset a complaint intake session."""
    session_id = body.get("session_id", "")
    if session_id and session_id in _intake_sessions:
        del _intake_sessions[session_id]
    return {"success": True}

@router.get("/constitution-text")
async def get_constitution_text():
    """Return the full constitution text for browsing."""
    path = LEGAL_DIR / "np_constitution.yaml"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Constitution file not found")
    try:
        with open(path, encoding="utf-8") as f:
            data = yaml.safe_load(f)
        lines = []
        for part in data.get("parts", []):
            part_title = part.get("title", "")
            lines.append(f"\n{'='*60}")
            lines.append(f"  {part_title}")
            lines.append(f"{'='*60}\n")
            for article in part.get("articles", []):
                art_title = article.get("title", "")
                art_content = article.get("content", "")
                lines.append(f"  {art_title}")
                lines.append(f"  {'─'*40}")
                lines.append(f"  {art_content}\n")
        return {"text": "\n".join(lines), "context": "\n".join(lines)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read constitution: {e}")


@router.post("/constitution-search")
async def constitution_search(
    query: str = Form(...),
    top_k: int = Form(5),
    resolve_parents: bool = Form(True),
):
    """Semantic search over the Constitution of Nepal 2015 via ChromaDB."""
    try:
        top_k = min(top_k, 20)
        if not query.strip():
            raise HTTPException(status_code=400, detail="No query provided")

        from src.shared.chroma_store import ChromaLegalStore
        from pathlib import Path
        store = ChromaLegalStore()

        if store.count() == 0:
            path = LEGAL_DIR / "np_constitution.yaml"
            if path.exists():
                with open(path, encoding="utf-8") as f:
                    constitution_data = yaml.safe_load(f)
                if constitution_data and "parts" in constitution_data:
                    store.index_constitution(constitution_data)

        if store.count() == 0:
            return {"results": [], "context": ""}

        results = store.search(query, top_k=top_k)
        formatted = []
        for r in results:
            formatted.append({
                "child_id": r["child_id"],
                "child_text": r["child_text"],
                "score": r["score"],
                "parent_id": r["parent_id"],
                "parent_title": r.get("parent_title", ""),
                "part_title": r.get("part_title", ""),
                "path": r.get("path", []),
            })
        context = store.get_search_context(results) if resolve_parents else ""
        return {"results": formatted, "context": context}
    except Exception as e:
        logger.error(f"Constitution search failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/complaint-types")
async def get_complaint_types(jurisdiction: str = "np"):
    """Get available complaint types and their required fields.
    
    Returns a list of complaint types with metadata including:
    - id: unique identifier for the complaint type
    - name: display name
    - description: brief description
    - required_fields: list of field names that must be collected
    - templates: available template IDs
    
    Maps to jurisdiction-specific templates from the law library.
    """
    try:
        from src.shared.models import JurisdictionCode
        loader = JurisdictionLoader()
        jcode = JurisdictionCode.NEPAL if jurisdiction == "np" else JurisdictionCode.UNKNOWN
        templates = loader.get_templates(jcode)
        
        # Map templates to complaint types
        complaint_types = []
        for template in templates:
            template_id = template.get("template_name") or template.get("name") or template.get("id")
            if not template_id:
                continue
                
            # Extract required fields from template structure
            required_fields = []
            if "fields" in template:
                required_fields = template["fields"]
            
            complaint_types.append({
                "id": template_id,
                "name": template.get("title", template_id.replace("_", " ").title()),
                "description": template.get("description", f"Legal template for {template_id}"),
                "required_fields": required_fields,
                "templates": [template_id],
                "jurisdiction": jurisdiction,
                "category": template.get("category", "general")
            })
            
        # Always include essential procurement violation types
        additional_types = [
            {
                "id": "procurement_violation",
                "name": "Procurement Violation",
                "description": "General procurement violations and irregularities",
                "required_fields": ["tender_reference", "violation_description", "estimated_impact"],
                "templates": ["procurement_violation"],
                "jurisdiction": "np",
                "category": "violation"
            },
            {
                "id": "conflict_of_interest", 
                "name": "Conflict of Interest",
                "description": "Allegations of conflicts of interest in procurement",
                "required_fields": ["official_name", "contrary_financial_interest", "contract_value"],
                "templates": ["conflict_of_interest"],
                "jurisdiction": "np",
                "category": "ethics"
            },
            {
                "id": "non_performance",
                "name": "Non-Performance", 
                "description": "Failure to perform contract obligations",
                "required_fields": ["contract_date", "delivery_details", "actual_performance"],
                "templates": ["non_performance"],
                "jurisdiction": "np",
                "category": "performance"
            },
            {
                "id": "budget_misallocation",
                "name": "Budget Misallocation",
                "description": "Improper allocation or misuse of procurement funds",
                "required_fields": ["budget_line", "misallocated_amount", "affected_projects"],
                "templates": ["budget_misallocation"],
                "jurisdiction": "np",
                "category": "financial"
            }
        ]
        
        # Remove duplicates and combine
        seen = {t["id"] for t in complaint_types}
        for additional in additional_types:
            if additional["id"] not in seen:
                complaint_types.append(additional)
                seen.add(additional["id"])
                
        return complaint_types
        
    except Exception as e:
        logger.warning(f"Failed to load complaint types: {e}")
        
        # Return fallback types
        return [
            {
                "id": "procurement_violation",
                "name": "Procurement Violation",
                "description": "General procurement violations and irregularities", 
                "required_fields": ["tender_reference", "violation_description", "estimated_impact"],
                "templates": ["procurement_violation"],
                "jurisdiction": "np",
                "category": "violation"
            },
            {
                "id": "conflict_of_interest",
                "name": "Conflict of Interest",
                "description": "Allegations of conflicts of interest in procurement",
                "required_fields": ["official_name", "contrary_financial_interest", "contract_value"],
                "templates": ["conflict_of_interest"],
                "jurisdiction": "np", 
                "category": "ethics"
            },
            {
                "id": "non_performance",
                "name": "Non-Performance",
                "description": "Failure to perform contract obligations",
                "required_fields": ["contract_date", "delivery_details", "actual_performance"],
                "templates": ["non_performance"],
                "jurisdiction": "np",
                "category": "performance"
            },
            {
                "id": "budget_misallocation",
                "name": "Budget Misallocation",
                "description": "Improper allocation or misuse of procurement funds",
                "required_fields": ["budget_line", "misallocated_amount", "affected_projects"],
                "templates": ["budget_misallocation"],
                "jurisdiction": "np",
                "category": "financial"
            }
        ]

@router.get("/complaint-templates/{type}")
async def get_complaint_template(type: str, jurisdiction: str = "np"):
    """Get detailed field definitions and templates for a specific complaint type."""
    try:
        loader = JurisdictionLoader()
        
        # Create a comprehensive field specification based on type
        field_specifications = {
            "procurement_violation": {
                "tender_reference": {
                    "label": "Tender Reference / Number",
                    "type": "text",
                    "required": True,
                    "placeholder": "e.g., \"Procurement Notice No. 123/2024\"",
                    "help_text": "Official tender reference or procurement notice number"
                },
                "violation_description": {
                    "label": "Violation Description",
                    "type": "textarea",
                    "required": True,
                    "placeholder": "Describe the specific violation in detail...",
                    "help_text": "Detailed description of the procurement violation, including specific clauses or regulations violated"
                },
                "estimated_impact": {
                    "label": "Estimated Financial Impact",
                    "type": "number",
                    "required": True,
                    "placeholder": "e.g., 5,000,000",
                    "help_text": "Estimated financial value or impact of the violation"
                },
                "affected_tenderers": {
                    "label": "Affected Tenderers",
                    "type": "text",
                    "required": False,
                    "placeholder": "e.g., ABC Company, XYZ Corp",
                    "help_text": "List any other tenderers affected by this violation"
                }
            },
            "conflict_of_interest": {
                "official_name": {
                    "label": "Official/Official's Name",
                    "type": "text",
                    "required": True,
                    "placeholder": "Full name of the official involved",
                    "help_text": "Complete name of the government official or employee with the conflict"
                },
                "contrary_financial_interest": {
                    "label": "Contrary Financial Interest Details",
                    "type": "textarea",
                    "required": True,
                    "placeholder": "Describe the financial interest that conflicts with official duties...",
                    "help_text": "Details of financial interests, relationships, or beneficiaries creating the conflict"
                },
                "contract_value": {
                    "label": "Contract Value Involved",
                    "type": "number",
                    "required": True,
                    "placeholder": "e.g., 2,500,000",
                    "help_text": "Monetary value of contracts affected by the conflict of interest"
                },
                "official_position": {
                    "label": "Official Position",
                    "type": "text",
                    "required": True,
                    "placeholder": "e.g., Director of Procurement, Minister of Finance",
                    "help_text": "Official title or position within government"
                }
            },
            "non_performance": {
                "contract_date": {
                    "label": "Contract Completion/Expected Date",
                    "type": "date",
                    "required": True,
                    "help_text": "Original completion date or expected delivery date"
                },
                "delivery_details": {
                    "label": "Delivery/Performance Details",
                    "type": "textarea",
                    "required": True,
                    "placeholder": "Describe what was supposed to be delivered vs. what was actually delivered...",
                    "help_text": "Specific details of contractual obligations vs. actual performance"
                },
                "actual_performance": {
                    "label": "Actual Performance Provided",
                    "type": "textarea",
                    "required": True,
                    "placeholder": "Describe what was actually delivered or performed...",
                    "help_text": "Full description of actual work performed or deliverables provided"
                },
                "reason_for_failure": {
                    "label": "Reason for Non-Performance (if any)",
                    "type": "select",
                    "required": False,
                    "options": ["force majeure", "unforeseen_circumstances", "lack_of_resources", "third_party_failure", "other"],
                    "help_text": "Primary reason for failure to perform contractual obligations"
                }
            },
            "budget_misallocation": {
                "budget_line": {
                    "label": "Budget Line / Account",
                    "type": "text",
                    "required": True,
                    "placeholder": "e.g., FY2024-Procurement-101",
                    "help_text": "Specific budget line or account where misallocation occurred"
                },
                "misallocated_amount": {
                    "label": "Misallocated Amount",
                    "type": "number",
                    "required": True,
                    "placeholder": "e.g., 1,750,000",
                    "help_text": "Exact amount of funds improperly allocated or misused"
                },
                "affected_projects": {
                    "label": "Affected Projects/Program Areas",
                    "type": "text",
                    "required": True,
                    "placeholder": "e.g., Road Construction, Education Materials",
                    "help_text": "List of projects or program areas affected by the misallocation"
                },
                "method_of_misallocation": {
                    "label": "Method of Misallocation",
                    "type": "select",
                    "required": True,
                    "options": ["redirected_funds", "duplicate_payment", "improper_classification", "fraudulent_billing", "other"],
                    "help_text": "How the funds were improperly allocated or transferred"
                }
            }
        }
        
        # Get field specs for the requested type
        specs = field_specifications.get(type, {})
        
        return {
            "type_id": type,
            "field_specifications": specs,
            "validation_rules": {
                "tender_reference": {"max_length": 200},
                "violation_description": {"max_length": 5000},
                "official_name": {"max_length": 100},
                "actual_performance": {"max_length": 5000},
                "budget_line": {"max_length": 100}
            },
            "example_data": {
                "procurement_violation": {
                    "tender_reference": "PN-2024-089",
                    "violation_description": "Amendment 3 extended delivery timeline without competitive bidding",
                    "estimated_impact": 3500000
                },
                "conflict_of_interest": {
                    "official_name": "John Smith",
                    "official_position": "Procurement Director",
                    "contrary_financial_interest": "10% ownership in ABC Construction",
                    "contract_value": 2500000
                }
            }
        }
        
    except Exception as e:
        logger.error(f"Failed to get complaint template: {e}")
        raise HTTPException(status_code=500, detail=f"Internal server error: {e}")

# ── Tender Analysis ──────────────────────────────

@router.post("/analyze")
async def analyze_tender(file: UploadFile = File(...)):
    """Analyze an uploaded tender file for corruption risk."""
    try:
        from src.analyzer import TenderExtractor, TenderParser, RiskScorer, ReportGenerator

        contents = await file.read()
        suffix = Path(file.filename or "upload").suffix.lower()
        tmp = Path("/tmp") / f"tender_{uuid.uuid4().hex}{suffix}"
        tmp.write_bytes(contents)

        extractor = TenderExtractor()
        text = extractor.from_file(str(tmp))
        tmp.unlink(missing_ok=True)

        llm = _get_llm()
        parser = TenderParser(llm) if llm else None
        from src.shared.models import TenderDocument
        tender = parser.parse(text) if parser else TenderDocument(title=file.filename or "Uploaded Tender", raw_text=text)

        scorer = RiskScorer()
        report = scorer.score(tender)

        reporter = ReportGenerator()
        summary = reporter.generate_text(report)
        summary_ne = reporter.generate_text_ne(report)

        flagged = [
            {
                "id": str(i),
                "label": c.label,
                "severity": c.severity,
                "description": c.description,
                "location": c.location,
                "suggestion": c.suggestion,
            }
            for i, c in enumerate(getattr(report, "flagged_clauses", []))
        ]

        return {
            "report_id": uuid.uuid4().hex[:12],
            "overall_risk": getattr(report, "overall_risk", "unknown"),
            "summary": summary[:2000],
            "summary_ne": summary_ne[:2000],
            "section_scores": getattr(report, "section_scores", {}),
            "flagged_clauses": flagged,
        }
    except Exception as e:
        logger.error(f"Tender analysis failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/analyze-text")
async def analyze_tender_text(text: str = Form(...), title: str = Form("Uploaded Tender")):
    """Analyze pasted tender text for corruption risk."""
    try:
        if not text.strip():
            raise HTTPException(status_code=400, detail="No text provided")

        from src.analyzer import TenderParser, RiskScorer, ReportGenerator

        llm = _get_llm()
        parser = TenderParser(llm) if llm else None
        from src.shared.models import TenderDocument
        tender = parser.parse(text) if parser else TenderDocument(title=title, raw_text=text)

        scorer = RiskScorer()
        report = scorer.score(tender)

        reporter = ReportGenerator()
        summary = reporter.generate_text(report)
        summary_ne = reporter.generate_text_ne(report)

        flagged = [
            {
                "id": str(i),
                "label": c.label,
                "severity": c.severity,
                "description": c.description,
                "location": c.location,
                "suggestion": c.suggestion,
            }
            for i, c in enumerate(getattr(report, "flagged_clauses", []))
        ]

        return {
            "report_id": uuid.uuid4().hex[:12],
            "overall_risk": getattr(report, "overall_risk", "unknown"),
            "summary": summary[:2000],
            "summary_ne": summary_ne[:2000],
            "section_scores": getattr(report, "section_scores", {}),
            "flagged_clauses": flagged,
        }
    except Exception as e:
        logger.error(f"Tender text analysis failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/draft-complaint")
async def draft_complaint(request_data: Dict[str, Any]):
    """Generate a complaint draft based on provided information.

    This endpoint takes the complaint type, complainant personal information,
    and all collected field data, then generates a properly formatted legal
    complaint document by filling the appropriate jurisdiction template.
    """
    try:
        complaint_type = request_data.get("type", "procurement_violation")
        field_data = request_data.get("field_data", {})
        complainant_info = request_data.get("complainant_info", {})

        loader = JurisdictionLoader()
        from src.shared.models import JurisdictionCode

        # ── Map complaint types to np.yaml templates ─────────────────
        type_to_template = {
            "procurement_violation": "complaint_ciaa",
            "conflict_of_interest": "complaint_ciaa",
            "budget_misallocation": "complaint_ciaa",
            "corruption": "complaint_ciaa",
            "abuse_of_authority": "complaint_ciaa",
            "non_performance": "complaint_ppmo",
            "procurement_delay": "complaint_ppmo",
            "bid_irregularity": "complaint_ppmo",
            "consumer_complaint": "complaint_consumer_doc",
            "consumer_rights": "complaint_consumer_doc",
            "unfair_pricing": "complaint_consumer_doc",
            "mrp_overcharge": "complaint_consumer_doc",
            "defective_product": "complaint_consumer_doc",
            "false_advertising": "complaint_consumer_doc",
            "banking_complaint": "complaint_banking_nrb",
            "financial_fraud": "complaint_banking_nrb",
            "loan_irregularity": "complaint_banking_nrb",
            "land_dispute": "complaint_land_revenue",
            "land_revenue": "complaint_land_revenue",
            "domestic_violence": "complaint_domestic_violence",
            "domestic_abuse": "complaint_domestic_violence",
            "cyber_crime": "complaint_cyber_crime",
            "online_fraud": "complaint_cyber_crime",
            "police_misconduct": "complaint_police_misconduct",
            "police_abuse": "complaint_police_misconduct",
            "human_rights": "complaint_human_rights_nhrc",
            "human_rights_violation": "complaint_human_rights_nhrc",
            "tax_dispute": "complaint_tax_revenue",
            "tax_evasion": "complaint_tax_revenue",
            "labour_dispute": "complaint_labour_office",
            "employment_issue": "complaint_labour_office",
            "education_malpractice": "complaint_education_malpractice",
            "medical_negligence": "complaint_medical_negligence",
            "environment_violation": "complaint_environment_violation",
            "pollution": "complaint_environment_violation",
        }
        template_name = type_to_template.get(complaint_type, "complaint_consumer_doc")

        # ── Load the template body from np.yaml ──────────────────────
        template = loader.get_template_by_name(JurisdictionCode.NEPAL, template_name)
        if template is None:
            # fallback: pick first available template
            templates = loader.get_templates(JurisdictionCode.NEPAL)
            template = templates[0] if templates else None

        template_body = template.get("body", "") if template else ""
        template_title = template.get("title", f"Complaint — {complaint_type}") if template else f"Complaint — {complaint_type}"

        # ── Build a complete draft by filling placeholders ───────────
        now = datetime.now()

        # Complainant personal details
        complainant_name = complainant_info.get("name", "[Complainant Name]")
        permanent_address = complainant_info.get("permanent_address", "[Address]")
        temporary_address = complainant_info.get("temporary_address", "[Address]")
        citizenship_no = complainant_info.get("citizenship_no", "[Citizenship No.]")
        phone = complainant_info.get("phone", "[Phone]")
        email = complainant_info.get("email", "[Email]")
        complaint_date = complainant_info.get("complaint_date", now.strftime("%d/%m/%Y"))

        # Case-specific details
        tender_reference = field_data.get("tender_reference", "[Tender Reference Number]")
        violation_description = field_data.get("violation_description", field_data.get("contrary_financial_interest", field_data.get("delivery_details", "[Description of Violation]")))
        estimated_impact = field_data.get("estimated_impact", field_data.get("contract_value", field_data.get("misallocated_amount", "[Amount]")))
        procuring_entity = field_data.get("procuring_entity", "[Procuring Entity]")

        # ── Fill template placeholders ──────────────────────────────
        filled_body = template_body
        replacements = {
            "[dd/mm/yyyy]": complaint_date,
            "[Complainant Name]": complainant_name,
            "[Address]": f"{permanent_address}" + (f" (Temp: {temporary_address})" if temporary_address and temporary_address != permanent_address else ""),
            "[Phone Number]": phone,
            "[Email Address]": email,
            "[Tender Reference Number]": tender_reference,
            "[Reference Number]": tender_reference,
            "[Amount]": str(estimated_impact),
            "[Name of Entity]": procuring_entity,
        }
        for placeholder, value in replacements.items():
            filled_body = filled_body.replace(placeholder, value)

        # ── Build descriptive text for sections that need it ────────
        violation_section = (
            f"Description of Irregularity:\n{violation_description}\n\n"
            + (f"Estimated Financial Impact: NPR {estimated_impact}\n" if estimated_impact != "[Amount]" else "")
        )

        # ── Generate a preamble with personal info ──────────────────
        preamble = (
            f"COMPLAINT GENERATED BY KALOKOT DIGITAL COUNSEL\n"
            f"Date: {complaint_date}\n"
            f"Complainant: {complainant_name}\n"
            f"Permanent Address: {permanent_address}\n"
            f"Temporary Address: {temporary_address}\n"
            f"Citizenship No.: {citizenship_no}\n"
            f"Phone: {phone}\n"
            f"Email: {email}\n"
            f"{'─' * 60}\n\n"
        )

        if violation_description:
            filled_body = filled_body.replace(
                "[Describe the specific violation — e.g., shortened timeline, single-brand specification, inflated budget, etc.]",
                violation_description
            )
            filled_body = filled_body.replace(
                "[Describe the specific procurement rule violation — e.g., insufficient timeline, missing evaluation criteria, restrictive specifications, etc.]",
                violation_description
            )

        # ── Build evidence list from field data ─────────────────────
        evidence_items = []
        if "affected_tenderers" in field_data and field_data["affected_tenderers"]:
            evidence_items.append(f"List of affected tenderers: {field_data['affected_tenderers']}")
        evidence_section = "\n".join(f"       {i+1}. {item}" for i, item in enumerate(evidence_items))

        if evidence_section:
            filled_body = filled_body.replace(
                "1. [List attached documents]\n       2. [Evidence items]\n       3. [Any other relevant materials]",
                evidence_section
            )

        final_body = preamble + filled_body

        return {
            "success": True,
            "complaint_draft": {
                "title": template_title,
                "jurisdiction": "np",
                "body": final_body,
                "template_name": template_name,
                "instructions": "Review all [bracketed] placeholders and fill in any remaining details. "
                                "Please verify all information for accuracy. "
                                "Consult with a qualified attorney before filing.",
                "requires_review": True
            },
            "metadata": {
                "complaint_type": complaint_type,
                "complainant_name": complainant_name,
                "field_count": len(field_data),
                "generated_at": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
                "template_used": template_name
            }
        }

    except Exception as e:
        logger.error(f"Failed to draft complaint: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to generate complaint: {e}")


def main():
    """Run the FastAPI backend server on port 8000."""
    try:
        from dotenv import load_dotenv
        dotenv_path = Path(__file__).resolve().parent.parent / ".env"
        if dotenv_path.exists():
            load_dotenv(dotenv_path)
    except ImportError:
        pass

    import uvicorn
    from fastapi import FastAPI
    from fastapi.middleware.cors import CORSMiddleware

    is_production = os.environ.get("PRODUCTION", "").lower() in ("1", "true", "yes")
    allowed_origins = os.environ.get("ALLOWED_ORIGINS", "http://localhost:8080").split(",")

    app = FastAPI(
        title="KaloKoT API",
        version="1.0.0",
        docs_url=None if is_production else "/docs",
        redoc_url=None if is_production else "/redoc",
    )
    SecurityHeadersMiddleware(app)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=allowed_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.state.limiter = limiter
    app.add_exception_handler(429, _rate_limit_exceeded_handler)
    app.include_router(router)

    @app.on_event("startup")
    async def startup():
        asyncio.create_task(_cleanup_sessions())

    async def _index_constitution():
        """Index the Constitution of Nepal into ChromaDB on startup."""
        try:
            from src.shared.chroma_store import ChromaLegalStore
            store = ChromaLegalStore()
            if store.count() == 0:
                path = LEGAL_DIR / "np_constitution.yaml"
                if path.exists():
                    with open(path, encoding="utf-8") as f:
                        constitution_data = yaml.safe_load(f)
                    if constitution_data and "parts" in constitution_data:
                        count = store.index_constitution(constitution_data)
                        logger.info(f"Constitution indexed: {count} clauses")
        except Exception as e:
            logger.warning(f"Constitution indexing skipped: {e}")

    async def _cleanup_sessions():
        while True:
            await asyncio.sleep(300)
            now = datetime.utcnow()
            expired = [
                k for k, v in list(_intake_sessions.items())
                if (now - v.get("created_at", now)).total_seconds() > 3600
            ]
            for k in expired:
                _intake_sessions.pop(k, None)
            if expired:
                logger.info(f"Cleaned {len(expired)} stale intake sessions")

    host = os.environ.get("API_HOST", "0.0.0.0")
    port = int(os.environ.get("API_PORT", os.environ.get("PORT", "8000")))
    uvicorn.run(app, host=host, port=port, log_level="info")