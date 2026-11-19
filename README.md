# Web-Graph

Aplikasi web crawler berbasis **Breadth-First Search (BFS)** hingga kedalaman `depth = n` dengan visualisasi **graph interaktif** secara *real-time* (via Server-Sent Events), dilengkapi analisis **PageRank**, **Auto-Save SQLite (`zlib`)**, serta **Upload `.json` / `.json.gz`** untuk visualisasi instan.

## Fitur Utama
1. **Dua Mode Representasi Graph**:
   - **Antar Website (`domains`)**: Memetakan relasi antar-domain website (1 website = 1 node, lengkap dengan favicon, bobot relasi berbobot, deteksi *mutual link*, serta filter sosmed/tracker).
   - **Halaman (`pages`)**: Memetakan struktur link antar-halaman internal hingga `depth = n`.
2. **Input Link & Kedalaman Fleksibel**: Mendukung Single/Multi-Seed URL, pengaturan `max_depth = n` bebas, `max_pages`, `max_pages_per_domain`, dan kepatuhan `robots.txt`.
3. **Visualisasi Graph Interaktif (`react-force-graph-2d`)**:
   - Label nama & `Rank #` tampil hanya saat node di-hover.
   - Ukuran node berdasarkan **PageRank**, **In-Degree**, atau **Seragam**.
   - Pilihan pusat gravitasi (**Center: Input Link** atau **Center: PageRank Tertinggi**).
   - Pewarnaan berdasarkan `Depth`, `Ekstensi TLD`, `HTTP Status`, atau `Domain Hash`.
   - Optimasi canvas untuk graf besar (offscreen circular favicon cache, LOD, zero-rerender hover, batching adaptif, dan filter `Top-N` PageRank).
4. **Menu Ranking & Inspector**:
   - Tab **Ranking** dengan paginasi **50 item/halaman**, pencarian, filter depth, dan export CSV.
   - **Node & Edge Inspector** untuk melihat detail HTTP, incoming/outgoing links (paginasi 50/halaman), serta sampel URL penghubung.
5. **Penyimpanan Efisien & Upload Langsung**:
   - Auto-save hasil crawl ke SQLite terkompresi `zlib`.
   - Export/Import portabel **`.json.gz` (compact indexed v2)**, `.json`, `.csv`, dan `.png` (termasuk *drag & drop* ke canvas).

## Instalasi & Menjalankan Lokal

### 1. Backend (Python / FastAPI)
```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\pip.exe install -r requirements.txt
.\.venv\Scripts\uvicorn.exe app.main:app --reload --port 8000
```

### 2. Frontend (React + Vite)
```powershell
cd frontend
npm install
npm run dev
```

Buka URL frontend yang ditampilkan Vite (biasanya `http://localhost:5173`). Request `/api/*` otomatis diteruskan ke backend di port `8000`.

## Pengujian
```powershell
cd backend
.\.venv\Scripts\pytest.exe -v
```
