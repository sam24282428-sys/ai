#!/usr/bin/env python3
"""Lightweight Hebbian association graph, dream consolidation, and proxy recall
for low-memory (1GB RAM) VPS environments. Pure Python stdlib only."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import os
import re
import sqlite3
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

STOPWORDS = {
    "the", "and", "for", "that", "this", "with", "from", "have", "has", "was",
    "were", "are", "not", "but", "you", "your", "can", "will", "just", "about",
    "what", "when", "where", "which", "who", "how", "why", "into", "onto",
    "我们", "你们", "他们", "这个", "那个", "什么", "怎么", "为什么", "可以", "因为",
    "所以", "如果", "但是", "然后", "就是", "已经", "还是", "没有", "不是", "需要",
    "自己", "现在", "今天", "昨天", "明天", "时候", "事情", "工作", "生活", "觉得",
    "记录", "状态", "时间", "问题", "继续", "完成", "开始", "使用",
}

EMOTION_WORDS = {
    "开心": 0.4, "高兴": 0.4, "兴奋": 0.5, "喜欢": 0.4, "爱": 0.5, "感动": 0.6,
    "难过": 0.6, "伤心": 0.6, "崩溃": 0.8, "焦虑": 0.7, "烦躁": 0.5, "累": 0.4,
    "疲惫": 0.5, "痛苦": 0.7, "害怕": 0.6, "担心": 0.5, "生气": 0.6, "委屈": 0.7,
    "坚持": 0.4, "突破": 0.5, "成功": 0.5, "重要": 0.4, "约定": 0.5, "承诺": 0.6,
    "熬夜": 0.4, "失眠": 0.5, "发烧": 0.6, "生病": 0.6, "不舒服": 0.5,
    "happy": 0.4, "love": 0.5, "sad": 0.6, "anxious": 0.7, "tired": 0.4,
    "important": 0.4, "promise": 0.6, "breakthrough": 0.5,
}

HEADER_RE = re.compile(
    r"^##\s+(\d{4}-\d{2}-\d{2})\s*[·•\-]\s*(.+?)(?:\s*\[record_id=([^\]]+)\])?\s*$"
)
TOKEN_RE = re.compile(r"[a-zA-Z0-9_]{2,}|[\u4e00-\u9fff]{2,}")


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def today_str() -> str:
    return dt.datetime.now().strftime("%Y-%m-%d")


def extract_keywords(text: str, max_keywords: int = 24) -> List[str]:
    counts: Dict[str, int] = {}
    for match in TOKEN_RE.findall(text or ""):
        tok = match.lower()
        if tok in STOPWORDS or tok.isdigit():
            continue
        # Split long Chinese phrases into overlapping 2-char bigrams + full token
        if re.fullmatch(r"[\u4e00-\u9fff]+", tok) and len(tok) > 4:
            counts[tok] = counts.get(tok, 0) + 2
            for i in range(len(tok) - 1):
                bg = tok[i : i + 2]
                if bg not in STOPWORDS:
                    counts[bg] = counts.get(bg, 0) + 1
        else:
            counts[tok] = counts.get(tok, 0) + 1
    ranked = sorted(counts.items(), key=lambda kv: (-kv[1], -len(kv[0]), kv[0]))
    return [k for k, _ in ranked[:max_keywords]]


def score_emotion(text: str) -> float:
    if not text:
        return 0.1
    lower = text.lower()
    total = 0.1
    for word, weight in EMOTION_WORDS.items():
        if word in lower:
            total += weight
    if "!" in text or "！" in text:
        total += 0.1
    return round(min(1.0, total), 3)


def open_db(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS nodes (
            record_id TEXT PRIMARY KEY,
            date TEXT NOT NULL,
            title TEXT NOT NULL,
            snippet TEXT NOT NULL,
            keywords TEXT NOT NULL,
            emotion_score REAL NOT NULL DEFAULT 0.1,
            recall_count INTEGER NOT NULL DEFAULT 0,
            last_recalled_at TEXT DEFAULT '',
            source_file TEXT DEFAULT '',
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS edges (
            src TEXT NOT NULL,
            dst TEXT NOT NULL,
            weight REAL NOT NULL DEFAULT 0.5,
            co_activations INTEGER NOT NULL DEFAULT 0,
            edge_type TEXT NOT NULL DEFAULT 'hebbian',
            updated_at TEXT NOT NULL,
            PRIMARY KEY (src, dst)
        );
        CREATE TABLE IF NOT EXISTS dream_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ran_at TEXT NOT NULL,
            nodes_synced INTEGER NOT NULL,
            edges_decayed INTEGER NOT NULL,
            edges_pruned INTEGER NOT NULL,
            edges_discovered INTEGER NOT NULL,
            duplicates_found INTEGER NOT NULL,
            verified_count INTEGER NOT NULL
        );
        """
    )
    return conn


