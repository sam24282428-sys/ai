const fs = require("fs");
const path = require("path");

const DEFAULT_INTERESTS = [
  "AI agent",
  "LLM memory",
  "Gemini",
  "Claude",
  "developer tools",
  "open source",
];

function getTodayDateString() {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(new Date());
}

function getShanghaiHour() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    hour: "numeric",
    hour12: false,
  }).formatToParts(new Date());
  const hourPart = parts.find((p) => p.type === "hour");
  return hourPart ? Number(hourPart.value) : new Date().getHours();
}

function createPresenceService(config, memoryInjector = null) {
  const latentBaseDir = path.dirname(config.latentCorpusDir || path.join(config.stateDir, "latent", "memory"));
  const interestsFile = path.join(latentBaseDir, "interests.json");
  const newspaperDir = path.join(latentBaseDir, "newspaper");
  const heartbeatDir = path.join(latentBaseDir, "heartbeat");
  const stateFile = path.join(latentBaseDir, "presence-state.json");

  function loadState() {
    try {
      if (fs.existsSync(stateFile)) {
        return JSON.parse(fs.readFileSync(stateFile, "utf8"));
      }
    } catch {
      // ignore corrupt state
    }
    return {
      lastDreamDate: "",
      lastNewspaperDate: "",
      lastNewspaperSharedDate: "",
      lastHeartbeatAt: "",
    };
  }

  function saveState(state) {
    try {
      fs.mkdirSync(latentBaseDir, { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf8");
    } catch {
      // non-fatal
    }
  }

  function ensureInterestsFile() {
    if (!fs.existsSync(interestsFile)) {
      try {
        fs.mkdirSync(latentBaseDir, { recursive: true });
        fs.writeFileSync(
          interestsFile,
          JSON.stringify({ topics: DEFAULT_INTERESTS }, null, 2),
          "utf8",
        );
      } catch {
        // non-fatal
      }
    }
  }

  function loadInterests() {
    ensureInterestsFile();
    try {
      const parsed = JSON.parse(fs.readFileSync(interestsFile, "utf8"));
      if (Array.isArray(parsed?.topics) && parsed.topics.length) {
        return parsed.topics.map((t) => String(t).trim()).filter(Boolean);
      }
    } catch {
      // fallback
    }
    return DEFAULT_INTERESTS;
  }

  async function fetchNewspaperIfNeeded() {
    if (config.presenceNewspaperEnabled === false) {
      return null;
    }
    const today = getTodayDateString();
    const state = loadState();
    const paperPath = path.join(newspaperDir, `${today}.json`);
    if (state.lastNewspaperDate === today && fs.existsSync(paperPath)) {
      try {
        return JSON.parse(fs.readFileSync(paperPath, "utf8"));
      } catch {
        return null;
      }
    }

    const topics = loadInterests();
    const query = encodeURIComponent(topics.slice(0, 3).join(" OR "));
    const items = [];
    try {
      const resp = await fetch(
        `https://hn.algolia.com/api/v1/search_by_date?query=${query}&tags=story&hitsPerPage=8`,
        { signal: AbortSignal.timeout(6000) },
      );
      if (resp.ok) {
        const data = await resp.json();
        for (const hit of Array.isArray(data?.hits) ? data.hits : []) {
          if (hit?.title && (hit?.url || hit?.objectID)) {
            items.push({
              title: String(hit.title).trim(),
              url: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
              points: Number(hit.points || 0),
              source: "HackerNews",
            });
          }
        }
      }
    } catch {
      // network optional, fail silently
    }

    if (items.length) {
      try {
        fs.mkdirSync(newspaperDir, { recursive: true });
        const payload = {
          date: today,
          fetchedAt: new Date().toISOString(),
          topics,
          items: items.slice(0, 5),
        };
        fs.writeFileSync(paperPath, JSON.stringify(payload, null, 2), "utf8");
        state.lastNewspaperDate = today;
        saveState(state);
        return payload;
      } catch {
        return null;
      }
    }
    return null;
  }

  function appendHeartbeatNote(note) {
    const clean = String(note || "").trim();
    if (!clean) {
      return;
    }
    try {
      fs.mkdirSync(heartbeatDir, { recursive: true });
      const today = getTodayDateString();
      const hbPath = path.join(heartbeatDir, `${today}.md`);
      const timeStr = new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date());
      fs.appendFileSync(hbPath, `- [${timeStr}] ${clean}\n`, "utf8");
    } catch {
      // non-fatal
    }
  }

  async function runMaintenanceTick() {
    const today = getTodayDateString();
    const hour = getShanghaiHour();
    const state = loadState();

    // Nightly dream consolidation between 03:00 and 05:59 Asia/Shanghai
    if (
      config.dreamEnabled !== false
      && memoryInjector
      && hour >= 3
      && hour <= 5
      && state.lastDreamDate !== today
    ) {
      const dreamRes = await memoryInjector.runDreamConsolidation().catch(() => null);
      if (dreamRes && dreamRes.status === "ok") {
        state.lastDreamDate = today;
        saveState(state);
        appendHeartbeatNote(
          `Dream consolidation completed: synced=${dreamRes.nodes_synced}, discovered=${dreamRes.edges_discovered}, verified=${dreamRes.verified_count}.`,
        );
        console.log(`[cyberboss] dream pass completed: ${JSON.stringify(dreamRes)}`);
      }
    }

    // Daytime newspaper fetch (08:00 - 22:00)
    let newspaperToShare = null;
    if (hour >= 8 && hour <= 22) {
      const paper = await fetchNewspaperIfNeeded();
      if (paper && Array.isArray(paper.items) && paper.items.length && state.lastNewspaperSharedDate !== today) {
        newspaperToShare = paper;
        state.lastNewspaperSharedDate = today;
        state.lastHeartbeatAt = new Date().toISOString();
        saveState(state);
        appendHeartbeatNote(`Read ${paper.items.length} tech items (${paper.items[0].title}).`);
      }
    }

    return { newspaperToShare };
  }

  return {
    runMaintenanceTick,
    fetchNewspaperIfNeeded,
    appendHeartbeatNote,
  };
}

module.exports = {
  createPresenceService,
};
