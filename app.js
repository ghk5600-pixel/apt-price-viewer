const REFERENCE_MONTH = "2026-07";
const FAVORITES_KEY = "apt-monitor-favorites-v1";
const CUSTOM_COMPLEXES_KEY = "apt-monitor-custom-complexes-v1";
const API_CONFIG_KEY = "apt-monitor-api-config-v1";
const RTMS_API_ENDPOINT = "https://apis.data.go.kr/1613000/RTMSDataSvcAptTrade";
const RTMS_API_OPERATION = "getRTMSDataSvcAptTrade";
const APT_LIST_API_ENDPOINT = "https://apis.data.go.kr/1613000/AptListService3";
const APT_LIST_LEGALDONG_OPERATION = "getLegaldongAptList3";
const APT_BASIS_API_ENDPOINT = "https://apis.data.go.kr/1613000/AptBasisInfoServiceV4";
const APT_BASIS_BASIC_OPERATION = "getAphusBassInfoV4";
const APT_BASIS_DETAIL_OPERATION = "getAphusDtlInfoV4";
const BUILDING_HUB_API_ENDPOINT = "https://apis.data.go.kr/1613000/BldRgstHubService";
const BUILDING_HUB_OPERATIONS = ["getBrRecapTitleInfo", "getBrTitleInfo"];
const KAKAO_SDK_SRC = "https://dapi.kakao.com/v2/maps/sdk.js";
const DEFAULT_KAKAO_JAVASCRIPT_KEY = "f1381fcba950abff23056942bd19d544";

const AREA_GROUPS = [
  { id: "59", label: "59타입", min: 55, max: 65, target: 59 },
  { id: "74", label: "74타입", min: 70, max: 80, target: 74 },
  { id: "84", label: "84타입", min: 80, max: 90, target: 84 },
  { id: "101", label: "101타입", min: 95, max: 110, target: 101 },
  { id: "114", label: "114타입", min: 110, max: 125, target: 114 },
];

const RANGE_OPTIONS = [
  { id: "24", label: "최근 24개월", months: 24 },
  { id: "18", label: "최근 18개월", months: 18 },
  { id: "12", label: "최근 12개월", months: 12 },
  { id: "6", label: "최근 6개월", months: 6 },
];

const DEFAULT_MAP_CENTER = { lat: 37.5665, lng: 126.978 };

const COMPLEXES = [];

loadCustomComplexes().forEach((complex) => COMPLEXES.push(complex));

const state = {
  query: "",
  favorites: loadFavorites(),
  selectedComplexId: null,
  selectedAreaGroupId: "84",
  selectedMonthRange: "24",
  includeLowFloorsInAnalysis: false,
  apiConfig: loadApiConfig(),
  kakaoMap: null,
  kakaoMarkers: [],
  kakaoInfoWindow: null,
  kakaoPlacesService: null,
  kakaoSearchResults: [],
  kakaoSearchStatus: "idle",
  aptListSearchResults: [],
  aptListSearchStatus: "idle",
  aptListSearchRegionName: "",
  aptListSearchMessage: "",
  kakaoSdkStatus: "idle",
  searchDebounceId: null,
  searchRequestId: 0,
};

const el = {
  resultList: document.querySelector("#resultList"),
  favoriteList: document.querySelector("#favoriteList"),
  favoriteCount: document.querySelector("#favoriteCount"),
  complexSearch: document.querySelector("#complexSearch"),
  clearFavoritesButton: document.querySelector("#clearFavoritesButton"),
  mapCanvas: document.querySelector("#mapCanvas"),
  kakaoMap: document.querySelector("#kakaoMap"),
  mapCaptionTitle: document.querySelector("#mapCaptionTitle"),
  mapCaptionText: document.querySelector("#mapCaptionText"),
  selectedDong: document.querySelector("#selectedDong"),
  detailTitle: document.querySelector("#detailTitle"),
  selectedAddress: document.querySelector("#selectedAddress"),
  metaGrid: document.querySelector("#metaGrid"),
  areaTabs: document.querySelector("#areaTabs"),
  globalAreaTabs: document.querySelector("#globalAreaTabs"),
  metricGrid: document.querySelector("#metricGrid"),
  includeLowFloorToggle: document.querySelector("#includeLowFloorToggle"),
  periodAnalysisWrap: document.querySelector("#periodAnalysisWrap"),
  chartWrap: document.querySelector("#chartWrap"),
  chartSubtitle: document.querySelector("#chartSubtitle"),
  transactionList: document.querySelector("#transactionList"),
  transactionSubtitle: document.querySelector("#transactionSubtitle"),
  comparisonTable: document.querySelector("#comparisonTable"),
  rangeSelect: document.querySelector("#rangeSelect"),
  headerAreaSelect: document.querySelector("#headerAreaSelect"),
  chartTitle: document.querySelector("#chartTitle"),
  apiKeyStatus: document.querySelector("#apiKeyStatus"),
  openSettingsButton: document.querySelector("#openSettingsButton"),
  settingsModal: document.querySelector("#settingsModal"),
  closeSettingsButton: document.querySelector("#closeSettingsButton"),
  settingsForm: document.querySelector("#settingsForm"),
  serviceKeyInput: document.querySelector("#serviceKeyInput"),
  kakaoJavaScriptKeyInput: document.querySelector("#kakaoJavaScriptKeyInput"),
  showServiceKeyInput: document.querySelector("#showServiceKeyInput"),
  clearApiKeyButton: document.querySelector("#clearApiKeyButton"),
};

const transactionsByComplex = Object.fromEntries(
  COMPLEXES.map((complex) => [
    complex.id,
    Array.isArray(complex.realTransactions) ? complex.realTransactions : buildTransactions(complex),
  ])
);

initialize();

function initialize() {
  const savedFavoriteCount = state.favorites.length;
  const knownComplexIds = new Set(COMPLEXES.map((complex) => complex.id));
  state.favorites = state.favorites.filter((id) => knownComplexIds.has(id));
  if (state.favorites.length !== savedFavoriteCount) {
    saveFavorites();
  }

  state.selectedComplexId = state.favorites[0] || null;
  ensureValidAreaGroup();
  fillHeaderControls();
  bindEvents();
  render();
}

function bindEvents() {
  el.complexSearch.addEventListener("input", (event) => {
    state.query = event.target.value.trim();
    renderResults();
    queueKakaoPlaceSearch();
  });

  el.clearFavoritesButton.addEventListener("click", () => {
    state.favorites = [];
    state.selectedComplexId = null;
    ensureValidAreaGroup();
    saveFavorites();
    render();
  });

  el.rangeSelect.addEventListener("change", () => {
    state.selectedMonthRange = el.rangeSelect.value;
    render();
  });

  el.headerAreaSelect.addEventListener("change", () => {
    state.selectedAreaGroupId = el.headerAreaSelect.value;
    render();
  });

  el.includeLowFloorToggle.addEventListener("change", () => {
    state.includeLowFloorsInAnalysis = el.includeLowFloorToggle.checked;
    renderDetail();
  });

  el.openSettingsButton.addEventListener("click", openSettings);
  el.closeSettingsButton.addEventListener("click", closeSettings);
  el.settingsModal.addEventListener("click", (event) => {
    if (event.target === el.settingsModal) closeSettings();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && el.settingsModal.classList.contains("open")) {
      closeSettings();
    }
  });

  el.showServiceKeyInput.addEventListener("change", () => {
    const type = el.showServiceKeyInput.checked ? "text" : "password";
    el.serviceKeyInput.type = type;
    el.kakaoJavaScriptKeyInput.type = type;
  });

  el.settingsForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const serviceKey = el.serviceKeyInput.value.trim();
    const kakaoJavaScriptKey = el.kakaoJavaScriptKeyInput.value.trim();
    state.apiConfig = {
      endpoint: RTMS_API_ENDPOINT,
      serviceKey,
      kakaoJavaScriptKey,
    };
    saveApiConfig();
    renderApiKeyStatus();
    initializeKakaoMap(true);
    closeSettings();
  });

  el.clearApiKeyButton.addEventListener("click", () => {
    state.apiConfig = {
      endpoint: RTMS_API_ENDPOINT,
      serviceKey: "",
      kakaoJavaScriptKey: "",
    };
    saveApiConfig();
    renderApiKeyStatus();
    resetKakaoMap();
    fillSettingsForm();
  });
}

function render() {
  renderHeaderControls();
  renderResults();
  renderFavorites();
  renderMap();
  renderGlobalAreaTabs();
  renderDetail();
  renderComparison();
  renderApiKeyStatus();
  initializeKakaoMap();
}

function fillHeaderControls() {
  el.rangeSelect.innerHTML = RANGE_OPTIONS.map(
    (option) => `<option value="${option.id}">${option.label}</option>`
  ).join("");
  el.headerAreaSelect.innerHTML = AREA_GROUPS.map(
    (group) => `<option value="${group.id}">${group.label}</option>`
  ).join("");
}

function renderHeaderControls() {
  if (el.rangeSelect.value !== state.selectedMonthRange) {
    el.rangeSelect.value = state.selectedMonthRange;
  }
  if (el.headerAreaSelect.value !== state.selectedAreaGroupId) {
    el.headerAreaSelect.value = state.selectedAreaGroupId;
  }
}

function openSettings() {
  fillSettingsForm();
  el.settingsModal.classList.add("open");
  el.settingsModal.setAttribute("aria-hidden", "false");
  window.setTimeout(() => el.kakaoJavaScriptKeyInput.focus(), 0);
}

function closeSettings() {
  el.settingsModal.classList.remove("open");
  el.settingsModal.setAttribute("aria-hidden", "true");
  el.showServiceKeyInput.checked = false;
  el.serviceKeyInput.type = "password";
  el.kakaoJavaScriptKeyInput.type = "password";
}

function fillSettingsForm() {
  el.serviceKeyInput.value = state.apiConfig.serviceKey || "";
  el.kakaoJavaScriptKeyInput.value = state.apiConfig.kakaoJavaScriptKey || "";
  const type = el.showServiceKeyInput.checked ? "text" : "password";
  el.serviceKeyInput.type = type;
  el.kakaoJavaScriptKeyInput.type = type;
}

function renderApiKeyStatus() {
  const serviceKey = state.apiConfig.serviceKey || "";
  const kakaoJavaScriptKey = state.apiConfig.kakaoJavaScriptKey || "";
  el.apiKeyStatus.textContent = "";
  const molitKeyStatus = shouldUseBackendApi()
    ? "서버 보관"
    : serviceKey
      ? `끝자리 ${maskTail(serviceKey)}`
      : "미설정";
  el.openSettingsButton.setAttribute(
    "aria-label",
    `API 키 설정, 국토부 ${molitKeyStatus}, 카카오맵 ${
      kakaoJavaScriptKey ? `끝자리 ${maskTail(kakaoJavaScriptKey)}` : "미설정"
    }`
  );
}

function getRtmsApiConfig() {
  return {
    endpoint: normalizeRtmsEndpoint(state.apiConfig.endpoint || RTMS_API_ENDPOINT),
    serviceKey: state.apiConfig.serviceKey || "",
  };
}

function shouldUseBackendApi() {
  const host = window.location.hostname;
  if (window.location.search.includes("apiProxy=1")) return true;
  if (window.location.search.includes("directApi=1")) return false;
  return Boolean(host && !["localhost", "127.0.0.1", "::1"].includes(host));
}

function hasMolitApiAccess() {
  return shouldUseBackendApi() || Boolean(getRtmsApiConfig().serviceKey);
}

function normalizeRtmsEndpoint(endpoint) {
  const cleanEndpoint = endpoint.replace(/\/$/, "");
  return cleanEndpoint.endsWith(`/${RTMS_API_OPERATION}`)
    ? cleanEndpoint
    : `${cleanEndpoint}/${RTMS_API_OPERATION}`;
}

function buildRtmsApiUrl({ lawdCd, dealYmd, pageNo = 1, numOfRows = 1000 }) {
  const { endpoint, serviceKey } = getRtmsApiConfig();
  const url = new URL(endpoint);
  url.searchParams.set("serviceKey", serviceKey);
  url.searchParams.set("LAWD_CD", lawdCd);
  url.searchParams.set("DEAL_YMD", dealYmd);
  url.searchParams.set("pageNo", String(pageNo));
  url.searchParams.set("numOfRows", String(numOfRows));
  return url.toString();
}

function initializeKakaoMap(forceReload = false) {
  const { kakaoJavaScriptKey } = getKakaoMapConfig();

  if (!kakaoJavaScriptKey) {
    setMapFallbackStatus("카카오맵 키 미설정", "API 설정에서 JavaScript 키를 저장하면 실제 지도로 전환됩니다.");
    return;
  }

  if (window.location.protocol === "file:") {
    setMapFallbackStatus("localhost 실행 필요", "카카오맵은 file://가 아니라 http://localhost:8080에서 열어야 합니다.");
    return;
  }

  if (forceReload) {
    resetKakaoMap({ keepStatus: true });
  }

  if (state.kakaoMap && window.kakao?.maps) {
    syncKakaoMap();
    return;
  }

  if (window.kakao?.maps) {
    createKakaoMap();
    return;
  }

  if (state.kakaoSdkStatus === "loading") return;

  state.kakaoSdkStatus = "loading";
  el.mapCaptionTitle.textContent = "카카오맵 불러오는 중";
  el.mapCaptionText.textContent = "카카오맵 JavaScript SDK를 연결하고 있습니다.";

  document.querySelectorAll("script[data-kakao-map-sdk]").forEach((script) => script.remove());

  const script = document.createElement("script");
  script.dataset.kakaoMapSdk = "true";
  script.async = true;
  script.src = `${KAKAO_SDK_SRC}?appkey=${encodeURIComponent(kakaoJavaScriptKey)}&libraries=services&autoload=false`;
  script.onload = () => {
    if (!window.kakao?.maps?.load) {
      state.kakaoSdkStatus = "error";
      setMapFallbackStatus("SDK 로드 실패", "카카오맵 SDK는 불러왔지만 maps 객체를 찾지 못했습니다.");
      return;
    }

    window.kakao.maps.load(() => {
      state.kakaoSdkStatus = "loaded";
      createKakaoMap();
    });
  };
  script.onerror = () => {
    state.kakaoSdkStatus = "error";
    setMapFallbackStatus("SDK 로드 실패", "카카오맵 사용 설정, JavaScript SDK 도메인, 키 값을 다시 확인해주세요.");
  };

  document.head.appendChild(script);
}

