# KaloKoT — OpenTender + Counsel

**Procurement corruption risk analyzer + Virtual Lawyer for Nepali citizens.**

Upload a government tender PDF, get a corruption-risk heatmap with traffic-light scores, then chat with a Virtual Lawyer who cites specific laws and tells you exactly how to report it.

---

## Features

- **Tender Analysis** — Extract text from PDFs, URLs, or images. Scores red flags across timeline, specifications, budget, evaluation criteria, emergency procurement, and conflict of interest.
- **Risk Heatmap** — Per-section scores with an overall traffic-light (Green / Yellow / Red).
- **Virtual Lawyer** — AI-powered legal counsel grounded in the Constitution of Nepal 2015 and the Public Procurement Act 2063. Cites specific articles, identifies oversight bodies (CIAA, PPMO, OAG), and drafts complaint letters.
- **Evidence Checklist** — Jurisdiction-specific checklists for building a strong case.
- **Whistleblower Risk Assessment** — Evaluates personal risk and recommends safe reporting channels.
- **Constitution Search** — Semantic search over the full Constitution of Nepal via ChromaDB vector embeddings.

---

## Architecture

```
Justice_system/
├── src/              # Python FastAPI backend
│   ├── api.py        # REST API endpoints
│   ├── main.py       # CLI + Gradio UI entry point
│   ├── analyzer/     # Extraction, parsing, risk scoring, reporting
│   ├── lawyer/       # Virtual Lawyer, drafting, jurisprudence
│   └── shared/       # LLM client, ChromaDB, models, security
├── frontend/         # TanStack React Start SSR
│   ├── src/          # Routes, components, API client
│   └── netlify.toml  # Netlify deployment config
├── docs/legal/       # Nepal procurement law YAML corpus
├── nginx/            # Reverse proxy config (local Docker)
└── tests/            # Python test suite (85 tests)
```

---

## Local Development

### Backend

```bash
# 1. Python 3.11+ virtual environment
python3 -m venv .venv && source .venv/bin/activate

# 2. Install dependencies
pip install -r requirements.txt

# 3. Set API keys
cp .env.example .env
# Edit .env — GEMINI_API_KEY is recommended

# 4. Run (choose one)
python src/main.py               # Gradio UI on :7860
python src/main.py --api         # FastAPI backend on :8000
python src/main.py --file tender.pdf  # CLI analysis
```

### Frontend

```bash
cd frontend
npm install
npm run dev     # Dev server on :8080, proxies /api → :8000
npm run build   # Production build (Nitro Netlify preset)
```

---

## Deployment

The app uses a hybrid deployment:

| Component | Platform | Stack |
|-----------|----------|-------|
| Frontend | **Netlify** | TanStack Start SSR (Nitro Netlify preset) |
| Backend | **Render** | FastAPI Docker container |

### Backend (Render)

1. Create a **Web Service** on Render → connect your GitHub repo
2. Runtime: **Docker**
3. Start command: `python3 src/main.py --api`
4. Health check: `/api/complaint-types`
5. Set env vars: `GEMINI_API_KEY`, `PRODUCTION=1`, `ALLOWED_ORIGINS=https://your-site.netlify.app`
6. *(Optional — persistent ChromaDB)* Add a disk at `/data` and set `CHROMA_DB_PATH=/data/chromadb`

### Frontend (Netlify)

1. Update `frontend/netlify.toml` — replace `YOUR_BACKEND_URL` with your Render URL
2. Deploy:
   ```bash
   cd frontend
   npx netlify deploy --build --prod
   ```
   Or connect the GitHub repo to Netlify for auto-deploys.

### Docker (local / VPS)

```bash
docker compose up --build -d
# API on :8000, Nginx on :80
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Python, FastAPI, Uvicorn, Pydantic |
| Frontend | React 19, TanStack Start, Tailwind CSS 4, shadcn/ui |
| Vector Store | ChromaDB + Sentence-Transformers |
| LLM | Gemini 2.5 Flash (primary), OpenRouter (fallback) |
| Security | SlowAPI rate limiting, CORS, security headers |
| Deployment | Docker, Nginx, Netlify, Render |

---

## Tests

```bash
pytest tests/ -v
# 85 passing, 1 skipped (needs API key for integration test)
```

---

## Adding a New Jurisdiction

1. Create `docs/legal/<code>.yaml` (see `np.yaml` for structure)
2. Add detection signals in `src/shared/jurisdiction.py`
3. Add `JurisdictionCode` enum value in `src/shared/models.py`

---

## Disclaimer

This is **not a law firm**. The Virtual Lawyer is an informational tool — it uses a knowledge base of procurement laws and an LLM to generate guidance. Laws change. Facts matter. Always consult a qualified attorney licensed in your jurisdiction before taking legal action.
