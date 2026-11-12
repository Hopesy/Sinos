// Cloudflare Pages Function — Sinos CLI distribution endpoint.
// Uses env.ASSETS to serve CF Pages static files directly.
//
// Routes:
//   /download/<platform>   → proxy GitHub Release assets
//   /version.json?platform=<platform>
//                          → report a version only when that platform asset exists
//   /*                     → CF Pages static files (env.ASSETS)
//                            (release asset discovery is resolved from GitHub
//                             at request time.)

const REPO = "Hopesy/Sinos"

// Asset filenames follow `Sinos.CLI_<version>_<OS>_<arch>.<ext>`
// starting v1.9.2 (CI rename step). Pre-v1.9.2 filenames had no OS
// label and used inconsistent arch slugs (amd64 / x86_64 / aarch64);
// we keep the legacy patterns as a fallback so the worker still
// resolves correctly if someone manually republishes an older tag.
const PLATFORM_PATTERNS = {
  "windows": (name) =>
    name.endsWith("Windows_x64-setup.exe") || name.endsWith("x64-setup.exe"),
  "windows-msi": (name) =>
    name.endsWith("Windows_x64.msi") || /_x64(_[^_]+)?\.msi$/.test(name),
  "macos-arm": (name) =>
    name.endsWith("macOS_arm64.dmg") || (name.includes("aarch64") && name.endsWith(".dmg")),
  "macos-intel": (name) =>
    // Tauri-bundler v2 maps x86_64-apple-darwin to `_x64.dmg`; CI then
    // renames to `Sinos.CLI_<ver>_macOS_x64.dmg`. Match both so a
    // manually-published Tauri output still resolves.
    name.endsWith("macOS_x64.dmg") || name.endsWith("_x64.dmg"),
  "linux-deb": (name) =>
    name.endsWith("Linux_x64.deb") || name.endsWith("amd64.deb"),
  "linux-rpm": (name) =>
    name.endsWith("Linux_x64.rpm") || name.endsWith("x86_64.rpm"),
  "linux-appimage": (name) =>
    name.endsWith("Linux_x64.AppImage") || name.endsWith("amd64.AppImage"),
  "linux-arm64-deb": (name) =>
    name.endsWith("Linux_arm64.deb") || name.endsWith("arm64.deb"),
  "linux-arm64-rpm": (name) =>
    name.endsWith("Linux_arm64.rpm") || name.endsWith("aarch64.rpm"),
  "linux-arm64-appimage": (name) =>
    name.endsWith("Linux_arm64.AppImage") || name.endsWith("aarch64.AppImage"),
}

async function getLatestAssets(env) {
  // Cache key bumped to v2 after changing the `version` field shape
  // (strip leading "v"). Old v1 entries would otherwise linger in KV
  // for up to an hour after deploy.
  const cacheKey = "latest-release-v2"
  // Separate "last known good" key with no TTL. Used as a stale
  // fallback when the GitHub API call fails (rate limit, outage).
  // Without this, a single 60/hr unauthenticated rate-limit hit on
  // the shared CF Worker IP pool turns every install attempt into a
  // 502 until the next hour rolls over.
  const stableKey = "latest-release-stable-v2"
  if (env.KV) {
    const cached = await env.KV.get(cacheKey)
    if (cached) return JSON.parse(cached)
  }

  let res
  try {
    res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { "User-Agent": "SinosCLI-Worker" }
    })
  } catch (e) {
    if (env.KV) {
      const stale = await env.KV.get(stableKey)
      if (stale) return JSON.parse(stale)
    }
    throw e
  }
  if (!res.ok) {
    if (env.KV) {
      const stale = await env.KV.get(stableKey)
      if (stale) return JSON.parse(stale)
    }
    throw new Error(`GitHub API ${res.status}`)
  }

  const release = await res.json()
  const assets = {}
  for (const [platform, match] of Object.entries(PLATFORM_PATTERNS)) {
    const asset = release.assets.find(a => match(a.name))
    if (asset) assets[platform] = {
      url: asset.browser_download_url,
      name: asset.name,
      // Strip the leading "v" from the git tag name so `version` is a
      // clean semver. install.ps1 / install.sh prepend their own "v"
      // when displaying, and compare against the Windows registry
      // DisplayVersion field (which has no "v"). Returning "v1.0.7"
      // here produced "vv1.0.7" in the UI and broke the up-to-date
      // check (registry "1.0.7" != API "v1.0.7" → infinite "upgrade").
      version: release.tag_name.replace(/^v/, '')
    }
  }

  if (env.KV) {
    const payload = JSON.stringify(assets)
    await env.KV.put(cacheKey, payload, { expirationTtl: 3600 })
    // Stable copy has no TTL — only ever overwritten by a successful
    // fetch, never expires on its own. Worst case during a long
    // outage: users see the previous release until GitHub recovers.
    await env.KV.put(stableKey, payload)
  }
  return assets
}

// Homepage languages: dictionary code → path (same table as js/main.js and
// scripts/build-web-i18n.mjs).
const LANG_PATH = {
  "en": "/", "zh": "/zh/", "zh-TW": "/zh-hant/", "ja": "/ja/", "ko": "/ko/",
  "es": "/es/", "fr": "/fr/", "de": "/de/", "pt": "/pt/", "ru": "/ru/",
}