def parse_corpus_records(corpus_dir: Path) -> List[Dict[str, str]]:
    records: List[Dict[str, str]] = []
    if not corpus_dir.exists():
        return records
    for md_file in sorted(corpus_dir.glob("*.md")):
        if md_file.name.startswith("unresolved"):
            continue
        try:
            lines = md_file.read_text(encoding="utf-8", errors="ignore").splitlines()
        except OSError:
            continue
        current: Optional[Dict[str, str]] = None
        body_lines: List[str] = []

        def flush():
            if current is not None:
                body = "\n".join(body_lines).strip()
                current["body"] = body
                records.append(current)

        for idx, line in enumerate(lines):
            m = HEADER_RE.match(line.strip())
            if m:
                flush()
                date_val, title_val, rid = m.groups()
                rid_clean = (rid or f"{md_file.stem}-{idx}").strip()
                current = {
                    "record_id": rid_clean,
                    "date": date_val.strip(),
                    "title": title_val.strip(),
                    "source_file": md_file.name,
                }
                body_lines = []
            elif current is not None:
                body_lines.append(line)
        flush()
    return records


def sync_corpus(conn: sqlite3.Connection, corpus_dir: Path) -> int:
    records = parse_corpus_records(corpus_dir)
    ts = now_iso()
    synced = 0
    for rec in records:
        full_text = f"{rec['title']}\n{rec['body']}"
        keywords = extract_keywords(full_text)
        emotion = score_emotion(full_text)
        snippet = re.sub(r"\s+", " ", rec["body"]).strip()[:240]
        conn.execute(
            """
            INSERT INTO nodes (record_id, date, title, snippet, keywords, emotion_score, source_file, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(record_id) DO UPDATE SET
                date=excluded.date,
                title=excluded.title,
                snippet=excluded.snippet,
                keywords=excluded.keywords,
                emotion_score=excluded.emotion_score,
                source_file=excluded.source_file,
                updated_at=excluded.updated_at
            """,
            (
                rec["record_id"],
                rec["date"],
                rec["title"],
                snippet,
                json.dumps(keywords, ensure_ascii=False),
                emotion,
                rec["source_file"],
                ts,
            ),
        )
        synced += 1
    conn.commit()
    return synced


def canonical_pair(a: str, b: str) -> Tuple[str, str]:
    return (a, b) if a < b else (b, a)


def co_activate(conn: sqlite3.Connection, record_ids: Sequence[str], delta: float = 0.2) -> None:
    unique = [rid for rid in dict.fromkeys(record_ids) if rid]
    if not unique:
        return
    ts = now_iso()
    for rid in unique:
        conn.execute(
            "UPDATE nodes SET recall_count = recall_count + 1, last_recalled_at = ? WHERE record_id = ?",
            (ts, rid),
        )
    for i in range(len(unique)):
        for j in range(i + 1, len(unique)):
            src, dst = canonical_pair(unique[i], unique[j])
            conn.execute(
                """
                INSERT INTO edges (src, dst, weight, co_activations, edge_type, updated_at)
                VALUES (?, ?, ?, 1, 'hebbian', ?)
                ON CONFLICT(src, dst) DO UPDATE SET
                    weight = MIN(10.0, edges.weight + ?),
                    co_activations = edges.co_activations + 1,
                    updated_at = ?
                """,
                (src, dst, round(0.5 + delta, 3), ts, delta, ts),
            )
    conn.commit()