function createKakaoMap() {
  const selected = getSelectedComplex();
  const center = new window.kakao.maps.LatLng(
    selected?.lat ?? DEFAULT_MAP_CENTER.lat,
    selected?.lng ?? DEFAULT_MAP_CENTER.lng
  );
  state.kakaoMap = new window.kakao.maps.Map(el.kakaoMap, {
    center,
    level: 7,
  });
  state.kakaoInfoWindow = new window.kakao.maps.InfoWindow({ zIndex: 3 });
  state.kakaoPlacesService = window.kakao.maps.services
    ? new window.kakao.maps.services.Places()
    : null;
  el.mapCanvas.classList.add("kakao-ready");
  el.mapCaptionTitle.textContent = "실제 카카오맵";
  el.mapCaptionText.textContent = "마커를 클릭하면 해당 단지 상세로 이동합니다.";
  window.setTimeout(() => {
    state.kakaoMap.relayout();
    syncKakaoMap();
    if (state.query) queueKakaoPlaceSearch(true);
    refreshPendingFavoriteTrades();
  }, 0);
}

function syncKakaoMap() {
  if (!state.kakaoMap || !window.kakao?.maps) return;

  state.kakaoMarkers.forEach((marker) => marker.setMap(null));
  const favoriteComplexes = getFavoriteComplexes();
  state.kakaoMarkers = favoriteComplexes.map((complex) => {
    const marker = new window.kakao.maps.Marker({
      map: state.kakaoMap,
      position: new window.kakao.maps.LatLng(complex.lat, complex.lng),
      title: complex.name,
    });
    window.kakao.maps.event.addListener(marker, "click", () => selectComplex(complex.id));
    return marker;
  });

  const selected = getSelectedComplex();
  if (!selected) {
    state.kakaoMap.setCenter(new window.kakao.maps.LatLng(DEFAULT_MAP_CENTER.lat, DEFAULT_MAP_CENTER.lng));
    if (state.kakaoInfoWindow) state.kakaoInfoWindow.close();
    return;
  }

  const selectedPosition = new window.kakao.maps.LatLng(selected.lat, selected.lng);
  state.kakaoMap.setCenter(selectedPosition);
  state.kakaoInfoWindow.setContent(`
    <div style="min-width:180px;padding:12px 14px;color:#0f172a;font-family:Inter,'Noto Sans KR',sans-serif;">
      <strong style="display:block;margin-bottom:4px;font-size:14px;">${selected.name}</strong>
      <span style="display:block;color:#64748b;font-size:12px;">${selected.dong} · ${formatHouseholdsAndBuildings(selected)}</span>
    </div>
  `);
  const selectedMarker = state.kakaoMarkers[favoriteComplexes.findIndex((complex) => complex.id === selected.id)];
  if (selectedMarker) {
    state.kakaoInfoWindow.open(state.kakaoMap, selectedMarker);
  } else if (state.kakaoInfoWindow) {
    state.kakaoInfoWindow.close();
  }
}

function resetKakaoMap(options = {}) {
  state.kakaoMarkers.forEach((marker) => marker.setMap(null));
  state.kakaoMarkers = [];
  if (state.kakaoInfoWindow) state.kakaoInfoWindow.close();
  state.kakaoInfoWindow = null;
  state.kakaoPlacesService = null;
  state.kakaoSearchResults = [];
  state.kakaoSearchStatus = "idle";
  state.kakaoMap = null;
  state.kakaoSdkStatus = "idle";
  el.mapCanvas.classList.remove("kakao-ready");
  if (!options.keepStatus) {
    setMapFallbackStatus("카카오맵 연결 대기", "API 설정에 JavaScript 키를 저장하고 localhost에서 열면 실제 지도로 전환됩니다.");
  }
}

function setMapFallbackStatus(title, text) {
  el.mapCanvas.classList.remove("kakao-ready");
  el.mapCaptionTitle.textContent = title;
  el.mapCaptionText.textContent = text;
}

function getKakaoMapConfig() {
  return {
    kakaoJavaScriptKey: state.apiConfig.kakaoJavaScriptKey || "",
  };
}

function queueKakaoPlaceSearch(immediate = false) {
  window.clearTimeout(state.searchDebounceId);
  const keyword = state.query.trim();

  if (keyword.length < 2) {
    state.kakaoSearchResults = [];
    state.kakaoSearchStatus = "idle";
    state.aptListSearchResults = [];
    state.aptListSearchStatus = "idle";
    state.aptListSearchRegionName = "";
    state.aptListSearchMessage = "";
    renderResults();
    return;
  }

  if (!state.kakaoPlacesService || !window.kakao?.maps?.services) {
    state.kakaoSearchResults = [];
    state.kakaoSearchStatus = "ready-waiting";
    state.aptListSearchResults = [];
    state.aptListSearchStatus = "ready-waiting";
    state.aptListSearchRegionName = "";
    state.aptListSearchMessage = "카카오맵이 연결되면 동 이름을 법정동코드로 바꿔 국토부 단지목록을 조회합니다.";
    renderResults();
    return;
  }

  const requestId = state.searchRequestId + 1;
  state.searchRequestId = requestId;
  state.kakaoSearchStatus = "loading";
  state.aptListSearchResults = [];
  state.aptListSearchStatus = hasMolitApiAccess() ? "loading" : "key-missing";
  state.aptListSearchRegionName = "";
  state.aptListSearchMessage = hasMolitApiAccess()
    ? "동 이름을 법정동코드로 확인하고 있습니다."
    : "국토부 인증키가 필요합니다.";
  renderResults();
  state.searchDebounceId = window.setTimeout(() => performApartmentSearch(requestId), immediate ? 0 : 450);
}

async function performApartmentSearch(requestId = state.searchRequestId) {
  const rawKeyword = state.query.trim();
  if (!rawKeyword || !state.kakaoPlacesService) return;

  const keyword = rawKeyword.includes("아파트") ? rawKeyword : `${rawKeyword} 아파트`;
  try {
    const placeData = await kakaoKeywordSearch(keyword, { size: 10 });
    if (requestId !== state.searchRequestId) return;
    state.kakaoSearchResults = placeData.filter((place) => place.x && place.y).slice(0, 6);
    state.kakaoSearchStatus = "done";
    renderResults();

    if (state.aptListSearchStatus === "loading") {
      await performAptListSearch(rawKeyword, placeData, requestId);
    }
  } catch (error) {
    if (requestId !== state.searchRequestId) return;
    state.kakaoSearchResults = [];
    state.kakaoSearchStatus = "error";
    if (state.aptListSearchStatus === "loading") {
      await performAptListSearch(rawKeyword, [], requestId);
    }
    renderResults();
  }
}

async function performAptListSearch(rawKeyword, placeData, requestId) {
  try {
    const region = await resolveLegalDongFromSearch(rawKeyword, placeData);
    if (requestId !== state.searchRequestId) return;

    if (!region?.bjdCode) {
      state.aptListSearchResults = [];
      state.aptListSearchStatus = "no-region";
      state.aptListSearchRegionName = "";
      state.aptListSearchMessage = "동 이름이나 주소를 법정동으로 확인하지 못했습니다.";
      renderResults();
      return;
    }

    state.aptListSearchRegionName = region.name;
    state.aptListSearchMessage = `${region.name} 공동주택 단지목록을 조회하고 있습니다.`;
    renderResults();

    const candidates = await fetchAptListByLegalDong(region.bjdCode);
    if (requestId !== state.searchRequestId) return;

    const ranked = candidates
      .map((candidate) => ({
        ...candidate,
        searchScore: scoreAptListSearchCandidate(rawKeyword, candidate),
      }))
      .sort((a, b) => b.searchScore - a.searchScore || normalize(a.kaptName).localeCompare(normalize(b.kaptName), "ko"));

    const visible = ranked.slice(0, 60).map((candidate) => buildAptListSearchResult(candidate, region));
    const enriched = await enrichAptListSearchResultLocations(visible.slice(0, 12), region);
    const enrichedByCode = new Map(enriched.map((item) => [item.searchId, item]));
    state.aptListSearchResults = visible.map((item) => enrichedByCode.get(item.searchId) || item);
    state.aptListSearchStatus = "done";
    state.aptListSearchMessage = `${region.name}에서 ${state.aptListSearchResults.length}개 단지를 찾았습니다.`;
    renderResults();
  } catch (error) {
    if (requestId !== state.searchRequestId) return;
    state.aptListSearchResults = [];
    state.aptListSearchStatus = "error";
    state.aptListSearchMessage = error.message || "국토부 단지목록 조회에 실패했습니다.";
    renderResults();
  }
}

function kakaoKeywordSearch(keyword, options = {}) {
  return new Promise((resolve, reject) => {
    if (!state.kakaoPlacesService || !window.kakao?.maps?.services) {
      reject(new Error("카카오 장소검색을 사용할 수 없습니다."));
      return;
    }

    state.kakaoPlacesService.keywordSearch(
      keyword,
      (data, status) => {
        if (status === window.kakao.maps.services.Status.OK) {
          resolve(data || []);
        } else if (status === window.kakao.maps.services.Status.ZERO_RESULT) {
          resolve([]);
        } else {
          reject(new Error("카카오 장소검색에 실패했습니다."));
        }
      },
      options
    );
  });
}

function kakaoAddressSearch(keyword) {
  return new Promise((resolve) => {
    if (!window.kakao?.maps?.services) {
      resolve([]);
      return;
    }
    const geocoder = new window.kakao.maps.services.Geocoder();
    geocoder.addressSearch(keyword, (data, status) => {
      resolve(status === window.kakao.maps.services.Status.OK ? data || [] : []);
    });
  });
}

function kakaoCoordToLegalRegion(lng, lat) {
  return new Promise((resolve) => {
    if (!window.kakao?.maps?.services || !lng || !lat) {
      resolve(null);
      return;
    }
    const geocoder = new window.kakao.maps.services.Geocoder();
    geocoder.coord2RegionCode(Number(lng), Number(lat), (regions, status) => {
      if (status !== window.kakao.maps.services.Status.OK) {
        resolve(null);
        return;
      }
      resolve(regions.find((region) => region.region_type === "B") || regions[0] || null);
    });
  });
}

async function resolveLegalDongFromSearch(rawKeyword, placeData = []) {
  const addressResults = await kakaoAddressSearch(rawKeyword);
  const regionAddress = addressResults.find((item) => item.address?.b_code);
  if (regionAddress?.address?.b_code) {
    return buildSearchRegionFromKakaoAddress(regionAddress);
  }

  const firstPlace = placeData.find((place) => place.x && place.y);
  if (firstPlace) {
    const region = await kakaoCoordToLegalRegion(firstPlace.x, firstPlace.y);
    if (region?.code) {
      return buildSearchRegionFromKakaoRegion(region, firstPlace);
    }
  }

  return null;
}

function buildSearchRegionFromKakaoAddress(item) {
  const address = item.address || {};
  const bjdCode = String(address.b_code || "");
  const parts = [
    address.region_1depth_name,
    address.region_2depth_name,
    address.region_3depth_name,
    address.region_3depth_h_name,
  ].filter(Boolean);
  return {
    bjdCode,
    name: parts.join(" "),
    city: parts.slice(0, 2).join(" "),
    dong: address.region_3depth_name || address.region_3depth_h_name || "",
    lat: Number(item.y) || DEFAULT_MAP_CENTER.lat,
    lng: Number(item.x) || DEFAULT_MAP_CENTER.lng,
  };
}

function buildSearchRegionFromKakaoRegion(region, place) {
  const parts = [region.region_1depth_name, region.region_2depth_name, region.region_3depth_name].filter(Boolean);
  return {
    bjdCode: String(region.code || ""),
    name: parts.join(" "),
    city: parts.slice(0, 2).join(" "),
    dong: region.region_3depth_name || "",
    lat: Number(place.y) || DEFAULT_MAP_CENTER.lat,
    lng: Number(place.x) || DEFAULT_MAP_CENTER.lng,
  };
}

function buildAptListSearchResult(candidate, region) {
  const searchId = `aptlist-${candidate.kaptCode || hashString(`${candidate.kaptName}-${candidate.bjdCode}`)}`;
  const dong = candidate.as3 || candidate.as4 || region.dong || "";
  const city = [candidate.as1, candidate.as2].filter(Boolean).join(" ") || region.city || "";
  const address = [candidate.as1, candidate.as2, candidate.as3, candidate.as4].filter(Boolean).join(" ") || region.name;
  return {
    ...candidate,
    searchId,
    name: candidate.kaptName,
    city,
    dong,
    address,
    lat: region.lat,
    lng: region.lng,
    coordinateSource: "region",
    coordinateLabel: "동 중심 좌표",
  };
}