// The first supported language in Accept-Language, by q-value then order.
// Traditional Chinese for zh-TW / zh-HK / zh-MO / zh-Hant, Simplified otherwise.
function langFromAcceptLanguage(header) {
  const ranked = (header || "").split(",").map((part, i) => {
    const [tag, ...params] = part.trim().toLowerCase().split(";")
    const q = params.map(p => p.trim()).find(p => p.startsWith("q="))
    return { tag, q: q ? parseFloat(q.slice(2)) || 0 : 1, i }
  }).filter(e => e.tag && e.q > 0).sort((a, b) => b.q - a.q || a.i - b.i)
  for (const { tag } of ranked) {
    if (tag === "zh" || tag.startsWith("zh-")) {
      return /^zh-(tw|hk|mo|hant)\b/.test(tag) ? "zh-TW" : "zh"
    }
    const base = tag.split("-")[0]
    if (LANG_PATH[base]) return base
  }
  return "en"
}

function cookieLang(header) {
  const m = (header || "").match(/(?:^|;\s*)coffee_lang=([^;]*)/)
  if (!m) return null
  let v
  try { v = decodeURIComponent(m[1]) } catch (e) { return null }
  return LANG_PATH[v] ? v : null
}

const BOT_UA = /bot|crawl|spider|slurp|facebookexternalhit|embedly|preview|lighthouse/i

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const { pathname } = url

    if (pathname === "/robots.txt") {
      const response = await env.ASSETS.fetch(request)
      if (!response.ok) return response
      const body = (await response.text()).replace(/^Sitemap:.*$/m, `Sitemap: ${url.origin}/sitemap.xml`)
      return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } })
    }

    if (pathname === "/sitemap.xml") {
      const response = await env.ASSETS.fetch(request)
      if (!response.ok) return response
      const origin = url.origin.replace(/&/g, "&amp;").replace(/"/g, "&quot;")
      const body = (await response.text())
        .replace(/<loc>\//g, `<loc>${origin}/`)
        .replace(/href="\//g, `href="${origin}/`)
      return new Response(body, { headers: { "Content-Type": "application/xml; charset=utf-8" } })
    }

    // ── /version.json ────────────────────────────────────────────────────────
    // Do not publish a tag before its requested installer is actually present.
    // This closes the release-build window where a new version was visible but
    // the download endpoint still returned 404 while CI was uploading assets.
    if (pathname === "/version.json") {
      const platform = url.searchParams.get("platform") || "windows"
      if (!PLATFORM_PATTERNS[platform]) {
        return new Response(JSON.stringify({ version: "" }), {
          status: 400,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
          }
        })
      }

      let assets
      try {
        assets = await getLatestAssets(env)
      } catch (_error) {
        return new Response(JSON.stringify({ version: "" }), {
          status: 502,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
          }
        })
      }

      return new Response(JSON.stringify({ version: assets[platform]?.version || "" }), {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        }
      })
    }

    // ── /download/<platform> ─────────────────────────────────────────────────
    const dlMatch = pathname.match(/^\/download\/([a-z0-9-]+)$/)
    if (dlMatch) {
      const platform = dlMatch[1]
      if (!PLATFORM_PATTERNS[platform]) {
        return new Response(
          `Unknown platform "${platform}". Available: ${Object.keys(PLATFORM_PATTERNS).join(", ")}`,
          { status: 400 }
        )
      }

      let assets
      try {
        assets = await getLatestAssets(env)
      } catch (e) {
        return new Response(`Failed to fetch release info: ${e.message}`, { status: 502 })
      }

      const asset = assets[platform]
      if (!asset) {
        return new Response(`No asset found for "${platform}"`, { status: 404 })
      }

      const fileRes = await fetch(asset.url, {
        headers: { "User-Agent": "SinosCLI-Worker" }
      })
      if (!fileRes.ok) return new Response("Installer download unavailable; please retry later.", { status: 502 })
      return new Response(fileRes.body, {
        status: 200,
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="${asset.name}"`,
          "Content-Length": fileRes.headers.get("Content-Length") || "",
          "X-Sinos-Version": asset.version,
          "Cache-Control": "no-store",
        }
      })
    }

    // ── /lang-packs/<path> → 410 Gone ────────────────────────────────────────
    // Language pack infrastructure was retired. Intercept at the Worker so
    // edge-cached 200 responses from the pre-deletion era are replaced. The
    // 410 status tells HTTP clients the resource is permanently gone.
    if (pathname.startsWith("/lang-packs/")) {
      return new Response(
        "Sinos CLI language packs have been retired.\n" +
        "See Sinos 101 for installation and usage guides:\n" +
        "  /courses/claude-code\n",
        {
          status: 410,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-store",
          }
        }
      )
    }

    if (pathname === "/" && (request.method === "GET" || request.method === "HEAD")) {
      const ua = request.headers.get("User-Agent") || ""
      const lang = BOT_UA.test(ua)
        ? "en"
        : cookieLang(request.headers.get("Cookie")) || langFromAcceptLanguage(request.headers.get("Accept-Language"))
      if (lang !== "en") {
        return new Response(null, {
          status: 302,
          headers: {
            "Location": LANG_PATH[lang] + url.search,
            "Cache-Control": "private, no-store",
            "Vary": "Accept-Language, Cookie",
          },
        })
      }
      const res = await env.ASSETS.fetch(request)
      const out = new Response(res.body, res)
      out.headers.append("Vary", "Accept-Language, Cookie")
      return out
    }

    // ── everything else → CF Pages static files ──────────────────────────────
    return env.ASSETS.fetch(request)
  }
}
