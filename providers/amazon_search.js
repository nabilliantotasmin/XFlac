const { request } = require('../lib/utils');

const CONFIG = {
  skillBaseURL: "https://na.mesk.skill.music.a2z.com/api",
  musicBaseURL: "https://music.amazon.com",
  deviceModel: "WEBPLAYER",
  deviceFamily: "WebPlayer",
  appVersion: "1.0.9678.0",
  maxResults: 8
};

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
];

function getRandomUA() { return USER_AGENTS[0]; }

let _session = {
  deviceId: null,
  sessionId: null,
  csrfToken: null,
  csrfTs: null,
  csrfRnd: null,
  initialized: false
};

async function initSession() {
  if (_session.initialized) return;
  try {
    const res = await request(CONFIG.musicBaseURL + '/config.json', {
      headers: { 'User-Agent': getRandomUA(), 'Accept': 'application/json' },
      timeout: 10000
    });
    if (res.statusCode === 200) {
      const config = JSON.parse(res.body);
      _session.deviceId = config.deviceId || '';
      _session.sessionId = config.sessionId || '';
      if (config.csrf) {
        _session.csrfToken = config.csrf.token || '';
        _session.csrfTs = config.csrf.ts || String(Math.floor(Date.now() / 1000));
        _session.csrfRnd = config.csrf.rnd || String(Math.floor(Math.random() * 2000000000));
      }
      _session.initialized = true;
      return;
    }
  } catch (e) {}

  // Fallback if config.json fails
  _session.deviceId = String(Math.floor(Math.random() * 99999999999999999));
  _session.sessionId = '123-1234567-1234567';
  _session.csrfToken = '';
  _session.csrfTs = String(Math.floor(Date.now() / 1000));
  _session.csrfRnd = String(Math.floor(Math.random() * 2000000000));
  _session.initialized = true;
}

function buildHeaders(pageUrl) {
  const csrf = JSON.stringify({
    "interface": "CSRFInterface.v1_0.CSRFHeaderElement",
    "token": _session.csrfToken || '',
    "timestamp": _session.csrfTs,
    "rndNonce": _session.csrfRnd
  });
  const auth = JSON.stringify({
    "interface": "ClientAuthenticationInterface.v1_0.ClientTokenElement",
    "accessToken": ""
  });
  return JSON.stringify({
    "x-amzn-authentication": auth,
    "x-amzn-device-model": CONFIG.deviceModel,
    "x-amzn-device-width": "1920",
    "x-amzn-device-family": CONFIG.deviceFamily,
    "x-amzn-device-id": _session.deviceId,
    "x-amzn-user-agent": getRandomUA(),
    "x-amzn-session-id": _session.sessionId,
    "x-amzn-device-height": "1080",
    "x-amzn-request-id": Math.random().toString(36).substring(2) + "-" + Date.now(),
    "x-amzn-device-language": "en_US",
    "x-amzn-currency-of-preference": "USD",
    "x-amzn-os-version": "1.0",
    "x-amzn-application-version": CONFIG.appVersion,
    "x-amzn-device-time-zone": "UTC",
    "x-amzn-timestamp": String(Date.now()),
    "x-amzn-csrf": csrf,
    "x-amzn-music-domain": "music.amazon.com",
    "x-amzn-referer": "",
    "x-amzn-affiliate-tags": "",
    "x-amzn-ref-marker": "",
    "x-amzn-page-url": pageUrl,
    "x-amzn-weblab-id-overrides": "",
    "x-amzn-video-player-token": "",
    "x-amzn-feature-flags": "",
    "x-amzn-has-profile-id": "",
    "x-amzn-age-band": ""
  });
}

function extractAmazonDeeplinkInfo(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/^\/|\/$/g, "");
    const segments = path.split("/");
    if (segments.length < 2) return null;
    const kind = segments[0].toLowerCase();
    const id = segments[1];
    
    // Attempt ASIN extraction
    let match = url.match(/B[0-9A-Z]{9}/);
    let resolvedId = match ? match[0] : id;

    if (kind === "tracks" || kind === "track") {
      return { type: "track", id: resolvedId };
    }
    return null;
  } catch(e) {
    let match = url.match(/B[0-9A-Z]{9}/);
    if (match) return { type: "track", id: match[0] };
    return null;
  }
}

function textValue(obj) {
  if (!obj) return "";
  if (typeof obj === "string") return obj;
  if (obj.text) return obj.text;
  if (obj.fallback) return obj.fallback;
  if (obj.templateInfo && obj.templateInfo.defaultText) return obj.templateInfo.defaultText;
  return "";
}