async function enrichAptListSearchResultLocations(items, region) {
  const settled = await Promise.all(
    items.map((item) =>
      findKakaoPlaceForAptCandidate(item, region)
        .then((place) => (place ? mergeAptListSearchResultPlace(item, place) : item))
        .catch(() => item)
    )
  );
  return settled;
}

async function findKakaoPlaceForAptCandidate(candidate, region) {
  const keywords = [
    `${candidate.city} ${candidate.dong} ${candidate.kaptName}`,
    `${candidate.dong} ${candidate.kaptName}`,
    candidate.kaptName,
  ].filter(Boolean);

  for (const keyword of keywords) {
    const places = await kakaoKeywordSearch(keyword, { size: 5 });
    const scored = places
      .filter((place) => place.x && place.y)
      .map((place) => ({
        place,
        score: scoreKakaoPlaceForAptCandidate(candidate, place),
      }))
      .sort((a, b) => b.score - a.score);
    if (scored[0]?.score >= 0.45) return scored[0].place;
  }
  return null;
}

function mergeAptListSearchResultPlace(candidate, place) {
  const address = place.road_address_name || place.address_name || candidate.address;
  return {
    ...candidate,
    kakaoPlaceId: place.id || "",
    kakaoPlaceName: place.place_name || "",
    address,
    jibunAddress: place.address_name || candidate.jibunAddress || "",
    lat: Number(place.y) || candidate.lat,
    lng: Number(place.x) || candidate.lng,
    lotNumber: parseLotNumber(place.address_name || address),
    coordinateSource: "kakao",
    coordinateLabel: "좌표 확보",
  };
}

function scoreKakaoPlaceForAptCandidate(candidate, place) {
  const nameScore = stringSimilarity(normalizeApartmentName(candidate.kaptName), normalizeApartmentName(place.place_name || ""));
  const addressText = normalize([place.road_address_name, place.address_name].join(" "));
  const dongScore = candidate.dong && addressText.includes(normalize(candidate.dong)) ? 0.2 : 0;
  return nameScore + dongScore;
}

function scoreAptListSearchCandidate(rawKeyword, candidate) {
  const query = normalizeApartmentName(rawKeyword);
  const name = normalizeApartmentName(candidate.kaptName);
  const address = normalize([candidate.as1, candidate.as2, candidate.as3, candidate.as4].join(" "));
  if (!query) return 0;
  if (name.includes(query)) return 1;
  if (address.includes(normalize(rawKeyword))) return 0.7;
  return stringSimilarity(query, name) * 0.8;
}

function toggleKakaoPlaceFavorite(placeId) {
  const place = state.kakaoSearchResults.find((item) => item.id === placeId);
  if (!place) return;

  const existing = findRegisteredPlace(place);
  const complex = existing || createComplexFromKakaoPlace(place);

  if (!existing) {
    COMPLEXES.push(complex);
    transactionsByComplex[complex.id] = buildTransactions(complex);
    saveCustomComplexes();
  }

  if (state.favorites.includes(complex.id)) {
    toggleFavorite(complex.id);
    return;
  }

  state.favorites = [...state.favorites, complex.id];
  state.selectedComplexId = complex.id;
  saveFavorites();
  ensureValidAreaGroup();
  render();
  refreshRealTransactionsForComplex(complex.id);
}

async function toggleAptListFavorite(searchId) {
  const candidate = state.aptListSearchResults.find((item) => item.searchId === searchId);
  if (!candidate) return;

  const existing = findRegisteredAptListCandidate(candidate);
  let enrichedCandidate = candidate;
  if (!existing && candidate.coordinateSource !== "kakao") {
    try {
      const place = await findKakaoPlaceForAptCandidate(candidate, null);
      if (place) {
        enrichedCandidate = mergeAptListSearchResultPlace(candidate, place);
        Object.assign(candidate, enrichedCandidate);
      }
    } catch {
      enrichedCandidate = candidate;
    }
  }

  const complex = existing || createComplexFromAptListCandidate(enrichedCandidate);

  if (!existing) {
    COMPLEXES.push(complex);
    transactionsByComplex[complex.id] = [];
    saveCustomComplexes();
  }

  toggleFavorite(complex.id);
}

function createComplexFromKakaoPlace(place) {
  const address = place.road_address_name || place.address_name || "";
  const parsed = parseKoreanAddress(address);
  const seed = Math.max(1, hashString(`${place.id}-${place.place_name}`) % 19);
  return {
    id: `kakao-${place.id || hashString(`${place.place_name}-${address}`)}`,
    kakaoPlaceId: place.id,
    source: "kakao",
    name: place.place_name,
    dong: parsed.dong || "동 정보 확인 필요",
    city: parsed.city || "지역 확인 필요",
    address: address || place.place_url || "주소 확인 필요",
    jibunAddress: place.address_name || "",
    legalDongCode: "",
    legalDongFullCode: "",
    kaptCode: "",
    kaptName: "",
    aptListCandidates: [],
    buildingCount: null,
    approvalDate: "",
    parkingTotal: null,
    parkingGround: null,
    parkingUnderground: null,
    parkingPerHousehold: null,
    buildingCoverageRatio: null,
    floorAreaRatio: null,
    landArea: null,
    buildingArea: null,
    grossFloorArea: null,
    buildingLedgerStatus: "idle",
    buildingLedgerError: "",
    lastBuildingLedgerSync: "",
    lotNumber: parseLotNumber(place.address_name || address),
    households: 0,
    builtYear: null,
    lat: Number(place.y),
    lng: Number(place.x),
    mapX: 52,
    mapY: 48,
    tags: ["카카오 검색", "단지목록 매칭 전", "실거래 매칭 전"],
    bases: {},
    tradeStatus: "idle",
    tradeMessage: "국토부 실거래 조회 전",
    lastTradeSync: "",
    trend: 0.025,
    seed,
  };
}

function createComplexFromAptListCandidate(candidate) {
  const seed = Math.max(1, hashString(`${candidate.kaptCode}-${candidate.kaptName}`) % 19);
  const legalDongFullCode = String(candidate.bjdCode || "");
  const address = candidate.address || [candidate.as1, candidate.as2, candidate.as3, candidate.as4].filter(Boolean).join(" ");
  return {
    id: `aptlist-${candidate.kaptCode || hashString(`${candidate.kaptName}-${candidate.bjdCode}`)}`,
    kakaoPlaceId: candidate.kakaoPlaceId || "",
    source: "aptlist",
    name: candidate.kaptName,
    dong: candidate.dong || candidate.as3 || "동 정보 확인 필요",
    city: candidate.city || [candidate.as1, candidate.as2].filter(Boolean).join(" ") || "지역 확인 필요",
    address: address || "주소 확인 필요",
    jibunAddress: candidate.jibunAddress || address || "",
    legalDongCode: legalDongFullCode ? legalDongFullCode.slice(0, 5) : "",
    legalDongFullCode,
    kaptCode: candidate.kaptCode || "",
    kaptName: candidate.kaptName || "",
    aptListCandidates: [
      {
        kaptCode: candidate.kaptCode || "",
        kaptName: candidate.kaptName || "",
        bjdCode: candidate.bjdCode || "",
        score: 1,
      },
    ],
    buildingCount: null,
    approvalDate: "",
    parkingTotal: null,
    parkingGround: null,
    parkingUnderground: null,
    parkingPerHousehold: null,
    buildingCoverageRatio: null,
    floorAreaRatio: null,
    landArea: null,
    buildingArea: null,
    grossFloorArea: null,
    buildingLedgerStatus: "idle",
    buildingLedgerError: "",
    lastBuildingLedgerSync: "",
    lotNumber: candidate.lotNumber || parseLotNumber(candidate.jibunAddress || address),
    households: 0,
    builtYear: null,
    lat: Number(candidate.lat) || DEFAULT_MAP_CENTER.lat,
    lng: Number(candidate.lng) || DEFAULT_MAP_CENTER.lng,
    mapX: 52,
    mapY: 48,
    tags: ["국토부 단지목록", candidate.coordinateSource === "kakao" ? "좌표 확보" : "동 중심 좌표", "실거래 매칭 전"],
    bases: {},
    tradeStatus: "idle",
    tradeMessage: "국토부 실거래 조회 전",
    lastTradeSync: "",
    trend: 0.025,
    seed,
  };
}

function findRegisteredPlace(place) {
  const normalizedName = normalize(place.place_name || "");
  const normalizedAddress = normalize(place.road_address_name || place.address_name || "");
  return COMPLEXES.find((complex) => {
    if (complex.kakaoPlaceId && complex.kakaoPlaceId === place.id) return true;
    return (
      normalize(complex.name) === normalizedName &&
      normalize(complex.address) === normalizedAddress
    );
  });
}

function findRegisteredAptListCandidate(candidate) {
  return COMPLEXES.find((complex) => {
    if (candidate.kaptCode && complex.kaptCode === candidate.kaptCode) return true;
    return (
      normalizeApartmentName(complex.kaptName || complex.name) === normalizeApartmentName(candidate.kaptName) &&
      String(complex.legalDongFullCode || "") === String(candidate.bjdCode || "")
    );
  });
}

function parseKoreanAddress(address) {
  const parts = address.split(/\s+/).filter(Boolean);
  const dong = parts.find((part) => /동$|읍$|면$|가$/.test(part)) || "";
  const city = parts.slice(0, Math.min(parts.length, 3)).join(" ");
  return { city, dong };
}

function parseLotNumber(address) {
  const parts = address.split(/\s+/).filter(Boolean);
  const last = parts[parts.length - 1] || "";
  return /^\d+(-\d+)?$/.test(last) ? last : "";
}

function refreshPendingFavoriteTrades() {
  const favoriteComplexes = state.favorites
    .map((id) => COMPLEXES.find((complex) => complex.id === id))
    .filter((complex) => isUserRegisteredSource(complex?.source));

  favoriteComplexes
    .filter((complex) => transactionsByComplex[complex.id]?.length)
    .filter((complex) => needsAptIdentityInfo(complex))
    .slice(0, 2)
    .forEach((complex) => refreshAptIdentityInfoForComplex(complex.id));

  favoriteComplexes
    .filter((complex) => needsBasisInfo(complex))
    .slice(0, 3)
    .forEach((complex) => refreshBasisInfoForComplex(complex.id));

  favoriteComplexes
    .filter((complex) => needsBuildingLedgerInfo(complex))
    .slice(0, 3)
    .forEach((complex) => refreshBuildingLedgerInfoForComplex(complex.id));

  favoriteComplexes
    .filter((complex) => !transactionsByComplex[complex.id]?.length)
    .filter((complex) => !["loading", "loaded", "empty"].includes(complex.tradeStatus))
    .slice(0, 3)
    .forEach((complex) => refreshRealTransactionsForComplex(complex.id));
}

async function refreshAptIdentityInfoForComplex(complexId) {
  const complex = COMPLEXES.find((item) => item.id === complexId);
  if (!complex || complex.basisStatus === "loading" || complex.tradeStatus === "loading") return;

  if (!hasMolitApiAccess()) return;

  complex.basisStatus = "loading";
  try {
    await enrichComplexLocationFromKakao(complex);
    await enrichBuildingLedgerInfoSafely(complex);
    await matchAptListForComplex(complex);
    if (complex.kaptCode) {
      await enrichComplexBasisInfo(complex);
      complex.basisStatus = "loaded";
    } else {
      complex.basisStatus = "empty";
    }
    saveCustomComplexes();
    render();
  } catch (error) {
    complex.basisStatus = "error";
    complex.basisInfoError = error.message || "국토부 단지 기본정보 조회 실패";
    saveCustomComplexes();
    render();
  }
}

async function refreshBasisInfoForComplex(complexId) {
  const complex = COMPLEXES.find((item) => item.id === complexId);
  if (!complex?.kaptCode || complex.basisStatus === "loading") return;

  if (!hasMolitApiAccess()) return;

  complex.basisStatus = "loading";
  try {
    await enrichComplexBasisInfo(complex);
    complex.basisStatus = "loaded";
    saveCustomComplexes();
    render();
  } catch (error) {
    complex.basisStatus = "error";
    complex.basisInfoError = error.message || "국토부 단지 기본정보 조회 실패";
    saveCustomComplexes();
    render();
  }
}

async function refreshBuildingLedgerInfoForComplex(complexId) {
  const complex = COMPLEXES.find((item) => item.id === complexId);
  if (!complex || complex.buildingLedgerStatus === "loading") return;

  if (!hasMolitApiAccess()) return;

  complex.buildingLedgerStatus = "loading";
  try {
    await enrichComplexLocationFromKakao(complex);
    await enrichBuildingLedgerInfo(complex);
    if (complex.buildingLedgerStatus !== "empty") {
      complex.buildingLedgerStatus = "loaded";
    }
    saveCustomComplexes();
    render();
  } catch (error) {
    complex.buildingLedgerStatus = "error";
    complex.buildingLedgerError = error.message || "건축물대장 조회 실패";
    saveCustomComplexes();
    render();
  }
}

function needsBasisInfo(complex) {
  return (
    Boolean(complex?.kaptCode) &&
    (!Number(complex.households) ||
      !Number(complex.buildingCount) ||
      !complex.approvalDate ||
      !Number.isFinite(complex.parkingTotal) ||
      !Number.isFinite(complex.parkingPerHousehold))
  );
}