def associative_expand(
    conn: sqlite3.Connection, seed_ids: Sequence[str], limit: int = 3
) -> List[Dict[str, object]]:
    if not seed_ids:
        return []
    seed_set = set(seed_ids)
    placeholders = ",".join("?" for _ in seed_ids)
    rows = conn.execute(
        f"""
        SELECT src, dst, weight, edge_type FROM edges
        WHERE src IN ({placeholders}) OR dst IN ({placeholders})
        ORDER BY weight DESC
        LIMIT 30
        """,
        tuple(seed_ids) + tuple(seed_ids),
    ).fetchall()
    neighbor_scores: Dict[str, Tuple[float, str]] = {}
    for r in rows:
        other = r["dst"] if r["src"] in seed_set else r["src"]
        if other in seed_set:
            continue
        prev = neighbor_scores.get(other)
        if prev is None or r["weight"] > prev[0]:
            neighbor_scores[other] = (float(r["weight"]), str(r["edge_type"]))
    if not neighbor_scores:
        return []
    top_neighbors = sorted(neighbor_scores.items(), key=lambda kv: -kv[1][0])[:limit]
    results: List[Dict[str, object]] = []
    for nid, (weight, edge_type) in top_neighbors:
        node = conn.execute(
            "SELECT record_id, date, title, snippet, emotion_score FROM nodes WHERE record_id = ?",
            (nid,),
        ).fetchone()
        if node:
            results.append(
                {
                    "record_id": node["record_id"],
                    "date": node["date"],
                    "title": node["title"],
                    "snippet": node["snippet"],
                    "emotion_score": node["emotion_score"],
                    "edge_weight": round(weight, 3),
                    "edge_type": edge_type,
                }
            )
    return results


def recency_weight(date_str: str) -> float:
    try:
        d = dt.date.fromisoformat(date_str)
        days = max(0, (dt.date.today() - d).days)
        return math.exp(-days / 30.0)
    except ValueError:
        return 0.3


def read_unresolved(corpus_dir: Path, limit: int = 6) -> List[str]:
    items: List[str] = []
    for fname in ("unresolved.md", "unresolved.jsonl"):
        fpath = corpus_dir / fname
        if not fpath.exists():
            continue
        try:
            text = fpath.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        if fname.endswith(".jsonl"):
            for line in text.splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if str(obj.get("status", "open")).lower() in ("open", "pending", "active", ""):
                    desc = str(obj.get("title") or obj.get("text") or obj.get("content") or "").strip()
                    if desc:
                        items.append(desc[:140])
        else:
            for line in text.splitlines():
                stripped = line.strip()
                if stripped.startswith(("- [ ]", "* [ ]", "- ")) and "[x]" not in stripped.lower():
                    items.append(stripped.lstrip("-* []").strip()[:140])
    return items[:limit]


def read_latest_thread(threads_file: Path) -> Optional[Dict[str, str]]:
    if not threads_file.exists():
        return None
    try:
        lines = [ln.strip() for ln in threads_file.read_text(encoding="utf-8", errors="ignore").splitlines() if ln.strip()]
    except OSError:
        return None
    for line in reversed(lines):
        try:
            obj = json.loads(line)
            if isinstance(obj, dict):
                summary = str(obj.get("summary") or obj.get("handoff") or obj.get("topic") or "").strip()
                if summary:
                    return {
                        "date": str(obj.get("closed_at") or obj.get("updated_at") or "")[:10],
                        "summary": summary[:220],
                    }
        except json.JSONDecodeError:
            continue
    return None


