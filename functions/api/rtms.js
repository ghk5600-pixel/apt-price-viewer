import {
  assertRequired,
  buildRtmsUrl,
  errorJson,
  fetchTextApi,
  getSearchParam,
  json,
  parseRtmsXml,
  requireServiceKey,
} from "../_shared/molit.js";

export async function onRequestGet({ request, env }) {
  try {
    const serviceKey = requireServiceKey(env);
    const lawdCd = getSearchParam(request, "lawdCd");
    const dealYmd = getSearchParam(request, "dealYmd");
    const pageNo = getSearchParam(request, "pageNo", "1");
    const numOfRows = getSearchParam(request, "numOfRows", "1000");
    assertRequired({ lawdCd, dealYmd });

    const xmlText = await fetchTextApi(buildRtmsUrl({ serviceKey, lawdCd, dealYmd, pageNo, numOfRows }));
    const resultCode = textFromXml(xmlText, "resultCode");
    const resultMsg = textFromXml(xmlText, "resultMsg");
    if (resultCode && resultCode !== "000") {
      return errorJson(resultMsg || `RTMS API error: ${resultCode}`, 502);
    }

    return json({ items: parseRtmsXml(xmlText) });
  } catch (error) {
    return errorJson(error.message || "RTMS request failed.", 500);
  }
}

function textFromXml(xmlText, tagName) {
  const match = xmlText.match(new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`));
  return match ? match[1].trim() : "";
}