function needsBuildingLedgerInfo(complex) {
  return (
    Boolean(complex?.source === "kakao") &&
    Boolean(complex.legalDongFullCode || complex.lat || complex.lng) &&
    !["loading", "loaded", "empty"].includes(complex.buildingLedgerStatus) &&
    (!Number.isFinite(complex.floorAreaRatio) || !Number.isFinite(complex.buildingCoverageRatio))
  );
}

function needsAptIdentityInfo(complex) {
  return (
    Boolean(complex?.source === "kakao") &&
    !complex.kaptCode &&
    !["loading", "loaded", "empty"].includes(complex.basisStatus)
  );
}

async function refreshRealTransactionsForComplex(complexId) {
  const complex = COMPLEXES.find((item) => item.id === complexId);
  if (!complex) return;

  if (!hasMolitApiAccess()) {
    complex.tradeStatus = "error";
    complex.tradeMessage = "국토부 API 인증키가 필요합니다.";
    render();
    return;
  }

  complex.tradeStatus = "loading";
  complex.tradeMessage = "단지 행정정보 확인 중";
  render();

  try {
    await enrichComplexLocationFromKakao(complex);
    if (!complex.legalDongCode) {
      throw new Error("단지 행정정보를 확인하지 못했습니다.");
    }

    complex.tradeMessage = "건축물대장 정보 조회 중";
    render();
    await enrichBuildingLedgerInfoSafely(complex);

    complex.tradeMessage = "국토부 단지목록 매칭 중";
    render();
    try {
      await matchAptListForComplex(complex);
    } catch (aptListError) {
      complex.aptListError = aptListError.message || "국토부 단지목록 조회 실패";
      complex.tags = updateAptListTags(complex.tags, "error");
    }

    if (complex.kaptCode) {
      complex.tradeMessage = "국토부 단지 기본정보 조회 중";
      render();
      try {
        await enrichComplexBasisInfo(complex);
      } catch (basisError) {
        complex.basisInfoError = basisError.message || "국토부 단지 기본정보 조회 실패";
      }
    }

    complex.tradeMessage = "국토부 실거래 조회 중";
    render();

    const apiItems = await fetchRtmsItemsForComplex(complex);
    const matched = apiItems.filter((item) => isRtmsItemMatch(complex, item));
    const transactions = matched
      .map((item, index) => rtmsItemToTransaction(complex, item, index))
      .filter(Boolean)
      .sort((a, b) => a.date.localeCompare(b.date));

    transactionsByComplex[complex.id] = transactions;
    complex.realTransactions = transactions;
    complex.tradeStatus = transactions.length ? "loaded" : "empty";
    complex.tradeMessage = transactions.length
      ? `국토부 실거래 ${transactions.length}건 매칭`
      : "국토부 자료는 조회됐지만 단지명/지번 매칭 거래가 없습니다.";
    complex.lastTradeSync = new Date().toISOString();
    complex.tags = updateTradeTags(complex.tags, complex.tradeStatus);
    saveCustomComplexes();
    ensureValidAreaGroup();
    render();
  } catch (error) {
    complex.tradeStatus = "error";
    complex.tradeMessage = error.message || "국토부 실거래 조회에 실패했습니다.";
    complex.tags = updateTradeTags(complex.tags, "error");
    saveCustomComplexes();
    render();
  }
}

function enrichComplexLocationFromKakao(complex) {
  return new Promise((resolve) => {
    if (!window.kakao?.maps?.services || (!complex.lat && !complex.lng)) {
      resolve();
      return;
    }

    const geocoder = new window.kakao.maps.services.Geocoder();
    geocoder.coord2RegionCode(complex.lng, complex.lat, (regions, status) => {
      if (status === window.kakao.maps.services.Status.OK) {
        const legalRegion = regions.find((region) => region.region_type === "B") || regions[0];
        if (legalRegion?.code) {
          complex.legalDongFullCode = legalRegion.code;
          complex.legalDongCode = legalRegion.code.slice(0, 5);
          complex.dong = legalRegion.region_3depth_name || complex.dong;
          complex.city = [legalRegion.region_1depth_name, legalRegion.region_2depth_name]
            .filter(Boolean)
            .join(" ");
        }
      }
      complex.lotNumber = complex.lotNumber || parseLotNumber(complex.jibunAddress || complex.address || "");
      resolve();
    });
  });
}

async function matchAptListForComplex(complex) {
  const bjdCode = complex.legalDongFullCode || "";
  if (!bjdCode) return [];

  const candidates = await fetchAptListByLegalDong(bjdCode);
  const ranked = candidates
    .map((candidate) => ({
      ...candidate,
      score: scoreAptListCandidate(complex, candidate),
    }))
    .sort((a, b) => b.score - a.score);

  complex.aptListCandidates = ranked.slice(0, 5).map((candidate) => ({
    kaptCode: candidate.kaptCode,
    kaptName: candidate.kaptName,
    bjdCode: candidate.bjdCode,
    score: roundTo(candidate.score, 3),
  }));

  const best = ranked[0];
  if (best && best.score >= 0.58) {
    complex.kaptCode = best.kaptCode || "";
    complex.kaptName = best.kaptName || "";
    complex.tags = updateAptListTags(complex.tags, "matched");
    return complex.aptListCandidates;
  }

  complex.kaptCode = "";
  complex.kaptName = "";
  complex.tags = updateAptListTags(complex.tags, candidates.length ? "candidates" : "empty");
  return complex.aptListCandidates;
}

async function fetchAptListByLegalDong(bjdCode) {
  const response = await fetch(buildAptListRequestUrl({ bjdCode, numOfRows: 200 }));
  if (!response.ok) {
    throw new Error(`국토부 단지목록 API 응답 오류: ${response.status}`);
  }

  const payload = await response.json();
  if (shouldUseBackendApi()) {
    return (payload.items || []).map((item) => ({
      kaptCode: String(item.kaptCode || ""),
      kaptName: String(item.kaptName || ""),
      bjdCode: String(item.bjdCode || ""),
      as1: String(item.as1 || ""),
      as2: String(item.as2 || ""),
      as3: String(item.as3 || ""),
      as4: String(item.as4 || ""),
    }));
  }

  const header = payload?.response?.header;
  if (header?.resultCode && header.resultCode !== "00") {
    throw new Error(header.resultMsg || `국토부 단지목록 API 오류: ${header.resultCode}`);
  }

  const items = payload?.response?.body?.items;
  if (!items) return [];
  return (Array.isArray(items) ? items : [items]).map((item) => ({
    kaptCode: String(item.kaptCode || ""),
    kaptName: String(item.kaptName || ""),
    bjdCode: String(item.bjdCode || ""),
    as1: String(item.as1 || ""),
    as2: String(item.as2 || ""),
    as3: String(item.as3 || ""),
    as4: String(item.as4 || ""),
  }));
}

function buildAptListRequestUrl(args) {
  if (!shouldUseBackendApi()) return buildAptListApiUrl(args);
  const url = new URL("/api/apt-list", window.location.origin);
  url.searchParams.set("bjdCode", args.bjdCode);
  url.searchParams.set("pageNo", String(args.pageNo || 1));
  url.searchParams.set("numOfRows", String(args.numOfRows || 200));
  return url.toString();
}

function buildAptListApiUrl({ bjdCode, pageNo = 1, numOfRows = 200 }) {
  const { serviceKey } = getRtmsApiConfig();
  const url = new URL(`${APT_LIST_API_ENDPOINT}/${APT_LIST_LEGALDONG_OPERATION}`);
  url.searchParams.set("serviceKey", serviceKey);
  url.searchParams.set("bjdCode", bjdCode);
  url.searchParams.set("pageNo", String(pageNo));
  url.searchParams.set("numOfRows", String(numOfRows));
  return url.toString();
}

function scoreAptListCandidate(complex, candidate) {
  const sourceNames = [complex.name, complex.kaptName].filter(Boolean).map(normalizeApartmentName);
  const candidateName = normalizeApartmentName(candidate.kaptName);
  if (!candidateName || !sourceNames.length) return 0;

  const scores = sourceNames.map((sourceName) => {
    if (!sourceName) return 0;
    if (sourceName === candidateName) return 1;
    if (sourceName.includes(candidateName) || candidateName.includes(sourceName)) {
      const shorter = Math.min(sourceName.length, candidateName.length);
      const longer = Math.max(sourceName.length, candidateName.length);
      return 0.72 + (shorter / longer) * 0.2;
    }
    return stringSimilarity(sourceName, candidateName);
  });

  return Math.max(...scores);
}

async function enrichComplexBasisInfo(complex) {
  if (!complex.kaptCode) return;

  const [basicInfo, detailInfo] = await Promise.all([
    fetchAptBasisInfo(APT_BASIS_BASIC_OPERATION, complex.kaptCode),
    fetchAptBasisInfo(APT_BASIS_DETAIL_OPERATION, complex.kaptCode),
  ]);

  const householdCount = parseNumber(basicInfo.kaptdaCnt);
  const buildingCount = parseNumber(basicInfo.kaptDongCnt);
  const parkingGround = parseNumber(detailInfo.kaptdPcnt);
  const parkingUnderground = parseNumber(detailInfo.kaptdPcntu);
  const parkingTotal = sumNullable(parkingGround, parkingUnderground);

  complex.kaptName = basicInfo.kaptName || detailInfo.kaptName || complex.kaptName;
  complex.households = householdCount || complex.households || 0;
  complex.buildingCount = buildingCount || complex.buildingCount || null;
  complex.approvalDate = basicInfo.kaptUsedate || complex.approvalDate || "";
  complex.builtYear = getYearFromYmd(complex.approvalDate) || complex.builtYear || null;
  complex.parkingGround = parkingGround;
  complex.parkingUnderground = parkingUnderground;
  complex.parkingTotal = parkingTotal;
  complex.parkingPerHousehold =
    parkingTotal !== null && complex.households ? roundTo(parkingTotal / Number(complex.households), 2) : null;
  complex.lastBasisSync = new Date().toISOString();
}

async function fetchAptBasisInfo(operation, kaptCode) {
  const response = await fetch(buildAptBasisRequestUrl({ operation, kaptCode }));
  if (!response.ok) {
    throw new Error(`국토부 단지 기본정보 API 응답 오류: ${response.status}`);
  }

  const payload = await response.json();
  if (shouldUseBackendApi()) {
    return payload.item || {};
  }

  const header = payload?.response?.header;
  if (header?.resultCode && header.resultCode !== "00") {
    throw new Error(header.resultMsg || `국토부 단지 기본정보 API 오류: ${header.resultCode}`);
  }

  return payload?.response?.body?.item || {};
}

function buildAptBasisRequestUrl(args) {
  if (!shouldUseBackendApi()) return buildAptBasisApiUrl(args);
  const url = new URL("/api/apt-basis", window.location.origin);
  url.searchParams.set("operation", args.operation);
  url.searchParams.set("kaptCode", args.kaptCode);
  return url.toString();
}

function buildAptBasisApiUrl({ operation, kaptCode }) {
  const { serviceKey } = getRtmsApiConfig();
  const url = new URL(`${APT_BASIS_API_ENDPOINT}/${operation}`);
  url.searchParams.set("serviceKey", serviceKey);
  url.searchParams.set("kaptCode", kaptCode);
  return url.toString();
}

async function enrichBuildingLedgerInfoSafely(complex) {
  try {
    await enrichBuildingLedgerInfo(complex);
    if (complex.buildingLedgerStatus !== "empty") {
      complex.buildingLedgerStatus = "loaded";
    }
  } catch (error) {
    complex.buildingLedgerStatus = complex.buildingLedgerStatus === "empty" ? "empty" : "error";
    complex.buildingLedgerError = error.message || "건축물대장 조회 실패";
  }
}

async function enrichBuildingLedgerInfo(complex) {
  const params = buildBuildingHubParams(complex);
  if (!params) {
    complex.buildingLedgerStatus = "empty";
    return;
  }

  const batches = await Promise.all(
    BUILDING_HUB_OPERATIONS.map((operation) =>
      fetchBuildingHubItems(operation, params).catch(() => [])
    )
  );
  const items = batches.flat();
  if (!items.length) {
    complex.buildingLedgerStatus = "empty";
    return;
  }

  const floorAreaRatio = firstNumberFromItems(items, ["vlRat", "vlRatEstmTotAreaRat", "floorAreaRatio"]);
  const buildingCoverageRatio = firstNumberFromItems(items, ["bcRat", "buildingCoverageRatio"]);
  const landArea = firstNumberFromItems(items, ["platArea", "landArea"]);
  const buildingArea = firstNumberFromItems(items, ["archArea", "buildingArea"]);
  const grossFloorArea = firstNumberFromItems(items, ["totArea", "grossFloorArea"]);
  const ledgerParkingTotal = extractBuildingLedgerParkingTotal(items);

  complex.floorAreaRatio = floorAreaRatio ?? complex.floorAreaRatio ?? null;
  complex.buildingCoverageRatio = buildingCoverageRatio ?? complex.buildingCoverageRatio ?? null;
  complex.landArea = landArea ?? complex.landArea ?? null;
  complex.buildingArea = buildingArea ?? complex.buildingArea ?? null;
  complex.grossFloorArea = grossFloorArea ?? complex.grossFloorArea ?? null;
  if (!Number.isFinite(complex.parkingTotal) && Number.isFinite(ledgerParkingTotal)) {
    complex.parkingTotal = ledgerParkingTotal;
    complex.parkingPerHousehold =
      complex.households ? roundTo(ledgerParkingTotal / Number(complex.households), 2) : complex.parkingPerHousehold;
  }
  complex.lastBuildingLedgerSync = new Date().toISOString();
}