function parseDurationMMSS(str) {
  if (!str) return 0;
  const s = textValue(str).trim();
  const parts = s.split(':');
  if (parts.length === 2) {
    return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
  }
  if (parts.length === 3) {
    return parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + parseInt(parts[2], 10);
  }
  return 0;
}

function findAllByInterface(obj, targetInterface, results, depth) {
  if (!obj || depth > 20) return;
  if (!results) results = [];
  if (!depth) depth = 0;
  if (typeof obj !== "object") return results;
  if (obj["interface"] === targetInterface) results.push(obj);
  for (const key in obj) {
    if (typeof obj[key] === "object" && obj[key] !== null) {
      findAllByInterface(obj[key], targetInterface, results, depth + 1);
    }
  }
  return results;
}

function ensureHighResCoverUrl(url) {
  if (!url) return "";
  return url.replace(/_.[A-Za-z0-9_,-]*_\./, "_UW1000_.");
}

async function search(keyword, limit = 8) {
  await initSession();
  const pageUrl = CONFIG.musicBaseURL + "/search/" + encodeURIComponent(keyword);
  
  const body = JSON.stringify({
    filter: JSON.stringify({ "IsLibrary": ["false"] }),
    keyword: JSON.stringify({
      "interface": "Web.TemplatesInterface.v1_0.Touch.SearchTemplateInterface.SearchKeywordClientInformation",
      "keyword": keyword
    }),
    suggestedKeyword: keyword,
    userHash: JSON.stringify({ "level": "LIBRARY_MEMBER" }),
    headers: buildHeaders(pageUrl)
  });

  const res = await fetch(CONFIG.skillBaseURL + "/showSearch", {
    method: "POST",
    headers: {
      "Content-Type": "text/plain;charset=UTF-8",
      "User-Agent": getRandomUA(),
      "Origin": CONFIG.musicBaseURL,
      "Referer": pageUrl
    },
    body: body
  });

  if (!res.ok) {
    if (res.status === 429) {
      _session.initialized = false;
      throw new Error('Amazon search rate limited, please try again later');
    }
    const errText = await res.text();
    throw new Error('Amazon search returned ' + res.status + ': ' + errText.substring(0, 500));
  }

  const data = await res.json();
  const shovelers = findAllByInterface(data, "Web.TemplatesInterface.v1_0.Touch.WidgetsInterface.VisualShovelerWidgetElement", [], 0);
  const featured = findAllByInterface(data, "Web.TemplatesInterface.v1_0.Touch.WidgetsInterface.FeaturedShovelerWidgetElement", [], 0);
  const descriptive = findAllByInterface(data, "Web.TemplatesInterface.v1_0.Touch.WidgetsInterface.DescriptiveShowcaseWidgetElement", [], 0);
  
  shovelers.push(...featured, ...descriptive);
  
  const results = [];
  
  for (const shoveler of shovelers) {
    if (!shoveler.items) continue;
    
    // Check if shoveler header contains "Songs" or "Top Result"
    const shovelerStr = JSON.stringify(shoveler);
    if (!shovelerStr.includes('"Songs"') && !shovelerStr.includes('"Top Result"')) continue;
    
    for (const item of shoveler.items) {
      if (results.length >= limit) break;
      const iface = item["interface"] || "";
      
      if (iface.includes("DescriptiveRowItemElement") || iface.includes("SquareHorizontalItemElement")) {
        let trackName = textValue(item.primaryText);
        let trackDeeplink = "";
        let trackDuration = 0;
        let trackArtist = "";
        let trackImage = "";

        if (item.primaryTextLink && item.primaryTextLink.deeplink) trackDeeplink = item.primaryTextLink.deeplink;
        if (!trackDeeplink && item.primaryLink && item.primaryLink.deeplink) trackDeeplink = item.primaryLink.deeplink;
        
        if (item.secondaryText3) trackDuration = parseDurationMMSS(item.secondaryText3);
        if (!trackDuration && item.duration) trackDuration = parseDurationMMSS(item.duration);
        
        if (item.secondaryText1) trackArtist = textValue(item.secondaryText1);
        if (!trackArtist) trackArtist = textValue(item.secondaryText);
        
        if (item.image) trackImage = ensureHighResCoverUrl(item.image);

        const trackInfo = extractAmazonDeeplinkInfo(trackDeeplink);
        const tId = trackInfo ? trackInfo.id : null;
        
        if (trackName && tId && trackInfo.type === "track") {
          // Avoid duplicates
          if (!results.find(r => r.id === tId)) {
            results.push({
              id: tId,
              title: trackName,
              artist: trackArtist,
              album: "",
              cover: trackImage,
              duration: trackDuration * 1000,
              isrc: ""
            });
          }
        }
      }
    }
  }
  
  return results;
}

module.exports = { search };