def build_inject_context(
    conn: sqlite3.Connection,
    corpus_dir: Path,
    threads_file: Path,
    query: str,
    top_k: int = 3,
) -> Dict[str, object]:
    sync_corpus(conn, corpus_dir)
    query_kws = set(extract_keywords(query, max_keywords=16))
    all_nodes = conn.execute(
        "SELECT record_id, date, title, snippet, keywords, emotion_score, recall_count FROM nodes"
    ).fetchall()

    scored: List[Tuple[float, sqlite3.Row]] = []
    for node in all_nodes:
        try:
            node_kws = set(json.loads(node["keywords"]))
        except Exception:
            node_kws = set()
        overlap = len(query_kws & node_kws)
        title_hit = 1 if any(kw in (node["title"] or "").lower() for kw in query_kws) else 0
        if query_kws and overlap == 0 and title_hit == 0:
            continue
        score = (
            overlap * 1.5
            + title_hit * 1.2
            + float(node["emotion_score"]) * 0.8
            + recency_weight(node["date"]) * 1.0
            + min(0.5, float(node["recall_count"]) * 0.05)
        )
        scored.append((score, node))

    scored.sort(key=lambda item: -item[0])
    direct_hits = []
    seed_ids = []
    for score, node in scored[:top_k]:
        seed_ids.append(node["record_id"])
        direct_hits.append(
            {
                "record_id": node["record_id"],
                "date": node["date"],
                "title": node["title"],
                "snippet": node["snippet"],
                "score": round(score, 2),
            }
        )

    # Fallback: if no keyword hits, surface 2 most recent / highest emotion nodes
    if not direct_hits and all_nodes:
        fallback = sorted(
            all_nodes,
            key=lambda n: (n["date"], float(n["emotion_score"])),
            reverse=True,
        )[:2]
        for node in fallback:
            seed_ids.append(node["record_id"])
            direct_hits.append(
                {
                    "record_id": node["record_id"],
                    "date": node["date"],
                    "title": node["title"],
                    "snippet": node["snippet"],
                    "score": 0.5,
                }
            )

    associations = associative_expand(conn, seed_ids, limit=2)
    if len(seed_ids) >= 2:
        co_activate(conn, seed_ids, delta=0.15)

    return {
        "unresolved": read_unresolved(corpus_dir),
        "latest_thread": read_latest_thread(threads_file),
        "recalled": direct_hits,
        "associations": associations,
    }