async function fetchBuildingHubItems(operation, params) {
  const response = await fetch(buildBuildingHubRequestUrl({ operation, params }));
  if (!response.ok) {
    throw new Error(`건축물대장 API 응답 오류: ${response.status}`);
  }

  if (shouldUseBackendApi()) {
    const payload = await response.json();
    return payload.items || [];
  }

  const text = await response.text();
  if (!text.trim()) return [];

  if (text.trim().startsWith("{")) {
    const payload = JSON.parse(text);
    const header = payload?.response?.header;
    if (header?.resultCode && !["00", "000"].includes(String(header.resultCode))) {
      throw new Error(header.resultMsg || `건축물대장 API 오류: ${header.resultCode}`);
    }
    return normalizeApiItems(payload?.response?.body?.items?.item || payload?.response?.body?.item);
  }

  const doc = new DOMParser().parseFromString(text, "application/xml");
  const resultCode = textFromXml(doc, "resultCode");
  const resultMsg = textFromXml(doc, "resultMsg");
  if (resultCode && !["00", "000"].includes(resultCode)) {
    throw new Error(resultMsg || `건축물대장 API 오류: ${resultCode}`);
  }
  return Array.from(doc.querySelectorAll("item")).map((item) => {
    const data = {};
    Array.from(item.children).forEach((child) => {
      data[child.tagName] = child.textContent?.trim() || "";
    });
    return data;
  });
}

function buildBuildingHubRequestUrl(args) {
  if (!shouldUseBackendApi()) return buildBuildingHubApiUrl(args);
  const url = new URL("/api/building-ledger", window.location.origin);
  url.searchParams.set("operation", args.operation);
  url.searchParams.set("sigunguCd", args.params.sigunguCd);
  url.searchParams.set("bjdongCd", args.params.bjdongCd);
  url.searchParams.set("platGbCd", args.params.platGbCd);
  url.searchParams.set("bun", args.params.bun);
  url.searchParams.set("ji", args.params.ji);
  url.searchParams.set("pageNo", String(args.params.pageNo || 1));
  url.searchParams.set("numOfRows", String(args.params.numOfRows || 100));
  return url.toString();
}

function buildBuildingHubApiUrl({ operation, params }) {
  const { serviceKey } = getRtmsApiConfig();
  const url = new URL(`${BUILDING_HUB_API_ENDPOINT}/${operation}`);
  url.searchParams.set("serviceKey", serviceKey);
  url.searchParams.set("sigunguCd", params.sigunguCd);
  url.searchParams.set("bjdongCd", params.bjdongCd);
  url.searchParams.set("platGbCd", params.platGbCd);
  url.searchParams.set("bun", params.bun);
  url.searchParams.set("ji", params.ji);
  url.searchParams.set("_type", "json");
  url.searchParams.set("numOfRows", "100");
  url.searchParams.set("pageNo", "1");
  return url.toString();
}

function buildBuildingHubParams(complex) {
  const bjdCode = String(complex.legalDongFullCode || "");
  if (bjdCode.length < 10) return null;

  const sourceAddress = `${complex.jibunAddress || ""} ${complex.address || ""}`;
  const lot = parseLotNumberParts(complex.lotNumber || parseLotNumber(sourceAddress));
  if (!lot) return null;

  return {
    sigunguCd: bjdCode.slice(0, 5),
    bjdongCd: bjdCode.slice(5, 10),
    platGbCd: /(^|\s)산/.test(sourceAddress) ? "1" : "0",
    bun: lot.bun,
    ji: lot.ji,
  };
}

function parseLotNumberParts(value) {
  const text = String(value || "").replace(/[^\d-]/g, "");
  if (!text) return null;
  const [bunRaw, jiRaw = "0"] = text.split("-");
  const bun = Number(bunRaw);
  const ji = Number(jiRaw);
  if (!Number.isFinite(bun) || !Number.isFinite(ji)) return null;
  return {
    bun: String(bun).padStart(4, "0"),
    ji: String(ji).padStart(4, "0"),
  };
}

function normalizeApiItems(items) {
  if (!items) return [];
  return Array.isArray(items) ? items : [items];
}

function firstNumberFromItems(items, keys) {
  for (const item of items) {
    for (const key of keys) {
      const value = parseNumber(item?.[key]);
      if (Number.isFinite(value) && value > 0) return value;
    }
  }
  return null;
}

function extractBuildingLedgerParkingTotal(items) {
  const direct = firstNumberFromItems(items, ["totPkngCnt", "totalParkingCount", "parkingTotal"]);
  if (Number.isFinite(direct)) return direct;

  const countKeys = ["indrMechUtcnt", "oudrMechUtcnt", "indrAutoUtcnt", "oudrAutoUtcnt"];
  const total = items.reduce((sum, item) => {
    return sum + countKeys.reduce((itemSum, key) => itemSum + (parseNumber(item?.[key]) || 0), 0);
  }, 0);
  return total > 0 ? total : null;
}

async function fetchRtmsItemsForComplex(complex) {
  const months = buildMonthRange(REFERENCE_MONTH, 24).map((month) => month.replace("-", ""));
  const batches = await Promise.all(
    months.map((dealYmd) => fetchRtmsMonth({ lawdCd: complex.legalDongCode, dealYmd }))
  );
  return batches.flat();
}

async function fetchRtmsMonth({ lawdCd, dealYmd }) {
  const response = await fetch(buildRtmsRequestUrl({ lawdCd, dealYmd, numOfRows: 1000 }));
  if (!response.ok) {
    throw new Error(`국토부 API 응답 오류: ${response.status}`);
  }
  if (shouldUseBackendApi()) {
    const payload = await response.json();
    return payload.items || [];
  }
  const xmlText = await response.text();
  return parseRtmsXml(xmlText);
}

function buildRtmsRequestUrl(args) {
  if (!shouldUseBackendApi()) return buildRtmsApiUrl(args);
  const url = new URL("/api/rtms", window.location.origin);
  url.searchParams.set("lawdCd", args.lawdCd);
  url.searchParams.set("dealYmd", args.dealYmd);
  url.searchParams.set("pageNo", String(args.pageNo || 1));
  url.searchParams.set("numOfRows", String(args.numOfRows || 1000));
  return url.toString();
}

function parseRtmsXml(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  const resultCode = textFromXml(doc, "resultCode");
  const resultMsg = textFromXml(doc, "resultMsg");
  if (resultCode && resultCode !== "000") {
    throw new Error(resultMsg || `국토부 API 오류: ${resultCode}`);
  }

  return Array.from(doc.querySelectorAll("item")).map((item) => ({
    aptNm: textFromXml(item, "aptNm"),
    buildYear: textFromXml(item, "buildYear"),
    dealAmount: textFromXml(item, "dealAmount"),
    dealDay: textFromXml(item, "dealDay"),
    dealMonth: textFromXml(item, "dealMonth"),
    dealYear: textFromXml(item, "dealYear"),
    excluUseAr: textFromXml(item, "excluUseAr"),
    floor: textFromXml(item, "floor"),
    jibun: textFromXml(item, "jibun"),
    sggCd: textFromXml(item, "sggCd"),
    umdNm: textFromXml(item, "umdNm"),
    aptDong: textFromXml(item, "aptDong"),
  }));
}

function textFromXml(root, selector) {
  return root.querySelector(selector)?.textContent?.trim() || "";
}

function isRtmsItemMatch(complex, item) {
  const complexNames = [complex.kaptName, complex.name]
    .filter(Boolean)
    .map(normalizeApartmentName)
    .filter(Boolean);
  const itemName = normalizeApartmentName(item.aptNm);
  const nameMatch = itemName && complexNames.some((complexName) => {
    return complexName.includes(itemName) || itemName.includes(complexName);
  });
  const dongMatch =
    !complex.dong ||
    complex.dong.includes("확인 필요") ||
    complex.dong === item.umdNm ||
    normalize(complex.dong).includes(normalize(item.umdNm));
  const lotMatch =
    complex.lotNumber &&
    item.jibun &&
    normalizeLotNumber(complex.lotNumber) === normalizeLotNumber(item.jibun);

  return (nameMatch && dongMatch) || (lotMatch && dongMatch);
}

function rtmsItemToTransaction(complex, item, index) {
  const area = Number(item.excluUseAr);
  const dealAmountManwon = Number(item.dealAmount.replace(/,/g, ""));
  if (!area || !dealAmountManwon || !item.dealYear || !item.dealMonth || !item.dealDay) return null;

  const month = `${item.dealYear}-${String(item.dealMonth).padStart(2, "0")}`;
  const date = `${month}-${String(item.dealDay).padStart(2, "0")}`;
  const priceEok = roundTo(dealAmountManwon / 10000, 2);
  return {
    id: `${complex.id}-rtms-${date}-${index}`,
    complexId: complex.id,
    month,
    date,
    area,
    areaGroupId: getAreaGroupId(area),
    floor: Number(item.floor) || 0,
    priceEok,
    ppy: Math.round(dealAmountManwon / (area / 3.3058)),
    aptNm: item.aptNm,
    jibun: item.jibun,
  };
}

function normalizeApartmentName(value) {
  return normalize(value)
    .replace(/아파트/g, "")
    .replace(/단지/g, "")
    .replace(/맨션/g, "")
    .replace(/[^가-힣a-z0-9]/g, "");
}

function normalizeLotNumber(value) {
  return normalize(value).replace(/[^0-9-]/g, "");
}

function updateTradeTags(tags = [], status) {
  const clean = tags.filter((tag) => !["실거래 매칭 전", "조회 중", "실거래 매칭 완료", "조회 실패"].includes(tag));
  const next =
    status === "loaded"
      ? "실거래 매칭 완료"
      : status === "loading"
        ? "조회 중"
        : status === "error"
          ? "조회 실패"
          : "실거래 매칭 전";
  return Array.from(new Set([...clean, next]));
}

function updateAptListTags(tags = [], status) {
  const clean = tags.filter(
    (tag) => !["단지목록 매칭 전", "단지목록 매칭 완료", "단지목록 후보 확인", "단지목록 없음", "단지목록 조회 실패"].includes(tag)
  );
  const next =
    status === "matched"
      ? "단지목록 매칭 완료"
      : status === "candidates"
        ? "단지목록 후보 확인"
        : status === "empty"
          ? "단지목록 없음"
          : status === "error"
            ? "단지목록 조회 실패"
            : "단지목록 매칭 전";
  return Array.from(new Set([...clean, next]));
}

function renderResults() {
  const query = normalize(state.query);
  if (!query) {
    el.resultList.innerHTML = `<div class="empty-state">단지명, 동네, 주소를 입력하면<br />국토부 단지목록과 카카오 장소검색 결과가 표시됩니다.</div>`;
    return;
  }

  const filtered = COMPLEXES.filter((complex) => {
    const haystack = normalize(
      [
        complex.name,
        complex.kaptName,
        complex.kaptCode,
        complex.city,
        complex.dong,
        complex.address,
        complex.legalDongCode,
        complex.legalDongFullCode,
        complex.lotNumber,
        ...complex.tags,
      ].join(" ")
    );
    return haystack.includes(query);
  });

  const sections = [];
  if (filtered.length) {
    sections.push(filtered.map(renderComplexRow).join(""));
  }

  if (state.query.length >= 2) {
    if (state.aptListSearchStatus === "loading") {
      sections.push(`<div class="empty-state">${state.aptListSearchMessage || "국토부 단지목록을 조회하고 있습니다."}</div>`);
    } else if (state.aptListSearchStatus === "ready-waiting") {
      sections.push(`<div class="empty-state">${state.aptListSearchMessage}</div>`);
    } else if (state.aptListSearchStatus === "key-missing") {
      sections.push(`<div class="empty-state">국토부 인증키를 저장하면 동 이름으로 단지목록을 조회할 수 있습니다.</div>`);
    } else if (state.aptListSearchStatus === "no-region") {
      sections.push(`<div class="empty-state">${state.aptListSearchMessage}</div>`);
    } else if (state.aptListSearchStatus === "error") {
      sections.push(`<div class="empty-state">국토부 단지목록 조회에 실패했습니다.<br />${escapeHtml(state.aptListSearchMessage)}</div>`);
    } else if (state.aptListSearchResults.length) {
      sections.push(`
        <div class="search-section-title">
          <span>국토부 단지목록</span>
          <small>${escapeHtml(state.aptListSearchRegionName)} · ${state.aptListSearchResults.length}개 후보</small>
        </div>
        ${state.aptListSearchResults.map(renderAptListSearchRow).join("")}
      `);
    }

    if (state.kakaoSearchStatus === "loading") {
      sections.push(`<div class="empty-state">카카오 장소검색으로 단지 후보를 찾고 있습니다.</div>`);
    } else if (state.kakaoSearchStatus === "ready-waiting") {
      sections.push(`<div class="empty-state">카카오맵이 연결되면 실제 장소검색 결과가 표시됩니다.</div>`);
    } else if (state.kakaoSearchStatus === "error") {
      sections.push(`<div class="empty-state">카카오 장소검색에 실패했습니다.<br />키, 도메인, 사용 설정을 확인해주세요.</div>`);
    } else if (state.kakaoSearchResults.length) {
      sections.push(`
        <div class="search-section-title">
          <span>카카오 장소검색</span>
          <small>${state.kakaoSearchResults.length}개 후보</small>
        </div>
        ${state.kakaoSearchResults.map(renderKakaoPlaceRow).join("")}
      `);
    }
  }

  if (!sections.length) {
    el.resultList.innerHTML = `<div class="empty-state">검색 결과가 없습니다.<br />단지명이나 동네명을 조금 짧게 입력해보세요.</div>`;
    return;
  }

  el.resultList.innerHTML = sections.join("");
  el.resultList.querySelectorAll("[data-select]").forEach((button) => {
    button.addEventListener("click", () => selectComplex(button.dataset.select));
  });
  el.resultList.querySelectorAll("[data-toggle]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleFavorite(button.dataset.toggle);
    });
  });
  el.resultList.querySelectorAll("[data-kakao-add]").forEach((button) => {
    button.addEventListener("click", () => toggleKakaoPlaceFavorite(button.dataset.kakaoAdd));
  });
  el.resultList.querySelectorAll("[data-aptlist-add]").forEach((button) => {
    button.addEventListener("click", () => toggleAptListFavorite(button.dataset.aptlistAdd));
  });
}

function renderComplexRow(complex) {
  const isFavorite = state.favorites.includes(complex.id);
  const isSelected = state.selectedComplexId === complex.id;
  return `
    <article class="complex-row">
      <button class="complex-main ghost-reset" type="button" data-select="${complex.id}" aria-label="${complex.name} 선택">
        <div class="complex-title">
          ${isSelected ? `<span class="selected-ring" aria-hidden="true"></span>` : ""}
          <strong>${complex.name}</strong>
        </div>
        <p>${complex.address}</p>
        <div class="tag-row">
          <span class="tag">${formatHouseholds(complex.households)}</span>
          <span class="tag">${formatBuiltYear(complex.builtYear)}</span>
          ${complex.tags.slice(0, 2).map((tag) => `<span class="tag">${tag}</span>`).join("")}
        </div>
      </button>
      <button
        class="toggle-button ${isFavorite ? "active" : ""}"
        type="button"
        data-toggle="${complex.id}"
        aria-pressed="${isFavorite}"
      >
        ${isFavorite ? "등록됨" : "관심"}
      </button>
    </article>
  `;
}

function renderKakaoPlaceRow(place) {
  const registered = findRegisteredPlace(place);
  const isFavorite = registered ? state.favorites.includes(registered.id) : false;
  const address = place.road_address_name || place.address_name || "";
  return `
    <article class="complex-row kakao-result-row">
      <div class="complex-main">
        <div class="complex-title">
          <strong>${escapeHtml(place.place_name)}</strong>
        </div>
        <p>${escapeHtml(address || "주소 정보 없음")}</p>
        <div class="tag-row">
          <span class="tag">카카오 검색</span>
          <span class="tag">좌표 확보</span>
          <span class="tag">실거래 매칭 전</span>
        </div>
      </div>
      <button
        class="toggle-button ${isFavorite ? "active" : ""}"
        type="button"
        data-kakao-add="${place.id}"
        aria-pressed="${isFavorite}"
      >
        ${isFavorite ? "등록됨" : "관심"}
      </button>
    </article>
  `;
}

function renderAptListSearchRow(candidate) {
  const registered = findRegisteredAptListCandidate(candidate);
  const isFavorite = registered ? state.favorites.includes(registered.id) : false;
  return `
    <article class="complex-row aptlist-result-row">
      <div class="complex-main">
        <div class="complex-title">
          <strong>${escapeHtml(candidate.kaptName)}</strong>
        </div>
        <p>${escapeHtml(candidate.address || candidate.city || "주소 확인 중")}</p>
        <div class="tag-row">
          <span class="tag">국토부 단지목록</span>
          <span class="tag">K-APT 매칭</span>
          <span class="tag">${escapeHtml(candidate.coordinateLabel || "좌표 보강 전")}</span>
        </div>
      </div>
      <button
        class="toggle-button ${isFavorite ? "active" : ""}"
        type="button"
        data-aptlist-add="${candidate.searchId}"
        aria-pressed="${isFavorite}"
      >
        ${isFavorite ? "등록됨" : "관심"}
      </button>
    </article>
  `;
}

function renderFavorites() {
  el.favoriteCount.textContent = String(state.favorites.length);

  if (!state.favorites.length) {
    el.favoriteList.innerHTML = `<div class="empty-state">관심단지를 등록하면<br />비교표와 대시보드가 채워집니다.</div>`;
    return;
  }

  el.favoriteList.innerHTML = state.favorites
    .map((id) => COMPLEXES.find((complex) => complex.id === id))
    .filter(Boolean)
    .map((complex) => {
      const isSelected = state.selectedComplexId === complex.id;
      return `
        <article class="favorite-row ${isSelected ? "active" : ""}">
          <button type="button" data-favorite-select="${complex.id}" aria-label="${complex.name} 상세 보기">
            <div class="favorite-main">
              <strong>${complex.name}</strong>
              <p>${complex.dong} · ${formatHouseholdsAndBuildings(complex)}</p>
            </div>
          </button>
          <button class="ghost-button" type="button" data-favorite-remove="${complex.id}">해제</button>
        </article>
      `;
    })
    .join("");

  el.favoriteList.querySelectorAll("[data-favorite-select]").forEach((button) => {
    button.addEventListener("click", () => selectComplex(button.dataset.favoriteSelect));
  });

  el.favoriteList.querySelectorAll("[data-favorite-remove]").forEach((button) => {
    button.addEventListener("click", () => toggleFavorite(button.dataset.favoriteRemove));
  });
}

function renderMap() {
  el.mapCanvas.querySelectorAll(".map-marker").forEach((marker) => marker.remove());

  getFavoriteComplexes().forEach((complex) => {
    const marker = document.createElement("button");
    marker.className = [
      "map-marker",
      "favorite",
      state.selectedComplexId === complex.id ? "selected" : "",
    ]
      .filter(Boolean)
      .join(" ");
    marker.type = "button";
    marker.style.left = `${complex.mapX}%`;
    marker.style.top = `${complex.mapY}%`;
    marker.setAttribute("aria-label", `${complex.name} 지도 마커`);
    marker.innerHTML = `<span class="map-tooltip"><strong>${complex.name}</strong><br />${complex.dong} · ${formatHouseholdsAndBuildings(complex)}</span>`;
    marker.addEventListener("click", () => selectComplex(complex.id));
    el.mapCanvas.appendChild(marker);
  });

  syncKakaoMap();
}

function renderGlobalAreaTabs() {
  const ids = getAreaGroupsFromFavorites();
  el.globalAreaTabs.innerHTML = ids
    .map((id) => {
      const group = getAreaGroupMeta(id);
      const isActive = state.selectedAreaGroupId === id;
      return `
        <button
          class="area-tab ${isActive ? "active" : ""}"
          type="button"
          role="tab"
          aria-selected="${isActive}"
          data-global-area="${id}"
        >
          ${group.label}
        </button>
      `;
    })
    .join("");

  el.globalAreaTabs.querySelectorAll("[data-global-area]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedAreaGroupId = button.dataset.globalArea;
      renderGlobalAreaTabs();
      renderHeaderControls();
      renderDetail();
      renderComparison();
    });
  });
}

function renderDetail() {
  const complex = getSelectedComplex();
  if (!complex) {
    renderEmptyDetail();
    return;
  }

  const transactions = transactionsByComplex[complex.id] || [];
  const group = getAreaGroupMeta(state.selectedAreaGroupId);
  const areaGroupTransactions = transactions.filter((tx) => tx.areaGroupId === state.selectedAreaGroupId);
  const scopedTransactions = filterTransactionsBySelectedRange(
    areaGroupTransactions
  );
  const metrics = calculateMetrics(scopedTransactions);
  const hasTradeData = scopedTransactions.length > 0;

  el.selectedDong.textContent = complex.dong;
  el.detailTitle.innerHTML = `${complex.name}<br /><span class="gradient-text">${
    hasTradeData ? group.label : "실거래 매칭 전"
  }</span>`;
  el.selectedAddress.textContent = complex.address;
  el.includeLowFloorToggle.checked = state.includeLowFloorsInAnalysis;

  el.metaGrid.innerHTML = `
    <div class="meta-item"><span>세대수 / 동수</span><strong>${formatHouseholdsAndBuildings(complex)}</strong></div>
    <div class="meta-item"><span>준공년월</span><strong>${formatApprovalMonth(complex)}</strong></div>
    <div class="meta-item"><span>주차대수</span><strong>${formatParkingTotal(complex)}</strong></div>
    <div class="meta-item"><span>세대당 주차</span><strong>${formatParkingPerHousehold(complex)}</strong></div>
    <div class="meta-item"><span>용적률 / 건폐율</span><strong>${formatRatioPair(complex)}</strong></div>
    <div class="meta-item"><span>최근 거래수</span><strong>${scopedTransactions.length}건</strong></div>
  `;

  renderAreaTabs(complex.id);
  renderMetrics(metrics, scopedTransactions);
  renderPeriodAnalysis(areaGroupTransactions);
  renderChart(scopedTransactions);
  renderTransactions(scopedTransactions);
}

function renderEmptyDetail() {
  const range = getRangeMeta();
  const group = getAreaGroupMeta(state.selectedAreaGroupId);
  el.selectedDong.textContent = "대기 중";
  el.detailTitle.innerHTML = `단지를<br /><span class="gradient-text">검색하세요</span>`;
  el.selectedAddress.textContent = "검색 결과에서 관심단지를 등록하면 실거래 분석이 표시됩니다.";
  el.metaGrid.innerHTML = `<div class="empty-state detail-empty">아직 선택된 관심단지가 없습니다.</div>`;
  renderAreaTabs(null);
  el.metricGrid.innerHTML = `<div class="empty-state detail-empty">${range.label} · ${group.label} 기준으로 분석할 단지를 선택하세요.</div>`;
  el.includeLowFloorToggle.checked = state.includeLowFloorsInAnalysis;
  el.periodAnalysisWrap.innerHTML = `<div class="empty-state">단지를 선택하면 기간별 실거래 분석이 표시됩니다.</div>`;
  el.chartTitle.textContent = `${range.months}개월 가격 추이`;
  el.chartSubtitle.textContent = "단지를 선택하면 월별 중앙값 차트가 표시됩니다.";
  el.chartWrap.innerHTML = `<div class="empty-state">차트를 표시할 단지를 선택하세요.</div>`;
  el.transactionSubtitle.textContent = "단지 선택 전";
  el.transactionList.innerHTML = `<div class="empty-state">최근 거래 내역이 여기에 표시됩니다.</div>`;
}

function renderAreaTabs(complexId) {
  const transactions = complexId ? filterTransactionsBySelectedRange(transactionsByComplex[complexId] || []) : [];
  const counts = countBy(transactions, "areaGroupId");

  el.areaTabs.innerHTML = AREA_GROUPS
    .map((group) => {
      const id = group.id;
      const count = counts[id] || 0;
      const isActive = state.selectedAreaGroupId === id;
      return `
        <button
          class="area-tab ${isActive ? "active" : ""}"
          type="button"
          role="tab"
          aria-selected="${isActive}"
          data-area="${id}"
        >
          ${complexId ? `${group.label} · ${count}건` : group.label}
        </button>
      `;
    })
    .join("");

  el.areaTabs.querySelectorAll("[data-area]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedAreaGroupId = button.dataset.area;
      renderGlobalAreaTabs();
      renderHeaderControls();
      renderDetail();
      renderComparison();
    });
  });
}

function renderMetrics(metrics, scopedTransactions) {
  const dataQuality = scopedTransactions.length >= 12 ? "추세 참고 가능" : scopedTransactions.length >= 5 ? "거래수 보통" : "데이터 부족";
  const trendClass = metrics.changePercent >= 0 ? "trend-up" : "trend-down";
  const trendPrefix = metrics.changePercent >= 0 ? "+" : "";
  const range = getRangeMeta();

  el.metricGrid.innerHTML = `
    <div class="metric-card featured">
      <span>최근 실거래가</span>
      <strong>${metrics.latest ? formatEok(metrics.latest.priceEok) : "-"}</strong>
      <small>${metrics.latest ? `${metrics.latest.date} · 전용 ${metrics.latest.area.toFixed(2)}㎡ · ${metrics.latest.floor}층` : "거래 내역 없음"}</small>
    </div>
    <div class="metric-card">
      <span>최근 3개월 중앙값</span>
      <strong>${metrics.median3m ? formatEok(metrics.median3m) : "-"}</strong>
      <small>신고 지연 가능성을 감안해 중앙값으로 표시</small>
    </div>
    <div class="metric-card">
      <span>최근 6개월 중앙값</span>
      <strong>${metrics.median6m ? formatEok(metrics.median6m) : "-"}</strong>
      <small>월별 거래수 부족 시 함께 확인 필요</small>
    </div>
    <div class="metric-card">
      <span>전용면적 평당가</span>
      <strong>${metrics.latest ? `${formatNumber(metrics.latest.ppy)}만원` : "-"}</strong>
      <small>최근 실거래 기준, 전용면적 환산</small>
    </div>
    <div class="metric-card">
      <span>${range.months}개월 변화</span>
      <strong class="${trendClass}">${Number.isFinite(metrics.changePercent) ? `${trendPrefix}${metrics.changePercent.toFixed(1)}%` : "-"}</strong>
      <small>${dataQuality}</small>
    </div>
  `;
}