def run_dream_pass(
    conn: sqlite3.Connection,
    corpus_dir: Path,
    transcripts_dir: Path,
    reports_dir: Path,
) -> Dict[str, object]:
    nodes_synced = sync_corpus(conn, corpus_dir)

    # 1. Hebbian weight decay (0.9x) and prune weak edges (< 0.1)
    cur = conn.execute("UPDATE edges SET weight = weight * 0.9, updated_at = ?", (now_iso(),))
    edges_decayed = cur.rowcount
    cur = conn.execute("DELETE FROM edges WHERE weight < 0.1")
    edges_pruned = cur.rowcount
    conn.commit()

    # 2. Discover cross-day conceptual bridges & near-duplicates
    nodes = conn.execute("SELECT record_id, date, title, snippet, keywords FROM nodes").fetchall()
    kw_map: Dict[str, set] = {}
    for n in nodes:
        try:
            kw_map[n["record_id"]] = set(json.loads(n["keywords"]))
        except Exception:
            kw_map[n["record_id"]] = set()

    edges_discovered = 0
    duplicates: List[Tuple[str, str, float]] = []
    ts = now_iso()

    for i in range(len(nodes)):
        a = nodes[i]
        kws_a = kw_map[a["record_id"]]
        if not kws_a:
            continue
        for j in range(i + 1, len(nodes)):
            b = nodes[j]
            kws_b = kw_map[b["record_id"]]
            if not kws_b:
                continue
            inter = kws_a & kws_b
            union = kws_a | kws_b
            jaccard = len(inter) / len(union) if union else 0.0
            if jaccard >= 0.72:
                duplicates.append((a["record_id"], b["record_id"], round(jaccard, 2)))
            if len(inter) >= 3 and a["date"] != b["date"]:
                src, dst = canonical_pair(a["record_id"], b["record_id"])
                existing = conn.execute(
                    "SELECT 1 FROM edges WHERE src = ? AND dst = ?", (src, dst)
                ).fetchone()
                if not existing:
                    conn.execute(
                        """
                        INSERT INTO edges (src, dst, weight, co_activations, edge_type, updated_at)
                        VALUES (?, ?, ?, 0, 'concept', ?)
                        """,
                        (src, dst, round(min(1.5, 0.35 + 0.1 * len(inter)), 3), ts),
                    )
                    edges_discovered += 1
    conn.commit()

    # 3. Verify recent memories against conversation transcripts
    transcript_text = ""
    if transcripts_dir.exists():
        recent_files = sorted(transcripts_dir.glob("*.jsonl"))[-3:]
        chunks = []
        for tf in recent_files:
            try:
                chunks.append(tf.read_text(encoding="utf-8", errors="ignore"))
            except OSError:
                pass
        transcript_text = "\n".join(chunks).lower()

    recent_cutoff = (dt.date.today() - dt.timedelta(days=2)).isoformat()
    verified_count = 0
    unverified_notes: List[str] = []
    for n in nodes:
        if n["date"] >= recent_cutoff and n["record_id"] != "bootstrap-0001":
            kws = list(kw_map[n["record_id"]])[:6]
            if transcript_text and any(k in transcript_text for k in kws):
                verified_count += 1
            elif transcript_text:
                unverified_notes.append(f"- [{n['date']}] {n['title']} (`{n['record_id']}`)")

    conn.execute(
        """
        INSERT INTO dream_log (ran_at, nodes_synced, edges_decayed, edges_pruned, edges_discovered, duplicates_found, verified_count)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (ts, nodes_synced, edges_decayed, edges_pruned, edges_discovered, len(duplicates), verified_count),
    )
    conn.commit()

    reports_dir.mkdir(parents=True, exist_ok=True)
    report_file = reports_dir / f"{today_str()}.md"
    report_lines = [
        f"# 梦境巩固报告 ({today_str()})",
        "",
        f"- 运行时间: {ts}",
        f"- 同步记忆节点: {nodes_synced}",
        f"- 赫布边衰减: {edges_decayed} 条，清理弱连接: {edges_pruned} 条",
        f"- 新发现跨日概念关联边: {edges_discovered} 条",
        f"- 近期记忆逐字稿核验通过: {verified_count} 条",
        f"- 高相似度待合并候选: {len(duplicates)} 对",
    ]
    if duplicates:
        report_lines.append("")
        report_lines.append("## 疑似重复记忆候选")
        for a_id, b_id, score in duplicates[:10]:
            report_lines.append(f"- `{a_id}` <-> `{b_id}` (关键词重合度: {score})")
    if unverified_notes:
        report_lines.append("")
        report_lines.append("## 近期未在对话逐字稿中找到直接印证的条目")
        report_lines.extend(unverified_notes[:10])
    report_file.write_text("\n".join(report_lines) + "\n", encoding="utf-8")

    return {
        "status": "ok",
        "nodes_synced": nodes_synced,
        "edges_decayed": edges_decayed,
        "edges_pruned": edges_pruned,
        "edges_discovered": edges_discovered,
        "duplicates_found": len(duplicates),
        "verified_count": verified_count,
        "report_file": str(report_file),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Lightweight Hebbian & Dream engine for Latent-memory")
    parser.add_argument("--corpus", required=True, help="Path to Latent memory corpus directory")
    parser.add_argument("--threads", default="", help="Path to threads.jsonl")
    parser.add_argument("--db", default="", help="Path to hebbian.db (default: <corpus>/../hebbian.db)")
    parser.add_argument("--transcripts", default="", help="Path to transcripts directory")
    parser.add_argument("--reports", default="", help="Path to dream-reports directory")
    parser.add_argument("--inject-query", default="", help="Return JSON memory context for proxy injection")
    parser.add_argument("--dream", action="store_true", help="Run nightly dream consolidation pass")
    args = parser.parse_args()

    corpus_dir = Path(args.corpus).expanduser().resolve()
    state_latent = corpus_dir.parent
    db_path = Path(args.db).expanduser().resolve() if args.db else (state_latent / "hebbian.db")
    threads_file = Path(args.threads).expanduser().resolve() if args.threads else (state_latent / "threads.jsonl")
    transcripts_dir = Path(args.transcripts).expanduser().resolve() if args.transcripts else (state_latent / "transcripts")
    reports_dir = Path(args.reports).expanduser().resolve() if args.reports else (state_latent / "dream-reports")

    conn = open_db(db_path)
    try:
        if args.dream:
            result = run_dream_pass(conn, corpus_dir, transcripts_dir, reports_dir)
            print(json.dumps(result, ensure_ascii=False))
            return 0
        if args.inject_query is not None and args.inject_query != "":
            result = build_inject_context(conn, corpus_dir, threads_file, args.inject_query)
            print(json.dumps(result, ensure_ascii=False))
            return 0
        synced = sync_corpus(conn, corpus_dir)
        print(json.dumps({"status": "ok", "nodes_synced": synced}, ensure_ascii=False))
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