function renderPeriodAnalysis(areaGroupTransactions) {
  const group = getAreaGroupMeta(state.selectedAreaGroupId);
  const analysis = buildPeriodAnalysis(areaGroupTransactions, state.includeLowFloorsInAnalysis);
  const note = state.includeLowFloorsInAnalysis ? "평균가 기준" : "1~3층 거래 제외, 평균가 기준";

  if (!areaGroupTransactions.length) {
    el.periodAnalysisWrap.innerHTML = `
      <div class="empty-state">선택한 ${group.label} 실거래가 아직 없습니다.</div>
      <p class="period-note">${note}</p>
    `;
    return;
  }

  el.periodAnalysisWrap.innerHTML = `
    <div class="period-table" role="table" aria-label="${group.label} 기간별 실거래 분석">
      <div class="period-row header" role="row">
        <span role="columnheader">구분</span>
        ${analysis.periods.map((period) => `<span role="columnheader">${period.label}</span>`).join("")}
      </div>
      <div class="period-row" role="row">
        <span role="rowheader">세대당 평균가</span>
        ${analysis.periods.map((period) => `<strong>${period.avgPriceEok ? formatEok(period.avgPriceEok) : "-"}</strong>`).join("")}
      </div>
      <div class="period-row" role="row">
        <span role="rowheader">평당가</span>
        ${analysis.periods.map((period) => `<strong>${period.avgPpy ? `${formatNumber(period.avgPpy)}만/평` : "-"}</strong>`).join("")}
      </div>
      <div class="period-row" role="row">
        <span role="rowheader">거래수</span>
        ${analysis.periods.map((period) => `<strong>${period.count}건</strong>`).join("")}
      </div>
    </div>
    <p class="period-note">${note}</p>
  `;
}

function renderChart(scopedTransactions) {
  const monthly = buildMonthlyMedian(scopedTransactions);
  const values = monthly.map((item) => item.value).filter((value) => value !== null);
  const group = getAreaGroupMeta(state.selectedAreaGroupId);
  const range = getRangeMeta();
  el.chartTitle.textContent = `${range.months}개월 가격 추이`;
  el.chartSubtitle.textContent = scopedTransactions.length
    ? `${group.label} 월별 중앙값 · 거래 없는 달은 선 연결 제외`
    : "국토부 실거래 매칭 전";

  if (values.length < 2) {
    el.chartWrap.innerHTML = `<div class="empty-state">차트를 그리기에 거래 데이터가 부족합니다.</div>`;
    return;
  }

  const width = 680;
  const height = 280;
  const pad = { top: 24, right: 24, bottom: 54, left: 64 };
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const buffer = Math.max((rawMax - rawMin) * 0.12, rawMax * 0.025, 0.5);
  const min = Math.max(0, rawMin - buffer);
  const max = rawMax + buffer;
  const xStep = (width - pad.left - pad.right) / (monthly.length - 1);
  const yScale = (value) => {
    if (max === min) return height / 2;
    return pad.top + (1 - (value - min) / (max - min)) * (height - pad.top - pad.bottom);
  };
  const xTicks = buildChartXTicks(monthly, range.months);
  const yTicks = buildChartYTicks(min, max, 4);

  const points = monthly
    .map((item, index) => {
      if (item.value === null) return null;
      return {
        x: pad.left + index * xStep,
        y: yScale(item.value),
        item,
      };
    })
    .filter(Boolean);

  const polyline = points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");

  el.chartWrap.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${group.label} ${range.months}개월 실거래가 추이">
      <defs>
        <linearGradient id="lineGradient" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0%" stop-color="#0052FF" />
          <stop offset="100%" stop-color="#4D7CFF" />
        </linearGradient>
        <linearGradient id="areaGradient" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stop-color="#0052FF" stop-opacity="0.18" />
          <stop offset="100%" stop-color="#0052FF" stop-opacity="0" />
        </linearGradient>
      </defs>
      ${yTicks
        .map((tick) => {
          const y = yScale(tick);
          return `
            <line class="chart-grid-line" x1="${pad.left}" y1="${y.toFixed(1)}" x2="${width - pad.right}" y2="${y.toFixed(1)}" />
            <text class="chart-axis chart-axis-y" x="${pad.left - 10}" y="${(y + 4).toFixed(1)}">${formatEok(tick)}</text>
          `;
        })
        .join("")}
      ${xTicks
        .map((tick) => {
          const x = pad.left + tick.index * xStep;
          return `
            <line class="chart-grid-line vertical" x1="${x.toFixed(1)}" y1="${pad.top}" x2="${x.toFixed(1)}" y2="${height - pad.bottom}" />
            <text class="chart-axis chart-axis-x" x="${x.toFixed(1)}" y="${height - 18}">${formatMonthLabel(tick.month)}</text>
          `;
        })
        .join("")}
      <line class="chart-domain-line" x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${height - pad.bottom}" />
      <line class="chart-domain-line" x1="${pad.left}" y1="${height - pad.bottom}" x2="${width - pad.right}" y2="${height - pad.bottom}" />
      <polygon points="${pad.left},${height - pad.bottom} ${polyline} ${points[points.length - 1].x},${height - pad.bottom}" fill="url(#areaGradient)" />
      <polyline points="${polyline}" fill="none" stroke="url(#lineGradient)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" />
      ${points
        .map(
          (point) => `
            <circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="4.5" fill="#fff" stroke="#0052FF" stroke-width="2">
              <title>${point.item.month} · ${formatEok(point.item.value)}</title>
            </circle>
          `
        )
        .join("")}
    </svg>
  `;
}

function renderTransactions(scopedTransactions) {
  const group = getAreaGroupMeta(state.selectedAreaGroupId);
  el.transactionSubtitle.textContent = scopedTransactions.length
    ? `${group.label} 최근 거래 8건`
    : "국토부 실거래 매칭 전";

  const rows = scopedTransactions
    .slice()
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 8);

  if (!rows.length) {
    el.transactionList.innerHTML = `<div class="empty-state">선택한 면적 그룹의 거래가 없습니다.</div>`;
    return;
  }

  el.transactionList.innerHTML = rows
    .map(
      (tx) => `
        <article class="transaction-row">
          <div>
            <strong>${tx.date}</strong>
            <span>전용 ${tx.area.toFixed(2)}㎡ · ${tx.floor}층 · ${tx.month}</span>
          </div>
          <div class="transaction-price">
            <strong>${formatEok(tx.priceEok)}</strong>
            <span>${formatNumber(tx.ppy)}만원/평</span>
          </div>
        </article>
      `
    )
    .join("");
}

function renderComparison() {
  const favoriteComplexes = state.favorites.map((id) => COMPLEXES.find((complex) => complex.id === id)).filter(Boolean);
  const group = getAreaGroupMeta(state.selectedAreaGroupId);
  const range = getRangeMeta();

  if (!favoriteComplexes.length) {
    el.comparisonTable.innerHTML = `<div class="empty-state">관심단지를 등록하면 ${range.label} · ${group.label} 기준 비교표가 표시됩니다.</div>`;
    return;
  }

  const rows = favoriteComplexes.map((complex) => {
    const txs = filterTransactionsBySelectedRange(
      (transactionsByComplex[complex.id] || []).filter((tx) => tx.areaGroupId === state.selectedAreaGroupId)
    );
    const metrics = calculateMetrics(txs);
    return { complex, txs, metrics };
  });

  el.comparisonTable.innerHTML = `
    <div class="compare-row header">
      <span>단지</span>
      <span>최근가</span>
      <span>평당가</span>
      <span>거래수</span>
      <span>관리</span>
    </div>
    ${rows
      .map(({ complex, txs, metrics }) => {
        const isSelected = state.selectedComplexId === complex.id;
        return `
          <article class="compare-row ${isSelected ? "active" : ""}">
            <button class="compare-main ghost-reset" type="button" data-compare-select="${complex.id}">
              <span class="compare-name">
                <strong>${complex.name}</strong>
                <span>${complex.dong} · ${formatHouseholdsAndBuildings(complex)}</span>
              </span>
              <span class="compare-cell">
                <strong>${metrics.latest ? formatEok(metrics.latest.priceEok) : "-"}</strong>
                <small>${metrics.latest ? metrics.latest.date.slice(5) : complex.tradeStatus === "loading" ? "조회 중" : "거래 없음"}</small>
              </span>
              <span class="compare-cell">
                <strong>${metrics.latest ? `${formatNumber(metrics.latest.ppy)}만` : "-"}</strong>
                <small>전용 환산</small>
              </span>
              <span class="compare-cell">
                <strong>${txs.length}건</strong>
                <small>${txs.length >= 12 ? "충분" : txs.length >= 5 ? "보통" : txs.length ? "부족" : complex.tradeStatus === "loading" ? "조회 중" : "부족"}</small>
              </span>
            </button>
            <button class="compare-remove ghost-button" type="button" data-compare-remove="${complex.id}">해제</button>
          </article>
        `;
      })
      .join("")}
  `;

  el.comparisonTable.querySelectorAll("[data-compare-select]").forEach((button) => {
    button.addEventListener("click", () => selectComplex(button.dataset.compareSelect));
  });
  el.comparisonTable.querySelectorAll("[data-compare-remove]").forEach((button) => {
    button.addEventListener("click", () => toggleFavorite(button.dataset.compareRemove));
  });
}

function selectComplex(id) {
  if (!COMPLEXES.some((complex) => complex.id === id)) return;
  state.selectedComplexId = id;
  ensureValidAreaGroup();
  render();
}

function toggleFavorite(id) {
  const complex = COMPLEXES.find((item) => item.id === id);
  if (!complex) return;
  const wasSelected = state.selectedComplexId === id;
  const wasFavorite = state.favorites.includes(id);

  if (state.favorites.includes(id)) {
    state.favorites = state.favorites.filter((favoriteId) => favoriteId !== id);
  } else {
    state.favorites = [...state.favorites, id];
  }

  if (wasSelected && !state.favorites.includes(id)) {
    state.selectedComplexId = state.favorites[0] || null;
  } else if (!state.favorites.length && wasSelected) {
    state.selectedComplexId = null;
  } else if (!wasFavorite) {
    state.selectedComplexId = id;
  }

  saveFavorites();
  ensureValidAreaGroup();
  render();

  if (!wasFavorite && isUserRegisteredSource(complex?.source) && !transactionsByComplex[complex.id]?.length) {
    refreshRealTransactionsForComplex(complex.id);
  }
}

function ensureValidAreaGroup() {
  if (!AREA_GROUPS.some((group) => group.id === state.selectedAreaGroupId)) {
    state.selectedAreaGroupId = "84";
  }
  if (!RANGE_OPTIONS.some((option) => option.id === state.selectedMonthRange)) {
    state.selectedMonthRange = "24";
  }
}

function getSelectedComplex() {
  return COMPLEXES.find((complex) => complex.id === state.selectedComplexId) || null;
}

function getFavoriteComplexes() {
  return state.favorites.map((id) => COMPLEXES.find((complex) => complex.id === id)).filter(Boolean);
}

function isUserRegisteredSource(source) {
  return source === "kakao" || source === "aptlist";
}

function getAvailableAreaGroups(complexId) {
  const counts = countBy(transactionsByComplex[complexId] || [], "areaGroupId");
  return AREA_GROUPS.map((group) => group.id).filter((id) => counts[id] > 0);
}

function getAreaGroupsFromFavorites() {
  return AREA_GROUPS.map((group) => group.id);
}

function getAreaGroupMeta(id) {
  return AREA_GROUPS.find((group) => group.id === id) || AREA_GROUPS[0];
}

function getAreaGroupId(area) {
  const group = AREA_GROUPS.find((item) => area >= item.min && area < item.max);
  return group ? group.id : "etc";
}

function buildTransactions(complex) {
  const months = buildMonthRange(REFERENCE_MONTH, 24);
  const transactions = [];
  let runningId = 1;

  Object.entries(complex.bases).forEach(([groupId, basePrice], groupIndex) => {
    const group = getAreaGroupMeta(groupId);
    months.forEach((month, monthIndex) => {
      const cadence = groupId === "84" ? 2 : groupId === "59" ? 3 : 4;
      const shouldSkip = (monthIndex + complex.seed + groupIndex) % (cadence + 2) === 0;
      if (shouldSkip) return;

      const transactionCount = groupId === "84" && complex.households > 900 && monthIndex % 3 === 0 ? 2 : 1;

      for (let i = 0; i < transactionCount; i += 1) {
        const seasonal = Math.sin((monthIndex + complex.seed + i) / 2.4) * 0.026;
        const trend = complex.trend * (monthIndex / Math.max(1, months.length - 1));
        const floorPremium = ((monthIndex + i + complex.seed) % 18) * 0.0022;
        const noise = (((monthIndex + 1) * (complex.seed + groupIndex + 3 + i)) % 7) * 0.004;
        const priceEok = roundTo(basePrice * (1 + trend + seasonal + floorPremium + noise), 2);
        const area = roundTo(group.target + (((monthIndex + complex.seed + i) % 9) - 4) * 0.17, 2);
        const floor = 4 + ((monthIndex * 3 + complex.seed + i * 5) % 25);
        const day = String(4 + ((monthIndex * 5 + complex.seed + i * 9) % 23)).padStart(2, "0");

        transactions.push({
          id: `${complex.id}-${groupId}-${runningId}`,
          complexId: complex.id,
          month,
          date: `${month}-${day}`,
          area,
          areaGroupId: getAreaGroupId(area),
          floor,
          priceEok,
          ppy: Math.round((priceEok * 10000) / (area / 3.3058)),
        });
        runningId += 1;
      }
    });
  });

  return transactions.sort((a, b) => a.date.localeCompare(b.date));
}

function buildMonthRange(referenceMonth, count) {
  const [year, month] = referenceMonth.split("-").map(Number);
  const result = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const date = new Date(year, month - 1 - offset, 1);
    result.push(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`);
  }
  return result;
}

function buildMonthlyMedian(transactions) {
  const months = buildMonthRange(REFERENCE_MONTH, getRangeMeta().months);
  return months.map((month) => {
    const values = transactions.filter((tx) => tx.month === month).map((tx) => tx.priceEok);
    return {
      month,
      value: values.length ? median(values) : null,
    };
  });
}

function buildPeriodAnalysis(transactions, includeLowFloors) {
  const referenceDate = startOfDay(new Date());
  const recent3Start = addMonthsClamped(referenceDate, -3);
  const recent6Start = addMonthsClamped(referenceDate, -6);
  const previous6Start = addMonthsClamped(referenceDate, -12);
  const eligibleTransactions = transactions.filter((tx) => {
    if (!includeLowFloors && Number(tx.floor) > 0 && Number(tx.floor) <= 3) return false;
    return parseTransactionDate(tx.date) !== null;
  });

  const specs = [
    { id: "previous6", label: "이전 6개월", start: previous6Start, end: recent6Start, includeEnd: false },
    { id: "recent6", label: "최근 6개월", start: recent6Start, end: referenceDate, includeEnd: true },
    { id: "recent3", label: "최근 3개월", start: recent3Start, end: referenceDate, includeEnd: true },
  ];

  return {
    referenceDate,
    periods: specs.map((period) => {
      const rows = eligibleTransactions.filter((tx) => isTransactionInPeriod(tx, period));
      const avgPriceEok = average(rows.map((tx) => tx.priceEok).filter(Number.isFinite));
      const avgPpy = average(rows.map((tx) => getTransactionPpy(tx)).filter(Number.isFinite));
      return {
        ...period,
        count: rows.length,
        avgPriceEok: avgPriceEok === null ? null : roundTo(avgPriceEok, 2),
        avgPpy: avgPpy === null ? null : Math.round(avgPpy),
      };
    }),
  };
}

function isTransactionInPeriod(tx, period) {
  const date = parseTransactionDate(tx.date);
  if (!date) return false;
  const afterStart = date >= period.start;
  const beforeEnd = period.includeEnd ? date <= period.end : date < period.end;
  return afterStart && beforeEnd;
}

function parseTransactionDate(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [, year, month, day] = match.map(Number);
  const date = new Date(year, month - 1, day);
  return Number.isNaN(date.getTime()) ? null : startOfDay(date);
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addMonthsClamped(date, monthOffset) {
  const targetYear = date.getFullYear();
  const targetMonth = date.getMonth() + monthOffset;
  const targetLastDay = new Date(targetYear, targetMonth + 1, 0).getDate();
  return new Date(targetYear, targetMonth, Math.min(date.getDate(), targetLastDay));
}

function getTransactionPpy(tx) {
  if (Number.isFinite(tx.ppy)) return Number(tx.ppy);
  const areaPyung = Number(tx.area) / 3.3058;
  return areaPyung > 0 && Number.isFinite(tx.priceEok) ? (tx.priceEok * 10000) / areaPyung : NaN;
}

function buildChartXTicks(monthly, months) {
  const interval = months >= 24 ? 6 : months >= 12 ? 3 : months >= 6 ? 2 : 1;
  const ticks = monthly
    .map((item, index) => ({ month: item.month, index }))
    .filter((item) => item.index % interval === 0 || item.index === monthly.length - 1);
  const last = monthly[monthly.length - 1];
  if (last && !ticks.some((tick) => tick.index === monthly.length - 1)) {
    ticks.push({ month: last.month, index: monthly.length - 1 });
  }
  return ticks;
}

function buildChartYTicks(min, max, count) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || count < 2) return [];
  const step = (max - min) / (count - 1);
  return Array.from({ length: count }, (_, index) => roundTo(min + step * index, 1)).reverse();
}

function formatMonthLabel(month) {
  return month.slice(2).replace("-", ".");
}

function calculateMetrics(transactions) {
  const sorted = transactions.slice().sort((a, b) => b.date.localeCompare(a.date));
  const latest = sorted[0] || null;
  const last3 = filterLastMonths(transactions, 3).map((tx) => tx.priceEok);
  const last6 = filterLastMonths(transactions, 6).map((tx) => tx.priceEok);
  const monthly = buildMonthlyMedian(transactions).filter((item) => item.value !== null);
  const first = monthly[0]?.value;
  const last = monthly[monthly.length - 1]?.value;

  return {
    latest,
    median3m: last3.length ? median(last3) : null,
    median6m: last6.length ? median(last6) : null,
    changePercent: first && last ? ((last - first) / first) * 100 : NaN,
  };
}

function filterLastMonths(transactions, monthsBack) {
  const months = buildMonthRange(REFERENCE_MONTH, monthsBack);
  return transactions.filter((tx) => months.includes(tx.month));
}

function filterTransactionsBySelectedRange(transactions) {
  const months = buildMonthRange(REFERENCE_MONTH, getRangeMeta().months);
  return transactions.filter((tx) => months.includes(tx.month));
}

function getRangeMeta() {
  return RANGE_OPTIONS.find((option) => option.id === state.selectedMonthRange) || RANGE_OPTIONS[0];
}

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (!sorted.length) return null;
  if (sorted.length % 2) return sorted[middle];
  return roundTo((sorted[middle - 1] + sorted[middle]) / 2, 2);
}

function average(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function countBy(items, key) {
  return items.reduce((acc, item) => {
    acc[item[key]] = (acc[item[key]] || 0) + 1;
    return acc;
  }, {});
}

function formatEok(value) {
  if (!Number.isFinite(value)) return "-";
  return `${roundTo(value, 1).toLocaleString("ko-KR")}억`;
}

function formatNumber(value) {
  return Math.round(value).toLocaleString("ko-KR");
}

function formatHouseholds(value) {
  return Number(value) > 0 ? `${Number(value).toLocaleString("ko-KR")}세대` : "세대수 확인 필요";
}

function formatHouseholdsAndBuildings(complex) {
  const households = Number(complex.households) > 0
    ? `${Number(complex.households).toLocaleString("ko-KR")}세대`
    : "세대수 확인 필요";
  const buildings = Number(complex.buildingCount) > 0
    ? `${Number(complex.buildingCount).toLocaleString("ko-KR")}개동`
    : "동수 확인 필요";
  return `${households} · ${buildings}`;
}

function formatBuiltYear(value) {
  return Number(value) > 0 ? `${value}년식` : "준공연도 확인 필요";
}

function formatBuiltYearShort(value) {
  return Number(value) > 0 ? `${value}년` : "확인 필요";
}

function formatApprovalMonth(complex) {
  const text = String(complex.approvalDate || "").replace(/[^0-9]/g, "");
  if (text.length >= 6) {
    return `${text.slice(0, 4)}년 ${Number(text.slice(4, 6))}월`;
  }
  return Number(complex.builtYear) > 0 ? `${complex.builtYear}년` : "확인 필요";
}

function formatParkingTotal(complex) {
  if (!Number.isFinite(complex.parkingTotal)) return "확인 필요";
  return `${formatNumber(complex.parkingTotal)}대`;
}

function formatParkingPerHousehold(complex) {
  if (!Number.isFinite(complex.parkingPerHousehold)) return "확인 필요";
  return `${complex.parkingPerHousehold.toLocaleString("ko-KR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}대/세대`;
}

function formatRatioPair(complex) {
  const floorAreaRatio = Number.isFinite(complex.floorAreaRatio)
    ? `${roundTo(complex.floorAreaRatio, 1).toLocaleString("ko-KR")}%`
    : "용적률 확인 필요";
  const buildingCoverageRatio = Number.isFinite(complex.buildingCoverageRatio)
    ? `${roundTo(complex.buildingCoverageRatio, 1).toLocaleString("ko-KR")}%`
    : "건폐율 확인 필요";
  return `${floorAreaRatio} · ${buildingCoverageRatio}`;
}

function roundTo(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function parseNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const normalized = String(value).replace(/,/g, "").trim();
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function sumNullable(...values) {
  const numbers = values.filter((value) => Number.isFinite(value));
  return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) : null;
}

function getYearFromYmd(value) {
  const text = String(value || "").replace(/[^0-9]/g, "");
  return text.length >= 4 ? Number(text.slice(0, 4)) : null;
}

function normalize(value) {
  return value.toLowerCase().replace(/\s+/g, "");
}

function stringSimilarity(a, b) {
  if (!a || !b) return 0;
  const bigrams = (value) => {
    const chars = Array.from(value);
    if (chars.length < 2) return new Set(chars);
    return new Set(chars.slice(0, -1).map((char, index) => `${char}${chars[index + 1]}`));
  };
  const left = bigrams(a);
  const right = bigrams(b);
  const union = new Set([...left, ...right]);
  let intersection = 0;
  left.forEach((item) => {
    if (right.has(item)) intersection += 1;
  });
  return union.size ? intersection / union.size : 0;
}

function maskTail(value) {
  return value.length > 4 ? value.slice(-4) : "****";
}

function hashString(value) {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function loadCustomComplexes() {
  try {
    const saved = JSON.parse(localStorage.getItem(CUSTOM_COMPLEXES_KEY) || "[]");
    if (!Array.isArray(saved)) return [];
    return saved
      .filter((complex) => complex && complex.id && complex.name && complex.lat && complex.lng)
      .map((complex) => ({
        ...complex,
        bases: isUserRegisteredSource(complex.source) ? {} : complex.bases || {},
        legalDongFullCode: complex.legalDongFullCode || "",
        kaptCode: complex.kaptCode || "",
        kaptName: complex.kaptName || "",
        aptListCandidates: Array.isArray(complex.aptListCandidates) ? complex.aptListCandidates : [],
        buildingCount: parseNumber(complex.buildingCount),
        approvalDate: complex.approvalDate || "",
        parkingTotal: parseNumber(complex.parkingTotal),
        parkingGround: parseNumber(complex.parkingGround),
        parkingUnderground: parseNumber(complex.parkingUnderground),
        parkingPerHousehold: parseNumber(complex.parkingPerHousehold),
        buildingCoverageRatio: parseNumber(complex.buildingCoverageRatio),
        floorAreaRatio: parseNumber(complex.floorAreaRatio),
        landArea: parseNumber(complex.landArea),
        buildingArea: parseNumber(complex.buildingArea),
        grossFloorArea: parseNumber(complex.grossFloorArea),
        buildingLedgerStatus: complex.buildingLedgerStatus || "idle",
        buildingLedgerError: complex.buildingLedgerError || "",
        lastBuildingLedgerSync: complex.lastBuildingLedgerSync || "",
        lastBasisSync: complex.lastBasisSync || "",
        realTransactions: Array.isArray(complex.realTransactions) ? complex.realTransactions : [],
        tradeStatus:
          complex.tradeStatus ||
          (Array.isArray(complex.realTransactions) && complex.realTransactions.length ? "loaded" : "idle"),
        tradeMessage: complex.tradeMessage || "국토부 실거래 조회 전",
        tags:
          isUserRegisteredSource(complex.source)
            ? updateAptListTags(
                updateTradeTags(
                  complex.tags || [],
                  complex.tradeStatus ||
                    (Array.isArray(complex.realTransactions) && complex.realTransactions.length ? "loaded" : "idle")
                ),
                complex.kaptCode ? "matched" : Array.isArray(complex.aptListCandidates) && complex.aptListCandidates.length ? "candidates" : "idle"
              )
            : complex.tags || [],
      }));
  } catch {
    return [];
  }
}

function saveCustomComplexes() {
  const customComplexes = COMPLEXES.filter((complex) => isUserRegisteredSource(complex.source));
  localStorage.setItem(CUSTOM_COMPLEXES_KEY, JSON.stringify(customComplexes));
}

function loadApiConfig() {
  try {
    const raw = localStorage.getItem(API_CONFIG_KEY);
    if (raw === null) {
      return {
        endpoint: RTMS_API_ENDPOINT,
        serviceKey: "",
        kakaoJavaScriptKey: DEFAULT_KAKAO_JAVASCRIPT_KEY,
      };
    }

    const saved = JSON.parse(raw);
    return {
      endpoint: saved.endpoint || RTMS_API_ENDPOINT,
      serviceKey: typeof saved.serviceKey === "string" ? saved.serviceKey : "",
      kakaoJavaScriptKey:
        typeof saved.kakaoJavaScriptKey === "string"
          ? saved.kakaoJavaScriptKey
          : DEFAULT_KAKAO_JAVASCRIPT_KEY,
    };
  } catch {
    return {
      endpoint: RTMS_API_ENDPOINT,
      serviceKey: "",
      kakaoJavaScriptKey: DEFAULT_KAKAO_JAVASCRIPT_KEY,
    };
  }
}

function saveApiConfig() {
  localStorage.setItem(API_CONFIG_KEY, JSON.stringify(state.apiConfig));
}

function loadFavorites() {
  try {
    const saved = JSON.parse(localStorage.getItem(FAVORITES_KEY) || "[]");
    return Array.isArray(saved) ? saved.filter((id) => COMPLEXES.some((complex) => complex.id === id)) : [];
  } catch {
    return [];
  }
}

function saveFavorites() {
  localStorage.setItem(FAVORITES_KEY, JSON.stringify(state.favorites));
}
